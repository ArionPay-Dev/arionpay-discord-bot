// Runs the bot against a fake Discord API and a real ArionPay server (sandbox).
//   ARIONPAY_IT_BASE_URL=http://127.0.0.1:18090 ARIONPAY_IT_API_KEY=pk_... ARIONPAY_IT_API_SECRET=sk_... \
//   ARIONPAY_IT_WEBHOOK_SECRET=whsec_... npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, generateKeyPairSync, sign as edSign } from "node:crypto";
import { ArionPay } from "arionpay";

const env = process.env;
const skip = !env.ARIONPAY_IT_BASE_URL && "set ARIONPAY_IT_BASE_URL to run against a real server";
const BOT = new URL("../bot.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GUILD = "900000000000000001", ROLE = "900000000000000002", SALES = "900000000000000003", APP = "900000000000000004";

/** A tiny Discord REST API: records commands, DMs, role grants, message edits. A user id ending in 9 refuses DMs. */
function fakeDiscord(port) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const path = req.url.replace(/^\/api\/v10/, "");
      calls.push({ method: req.method, path, body, auth: req.headers.authorization ?? "" });
      const json = (status, b) => res.writeHead(status, { "content-type": "application/json" }).end(b === undefined ? "" : JSON.stringify(b));
      if (req.method === "POST" && path === "/users/@me/channels") return json(200, { id: `dm-${body.recipient_id}` });
      if (req.method === "POST" && /^\/channels\/dm-\d*9\/messages$/.test(path)) return json(403, { message: "Cannot send messages to this user", code: 50007 });
      if (req.method === "PUT" && /\/roles\//.test(path)) return res.writeHead(204).end();
      return json(200, { id: "1" });
    });
  }).listen(port, "127.0.0.1");
  return { server, calls };
}

async function waitFor(fn, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error("timed out");
}

