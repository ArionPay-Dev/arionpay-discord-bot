# ArionPay Discord shop bot

Sell roles (VIP, member access) and digital items in your Discord server, and get paid in Bitcoin, USDT, Litecoin, Ethereum, TRON and more through [ArionPay](https://arionpay.com). The money goes straight to your own wallet.

- Members use `/shop` (or `/buy`), press a button and pay on the secure ArionPay page. Everything they see is private to them.
- When ArionPay confirms the payment, the bot gives the role and sends the item by direct message. Each order is delivered once.
- Optional: every sale is posted in a channel for you and your moderators.
- One file, Node.js 18 or newer, no Discord library: Discord sends commands to the bot over HTTPS, signed, so the bot needs a public `https` address.

Tested against a real ArionPay server and a stand-in Discord API, with and without ArionPay webhooks. The tests covered:

- the commands are registered;
- Discord's signature checks;
- the shop;
- buying, the role and the DM;
- the sale notice;
- a payment that is the same, forged, of the wrong mode or a test event;
- Payment Radar and late payments;
- members who refuse DMs;
- a doubled button press.

## Set up (20 minutes)

1. **Discord app**: open the [Discord Developer Portal](https://discord.com/developers/applications), **New Application**.
   - *General Information*: copy the **Application ID** and **Public Key**.
   - *Bot*: **Reset Token** and copy it.
2. **Invite the bot** to your server: *OAuth2 > URL Generator*, tick `bot` and `applications.commands`, and under bot permissions tick **Manage Roles**. Open the link and choose your server.
   - In *Server Settings > Roles*, drag the bot's role **above** the roles it sells. Discord only lets a bot give roles below its own.
3. **ArionPay**: in your dashboard open your store and copy the **API key** (`pk_...`) and **API secret** (`sk_...`), and from **Webhooks** the **signing secret** (`whsec_...`).
4. **Install** on a server with a public `https` address (for example behind nginx or Caddy):

   ```bash
   git clone <this repository> arionpay-discord-bot && cd arionpay-discord-bot
   npm install
   cp .env.example .env      # paste the ids, token and keys; PUBLIC_URL = your https address
   ```

5. **Products** in `products.json`. Each item gives a role (`role_id`), sends a text (`deliver`), or both:

   ```json
   [
     { "id": "vip", "name": "VIP role", "price": "15", "currency": "USD", "role_id": "123456789012345678", "deliver": "Welcome to VIP! Check the #vip channel." },
     { "id": "guide", "name": "Trading guide (PDF)", "price": "9.90", "currency": "USD", "deliver": "Download: https://example.com/files/guide.pdf" }
   ]
   ```

   Role ids: turn on *Developer Mode* in Discord settings, then right-click the role > **Copy Role ID**. Set `DISCORD_GUILD_ID` to your server id (right-click the server > **Copy Server ID**).
6. Start it: `npm start`. Then in the Developer Portal, *General Information*, set **Interactions Endpoint URL** to `https://your-address/discord/interactions` and save. Discord checks the address right away; it saves only if the bot is running.
7. In your server type `/shop` and buy something. In test mode, finish the payment with the test buttons on the ArionPay page; no real money moves.
8. When everything works, set `ARIONPAY_TEST_MODE=false` and restart.

## What members see

| Moment | Message |
| --- | --- |
| `/shop` | The items as buttons (only they see it). |
| Press an item | A **Pay 15 USD** button to the ArionPay page. |
| Payment seen on the network | DM: "We see your payment… waiting for confirmations." |
| Payment confirmed | The role, and a DM: "Payment received, thank you!" with the item. |
| Time ran out | DM: "The payment time ran out… use /shop to try again." |

If a member does not accept DMs from the server, the item is shown in their private pay message instead, during the first 15 minutes. Later, the sale notice says the item still has to be sent.

## Good to know

- Orders are kept in `orders.json` next to the bot. Back it up.
- An item is delivered only when ArionPay confirms the full payment for that order, in the same currency and amount. A payment that is not exact goes to **Payment Radar** in your ArionPay dashboard, where you decide; if you accept it, the bot delivers.
- A test invoice never delivers while the bot is in live mode, and a live one never in test mode.
- Open orders are also re-checked every `POLL_SECONDS` (default 300), so a missed payment update still gets delivered.
- Roles are given for good: crypto cannot charge again automatically. Remove a role by hand when access should end, or sell a new item each period.
- Refunds are made from your own wallet.
- The bot sends ArionPay the member's Discord id, the server id and the item. It sends no names or messages.
