#!/usr/bin/env node
// ArionPay Discord shop bot: sell roles (VIP, member access) and digital items in a Discord server, paid in crypto
// straight to your own wallet.
//
//   cp .env.example .env    (fill it in)      node bot.mjs
//
// Members use /shop (or /buy), press a button and pay on the ArionPay page. When ArionPay confirms the payment, the
// bot gives the role ("role_id" in products.json) and sends the item ("deliver") by direct message.
// Discord talks to the bot over HTTPS (Interactions Endpoint URL, signed with Ed25519), so no extra library and no
// always-open connection is needed. Payment updates arrive by signed ArionPay webhook; open orders are also
// re-checked every POLL_SECONDS in case an update was missed.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import { ArionPay, ArionPaySignatureError, isTestEvent } from "arionpay";

// ------------------------------------------------------------------ settings
function loadEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(process.env.ENV_FILE ?? ".env");
const env = process.env;
const need = (k) => {
  if (!env[k]) {
    console.error(`Missing ${k} (see .env.example)`);
    process.exit(1);
  }
  return env[k];
};
const APP_ID = need("DISCORD_APPLICATION_ID");
const PUBLIC_KEY_HEX = need("DISCORD_PUBLIC_KEY");
const BOT_TOKEN = need("DISCORD_BOT_TOKEN");
const GUILD_ID = env.DISCORD_GUILD_ID ?? "";
const SALES_CHANNEL_ID = env.SALES_CHANNEL_ID ?? "";
const DISCORD_API = (env.DISCORD_API_URL ?? "https://discord.com/api/v10").replace(/\/+$/, "");
const PUBLIC_URL = need("PUBLIC_URL").replace(/\/+$/, "");
const TEST_MODE = (env.ARIONPAY_TEST_MODE ?? "true") !== "false";
const PORT = Number(env.PORT ?? 8080);
const DATA_FILE = env.DATA_FILE ?? "orders.json";
const PRODUCTS = JSON.parse(readFileSync(env.PRODUCTS_FILE ?? "products.json", "utf8"));
const POLL_MS = Number(env.POLL_SECONDS ?? 300) * 1000;
const arionpay = new ArionPay({
  apiKey: need("ARIONPAY_API_KEY"),
  apiSecret: need("ARIONPAY_API_SECRET"),
  webhookSecret: need("ARIONPAY_WEBHOOK_SECRET"),
  baseUrl: env.ARIONPAY_BASE_URL || undefined,
  appInfo: "arionpay-discord-bot/1.0.0",
});
for (const p of PRODUCTS) {
  if (!p.id || !p.name || !p.price || !p.currency || (!p.deliver && !p.role_id)) {
    console.error(`products.json: every item needs id, name, price, currency and "deliver" and/or "role_id" (${JSON.stringify(p)})`);
    process.exit(1);
  }
  if (p.role_id && !GUILD_ID) {
    console.error(`products.json: "${p.id}" gives a role, so DISCORD_GUILD_ID (your server id) is needed.`);
    process.exit(1);
  }
}
if (PRODUCTS.length > 25) {
  console.error("products.json: at most 25 items (Discord shows 25 buttons and 25 choices).");
  process.exit(1);
}
const PUBLIC_KEY = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(PUBLIC_KEY_HEX, "hex").toString("base64url") }, format: "jwk" });

// ------------------------------------------------------------------ orders (a small JSON file)
/** @type {{ orders: Record<string, any>, events: string[] }} */
const db = existsSync(DATA_FILE) ? JSON.parse(readFileSync(DATA_FILE, "utf8")) : { orders: {}, events: [] };
function save() {
  writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db, null, 2));
  renameSync(DATA_FILE + ".tmp", DATA_FILE);
}