async function run(t, { webhooks }) {
  const dcPort = webhooks ? 18430 : 18440;
  const botPort = dcPort + 1;
  const fake = fakeDiscord(dcPort);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "arionpay-discord-"));
  writeFileSync(join(dir, "products.json"), JSON.stringify([
    { id: "vip", name: "VIP role", price: "15", currency: "USD", role_id: ROLE, deliver: "WELCOME-TO-VIP" },
    { id: "guide", name: "Guide", price: "9.90", currency: "USD", deliver: "SECRET-GUIDE-LINK" },
  ]));
  const child = spawn(process.execPath, [BOT], {
    cwd: dir,
    env: {
      ...process.env,
      ENV_FILE: "/nonexistent",
      DISCORD_APPLICATION_ID: APP,
      DISCORD_PUBLIC_KEY: pubHex,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_GUILD_ID: GUILD,
      SALES_CHANNEL_ID: SALES,
      DISCORD_API_URL: `http://127.0.0.1:${dcPort}/api/v10`,
      ARIONPAY_API_KEY: env.ARIONPAY_IT_API_KEY,
      ARIONPAY_API_SECRET: env.ARIONPAY_IT_API_SECRET,
      ARIONPAY_WEBHOOK_SECRET: env.ARIONPAY_IT_WEBHOOK_SECRET,
      ARIONPAY_BASE_URL: env.ARIONPAY_IT_BASE_URL,
      ARIONPAY_TEST_MODE: "true",
      // without webhooks: ArionPay's updates go to a closed port, so only the backup check can deliver
      PUBLIC_URL: webhooks ? `http://127.0.0.1:${botPort}` : "http://127.0.0.1:9",
      PORT: String(botPort),
      HOST: "127.0.0.1",
      POLL_SECONDS: webhooks ? "0" : "2",
      NODE_PATH: new URL("../node_modules", import.meta.url).pathname,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const ap = new ArionPay({ apiKey: env.ARIONPAY_IT_API_KEY, apiSecret: env.ARIONPAY_IT_API_SECRET, baseUrl: env.ARIONPAY_IT_BASE_URL });
  const BOT_URL = `http://127.0.0.1:${botPort}`;
  let n = 0;
  async function interact(body, { badSig = false } = {}) {
    const raw = JSON.stringify({ id: `9${Date.now()}${++n}`, application_id: APP, token: `tok${n}`, version: 1, ...body });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = badSig ? "0".repeat(128) : edSign(null, Buffer.from(ts + raw), privateKey).toString("hex");
    const r = await fetch(`${BOT_URL}/discord/interactions`, { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": sig, "x-signature-timestamp": ts }, body: raw });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null, token: `tok${n}`, raw };
  }
  const member = (id) => ({ guild_id: GUILD, member: { user: { id, username: "m" } } });
  async function buy(userId, productId) {
    const r = await interact({ type: 3, ...member(userId), data: { custom_id: `buy:${productId}`, component_type: 2 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { type: 5, data: { flags: 64 } }, "answers 'thinking', privately");
    const edit = await waitFor(() => fake.calls.find((c) => c.method === "PATCH" && c.path === `/webhooks/${APP}/${r.token}/messages/@original` && c.body?.components?.length));
    const url = edit.body.components[0].components[0].url;
    assert.match(url, /\/pay\/[0-9a-f]{24}$/);
    return { invoiceId: url.split("/").pop(), token: r.token, edit };
  }
  async function pay(id, scenario) {
    await fetch(`${env.ARIONPAY_IT_BASE_URL}/api/public/invoice/${id}/asset`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset: "USDT_TRC20" }) });
    await ap.simulatePayment(id, scenario);
  }
  const dms = (userId) => fake.calls.filter((c) => c.method === "POST" && c.path === `/channels/dm-${userId}/messages`);
  const roleGrants = (userId) => fake.calls.filter((c) => c.method === "PUT" && c.path === `/guilds/${GUILD}/members/${userId}/roles/${ROLE}`);

  try {
    await waitFor(() => log.includes("running"));
    await t.test("registers /shop and /buy in the server, with the bot token", async () => {
      const reg = await waitFor(() => fake.calls.find((c) => c.method === "PUT" && c.path === `/applications/${APP}/guilds/${GUILD}/commands`));
      assert.equal(reg.auth, "Bot test-token");
      assert.deepEqual(reg.body.map((c) => c.name), ["shop", "buy"]);
      assert.deepEqual(reg.body[1].options[0].choices.map((c) => c.value), ["vip", "guide"]);
    });
    await t.test("Discord's checks: PING answered, bad or missing signature refused", async () => {
      assert.deepEqual((await interact({ type: 1 })).json, { type: 1 });
      assert.equal((await interact({ type: 1 }, { badSig: true })).status, 401);
      const r = await fetch(`${BOT_URL}/discord/interactions`, { method: "POST", body: '{"type":1}' });
      assert.equal(r.status, 401);
    });
    await t.test("/shop shows the items as buttons, privately, with the test-mode line", async () => {
      const r = await interact({ type: 2, ...member("111"), data: { name: "shop" } });
      assert.equal(r.json.type, 4);
      assert.equal(r.json.data.flags, 64);
      assert.match(r.json.data.content, /Test mode/);
      assert.deepEqual(r.json.data.components[0].components.map((b) => b.custom_id), ["buy:vip", "buy:guide"]);
    });

    await t.test("buy VIP, pay exactly: role given, DM with the item, sale posted, nothing before payment", async () => {
      const { invoiceId } = await buy("111", "vip");
      const inv = await ap.getInvoice(invoiceId);
      assert.equal(inv.amountFiat, 15);
      assert.equal(inv.test, true);
      assert.equal(inv.metadata.discord_user_id, "111");
      assert.equal(roleGrants("111").length, 0, "no role before payment");
      await pay(invoiceId, "exact");
      await waitFor(() => roleGrants("111").length === 1 && dms("111").some((m) => /WELCOME-TO-VIP/.test(m.body.content)), 60000);
      assert.equal(roleGrants("111")[0].auth, "Bot test-token");
      await waitFor(() => fake.calls.some((c) => c.path === `/channels/${SALES}/messages` && /Sold \*\*VIP role\*\* to <@111>/.test(c.body.content) && /Delivered/.test(c.body.content)));
      if (webhooks) {
        const hook = `${BOT_URL}/arionpay/webhook`;
        const signed = (raw, secret) => { const ts = Math.floor(Date.now() / 1000); return { "ArionPay-Signature": `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}` }; };
        const paid = await ap.getInvoice(invoiceId);
        let raw = JSON.stringify({ id: "evt_again_" + invoiceId, type: "invoice.paid", data: { invoice: { ...paid, status: "paid" } } });
        let r = await fetch(hook, { method: "POST", body: raw, headers: signed(raw, env.ARIONPAY_IT_WEBHOOK_SECRET) });
        assert.equal(r.status, 200);
        await sleep(500);
        assert.equal(roleGrants("111").length, 1, "the same payment again: no second role grant");
        assert.equal(dms("111").filter((m) => /WELCOME-TO-VIP/.test(m.body.content)).length, 1, "no second DM");
        r = await fetch(hook, { method: "POST", body: raw, headers: signed(raw, "whsec_wrong") });
        assert.equal(r.status, 401, "forged webhook refused");
        raw = JSON.stringify({ id: "evt_live_" + invoiceId, type: "invoice.paid", data: { invoice: { ...paid, test: false } } });
        r = await fetch(hook, { method: "POST", body: raw, headers: signed(raw, env.ARIONPAY_IT_WEBHOOK_SECRET) });
        assert.equal(r.status, 409, "a live invoice is refused while the bot is in test mode");
        raw = JSON.stringify({ id: "evt_test_x", type: "invoice.paid", data: { invoice: { ...paid, id: "inv_test_1" } } });
        r = await fetch(hook, { method: "POST", body: raw, headers: signed(raw, env.ARIONPAY_IT_WEBHOOK_SECRET) });
        assert.match(await r.text(), /test_event/);
      }
    });

    await t.test("5% underpayment (Payment Radar): nothing delivered", async () => {
      const { invoiceId } = await buy("222", "guide");
      await pay(invoiceId, "underpaid_5pct");
      await sleep(webhooks ? 4000 : 6000);
      assert.equal(dms("222").filter((m) => /SECRET-GUIDE-LINK/.test(m.body.content)).length, 0);
    });

    await t.test("late payment: delivered", async () => {
      const { invoiceId } = await buy("333", "guide");
      await pay(invoiceId, "late");
      await waitFor(() => dms("333").some((m) => /SECRET-GUIDE-LINK/.test(m.body.content)), 60000);
    });

    await t.test("member who refuses DMs: the item is shown in their private pay message instead", async () => {
      const { invoiceId, token } = await buy("4449", "guide");
      await pay(invoiceId, "exact");
      await waitFor(() => fake.calls.some((c) => c.method === "PATCH" && c.path === `/webhooks/${APP}/${token}/messages/@original` && /SECRET-GUIDE-LINK/.test(c.body.content ?? "")), 60000);
    });

    if (webhooks) {
      await t.test("the same button press sent twice makes one invoice", async () => {
        const body = { type: 3, ...member("555"), data: { custom_id: "buy:guide", component_type: 2 } };
        const raw = JSON.stringify({ id: "777000111", application_id: APP, token: "tokdup", version: 1, ...body });
        for (let k = 0; k < 2; k++) {
          const ts = String(Math.floor(Date.now() / 1000));
          await fetch(`${BOT_URL}/discord/interactions`, { method: "POST", headers: { "x-signature-ed25519": edSign(null, Buffer.from(ts + raw), privateKey).toString("hex"), "x-signature-timestamp": ts }, body: raw });
        }
        await sleep(2500);
        const urls = new Set(fake.calls.filter((c) => c.method === "PATCH" && c.path.includes("/tokdup/")).map((c) => c.body.components?.[0]?.components?.[0]?.url).filter(Boolean));
        assert.equal(urls.size, 1);
      });
    }
  } finally {
    child.kill();
    fake.server.close();
    if (process.env.SHOW_BOT_LOG) console.log(log);
  }
}

test("with ArionPay webhooks", { skip, timeout: 240000 }, (t) => run(t, { webhooks: true }));
test("webhooks lost: the backup check delivers", { skip, timeout: 240000 }, (t) => run(t, { webhooks: false }));