// ------------------------------------------------------------------ Discord REST
async function discord(method, path, body, { auth = true, reason } = {}) {
  for (let attempt = 1; ; attempt++) {
    const headers = { "content-type": "application/json", "user-agent": "DiscordBot (https://arionpay.com, 1.0.0)" };
    if (auth) headers.authorization = `Bot ${BOT_TOKEN}`;
    if (reason) headers["x-audit-log-reason"] = encodeURIComponent(reason);
    const r = await fetch(`${DISCORD_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    const json = text ? JSON.parse(text) : {};
    if (r.status === 429 && attempt < 3) {
      await new Promise((ok) => setTimeout(ok, Math.min(10, Number(json.retry_after ?? 1)) * 1000));
      continue;
    }
    if (!r.ok) {
      const err = new Error(`Discord ${method} ${path}: ${r.status} ${json.message ?? text}`);
      err.status = r.status;
      err.code = json.code;
      throw err;
    }
    return json;
  }
}
const money = (p) => `${p.price} ${p.currency}`;
const product = (id) => PRODUCTS.find((x) => x.id === id);

async function registerCommands() {
  const commands = [
    { name: "shop", description: "See what you can buy with crypto", type: 1 },
    {
      name: "buy",
      description: "Buy an item with crypto",
      type: 1,
      options: [{ name: "item", description: "What to buy", type: 3, required: true, choices: PRODUCTS.map((p) => ({ name: `${p.name} (${money(p)})`.slice(0, 100), value: p.id })) }],
    },
  ];
  const path = GUILD_ID ? `/applications/${APP_ID}/guilds/${GUILD_ID}/commands` : `/applications/${APP_ID}/commands`;
  await discord("PUT", path, commands);
}

/** Send a direct message. Returns false when the member does not accept DMs from this server. */
async function dm(userId, content, components) {
  try {
    const channel = await discord("POST", "/users/@me/channels", { recipient_id: userId });
    await discord("POST", `/channels/${channel.id}/messages`, { content, components, allowed_mentions: { parse: [] } });
    return true;
  } catch (e) {
    console.error(`DM to ${userId} failed: ${e.message}`);
    return false;
  }
}
const sales = (content) =>
  SALES_CHANNEL_ID ? discord("POST", `/channels/${SALES_CHANNEL_ID}/messages`, { content, allowed_mentions: { parse: [] } }).catch((e) => console.error(e.message)) : null;
/** Edit the member's private "pay" message (works for 15 minutes after they pressed the button). */
const editPayMessage = (o, content, components = []) =>
  Date.now() - o.created < 14 * 60_000
    ? discord("PATCH", `/webhooks/${APP_ID}/${o.interactionToken}/messages/@original`, { content, components }, { auth: false }).then(() => true, () => false)
    : Promise.resolve(false);

// ------------------------------------------------------------------ buying
function catalogMessage() {
  const rows = [];
  for (let i = 0; i < PRODUCTS.length; i += 5) {
    rows.push({ type: 1, components: PRODUCTS.slice(i, i + 5).map((p) => ({ type: 2, style: 1, custom_id: `buy:${p.id}`, label: `${p.name} · ${money(p)}`.slice(0, 80) })) });
  }
  return {
    content: `${env.SHOP_WELCOME ?? "Choose what you want to buy. You pay with Bitcoin, USDT and more."}${TEST_MODE ? "\n*(Test mode: no real money is taken.)*" : ""}`,
    components: rows,
    flags: 64,
  };
}

/** Runs after Discord got the "thinking..." answer: make the invoice and show the pay button. */
async function startPurchase(interaction, productId) {
  const p = product(productId);
  const user = interaction.member?.user ?? interaction.user;
  const o0 = { interactionToken: interaction.token, created: Date.now() };
  if (!p) return editPayMessage(o0, "Sorry, that item is not available any more. Use /shop to see the list.");
  if (p.role_id && interaction.guild_id !== GUILD_ID) return editPayMessage(o0, "Please buy this in our server: it gives you a role there.");
  const orderId = `dc-${randomBytes(6).toString("hex")}`;
  try {
    const invoice = await arionpay.createInvoice({
      amount: String(p.price),
      currency: p.currency,
      orderId,
      description: p.name,
      callbackUrl: `${PUBLIC_URL}/arionpay/webhook`,
      metadata: { discord_user_id: user.id, discord_guild_id: interaction.guild_id ?? null, product_id: p.id, platform: "discord-bot" },
      idempotencyKey: `dc-${interaction.id}`, // the same button press (a resent interaction) never makes a second invoice
      test: TEST_MODE,
    });
    if (!db.orders[invoice.id]) {
      db.orders[invoice.id] = {
        orderId: invoice.orderId ?? orderId,
        userId: user.id,
        guildId: interaction.guild_id ?? null,
        productId: p.id,
        price: String(p.price),
        currency: p.currency,
        status: "new",
        delivered: false,
        created: Date.now(),
        interactionToken: interaction.token,
      };
      save();
    }
    await editPayMessage(db.orders[invoice.id], `**${p.name}**: ${money(p)}\nPress the button to pay with crypto. The link works for a limited time.${TEST_MODE ? "\n*(Test mode: no real money is taken.)*" : ""}`, [
      { type: 1, components: [{ type: 2, style: 5, label: `Pay ${money(p)}`, url: invoice.invoiceUrl }] },
    ]);
  } catch (e) {
    console.error("createInvoice failed:", e.message);
    await editPayMessage(o0, "The payment could not be started right now. Please try again in a minute.");
  }
}

// ------------------------------------------------------------------ payment updates (webhook and backup polling)
/**
 * @param {string} invoiceId
 * @param {string} type invoice.pending | invoice.partial | invoice.paid | invoice.expired | invoice.needs_review
 * @param {any} invoice the verified invoice (webhook data.invoice or getInvoice())
 */
async function onUpdate(invoiceId, type, invoice) {
  const o = db.orders[invoiceId];
  if (!o) return "unknown";
  if (Boolean(invoice.test) !== TEST_MODE) return "mode_mismatch"; // a test invoice never delivers in live mode, nor a live one in test mode
  if (type === "invoice.paid") {
    if (o.delivered) return "duplicate";
    const p = product(o.productId);
    const same = Number(invoice.amountFiat).toFixed(2) === Number(o.price).toFixed(2) && String(invoice.currency).toUpperCase() === o.currency.toUpperCase();
    // Claim the order before any await, so a webhook and the backup check can never deliver twice.
    o.delivered = true;
    o.paidAt = Date.now();
    if (!p || !same) {
      o.status = "check_by_hand";
      save();
      await dm(o.userId, "Your payment arrived, but something does not match the order. The seller will check it and contact you.");
      await sales(`Payment for order ${o.orderId} (<@${o.userId}>) does not match the order: check it in ArionPay (invoice ${invoiceId}).`);
      return "mismatch";
    }
    o.status = "paid";
    save();
    const problems = [];
    if (p.role_id) {
      try {
        await discord("PUT", `/guilds/${o.guildId}/members/${o.userId}/roles/${p.role_id}`, undefined, { reason: `ArionPay order ${o.orderId}` });
        o.roleGiven = true;
      } catch (e) {
        problems.push(`role not given (${e.status ?? ""} ${e.message})`);
      }
    }
    const text = `Payment received, thank you!${invoice.test ? " *(test)*" : ""}\n\n**${p.name}**${p.role_id && o.roleGiven ? "\nYour new role is active in the server." : ""}${p.deliver ? `\n${p.deliver}` : ""}${problems.length ? "\nThe seller will finish your order by hand shortly." : ""}`;
    o.dmSent = await dm(o.userId, text);
    if (!o.dmSent) o.dmSent = await editPayMessage(o, text); // DMs closed: show it in their private pay message instead
    if (!o.dmSent && p.deliver) problems.push("item not sent: the member does not accept direct messages");
    if (problems.length) o.status = "check_by_hand";
    o.problems = problems;
    save();
    await sales(`Sold **${p.name}** to <@${o.userId}> for ${money(p)}${invoice.test ? " (test)" : ""}. ${problems.length ? `Needs your help: ${problems.join("; ")}.` : "Delivered."}`);
    return problems.length ? "delivered_with_problems" : "delivered";
  }
  if (o.delivered) return "ignored";
  if (type === "invoice.pending" && o.status !== "pending") {
    o.status = "pending";
    save();
    await dm(o.userId, "We see your payment on the network. It is waiting for confirmations; you will get your order as soon as it is confirmed.");
  } else if (type === "invoice.expired" && o.status !== "expired") {
    o.status = "expired";
    save();
    await dm(o.userId, "The payment time ran out. If you already paid, wait: a late payment is still detected. Otherwise use /shop to try again.");
  }
  return "ok";
}

// ------------------------------------------------------------------ HTTP server: Discord interactions + ArionPay webhooks
function readBody(req, max = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

function discordSignatureOk(req, raw) {
  const sig = String(req.headers["x-signature-ed25519"] ?? "");
  const ts = String(req.headers["x-signature-timestamp"] ?? "");
  if (!/^[0-9a-f]{128}$/i.test(sig) || !ts) return false;
  try {
    return edVerify(null, Buffer.concat([Buffer.from(ts, "utf8"), raw]), PUBLIC_KEY, Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

async function onInteraction(req, res) {
  const raw = await readBody(req, 65536);
  if (!discordSignatureOk(req, raw)) return send(res, 401, { error: "invalid request signature" });
  const i = JSON.parse(raw.toString("utf8"));
  if (i.type === 1) return send(res, 200, { type: 1 }); // PING
  if (i.type === 2 && i.data?.name === "shop") return send(res, 200, { type: 4, data: catalogMessage() });
  const productId = i.type === 2 && i.data?.name === "buy" ? i.data.options?.find((o) => o.name === "item")?.value : i.type === 3 && String(i.data?.custom_id ?? "").startsWith("buy:") ? i.data.custom_id.slice(4) : null;
  if (productId) {
    send(res, 200, { type: 5, data: { flags: 64 } }); // "thinking...", private to the member; the invoice follows
    void startPurchase(i, String(productId)).catch((e) => console.error(e));
    return;
  }
  return send(res, 200, { type: 4, data: { content: "Use /shop to see what you can buy.", flags: 64 } });
}

async function onArionPayWebhook(req, res) {
  const raw = await readBody(req);
  let event;
  try {
    event = arionpay.verifyWebhook(raw, req.headers["arionpay-signature"]);
  } catch (e) {
    if (!(e instanceof ArionPaySignatureError)) console.error(e);
    return send(res, 401, { error: "invalid_signature" });
  }
  if (isTestEvent(event)) return send(res, 200, { received: true, test_event: true });
  if (db.events.includes(event.id)) return send(res, 200, { received: true, duplicate: true });
  const inv = event.data.invoice;
  const o = db.orders[inv.id];
  if (o && (String(inv.metadata?.discord_user_id) !== String(o.userId) || inv.orderId !== o.orderId)) return send(res, 409, { error: "invoice_order_mismatch" });
  const result = await onUpdate(inv.id, event.type, inv).catch((e) => (console.error(e), "error"));
  if (result === "error") return res.writeHead(503).end();
  if (result === "mode_mismatch") return send(res, 409, { error: "test_live_mismatch" });
  db.events = [...db.events.slice(-500), event.id];
  save();
  send(res, 200, { received: true, result });
}

const server = createServer((req, res) => {
  const route = `${req.method} ${req.url}`;
  const handle =
    route === "POST /discord/interactions" ? onInteraction(req, res) : route === "POST /arionpay/webhook" ? onArionPayWebhook(req, res) : route === "GET /health" ? (res.writeHead(200).end("ok"), null) : (res.writeHead(404).end(), null);
  handle?.catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(400).end();
  });
});

// ------------------------------------------------------------------ backup check of open orders
async function pollOpenOrders() {
  const open = Object.entries(db.orders).filter(([, o]) => !o.delivered && Date.now() - o.created < 3 * 86400_000);
  for (const [invoiceId, o] of open) {
    try {
      const inv = await arionpay.getInvoice(invoiceId);
      const type = inv.status === "paid" ? "invoice.paid" : inv.status === "pending" ? "invoice.pending" : inv.status === "expired" ? "invoice.expired" : null;
      if (type && (type === "invoice.paid" || o.status !== inv.status)) await onUpdate(invoiceId, type, inv);
    } catch (e) {
      console.error(`check ${invoiceId}:`, e.message);
    }
  }
}

server.listen(PORT, env.HOST ?? "0.0.0.0", async () => {
  try {
    await registerCommands();
  } catch (e) {
    console.error("Could not register the /shop and /buy commands:", e.message);
  }
  console.log(`ArionPay Discord bot running (${TEST_MODE ? "TEST mode" : "live"}). Interactions Endpoint URL: ${PUBLIC_URL}/discord/interactions`);
});
if (POLL_MS > 0) setInterval(() => void pollOpenOrders(), POLL_MS);
