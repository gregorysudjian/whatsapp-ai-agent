# WhatsApp AI Agent

A customer-support agent on WhatsApp, built on the **Meta WhatsApp Cloud API** with
**Claude** doing the reasoning. TypeScript / Node.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Scaffold, config, logging, health | done |
| 2 | Webhook verify + signature + echo reply | done |
| 2.5 | SQLite store + live ops dashboard | done |
| 3 | Claude in the loop, conversation memory (SQLite) | done |
| 4 | Business tools (lookup, booking, human handoff) | next |
| 5 | Media/voice, retries, rate limits, kill switch | todo |
| 6 | Deploy, monitoring | todo |

## Setup

### 1. Meta side (~30 min, one time)

You have to do this part yourself - it's clicking through Meta's dashboard.

1. **Meta app** - developers.facebook.com > My Apps > Create App > **Business** type.
2. Add the **WhatsApp** product. This auto-creates a WhatsApp Business Account (WABA)
   and a free **test number** you can message 5 whitelisted recipients from.
3. From **WhatsApp > API Setup**, copy:
   - `Phone number ID` -> `WHATSAPP_PHONE_NUMBER_ID`
   - `WhatsApp Business Account ID` -> `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - the temporary access token -> `WHATSAPP_ACCESS_TOKEN` (expires in 24h; see step 6)
4. Add **your own** number under "To" so you can message the bot.
5. **App Settings > Basic > App Secret** -> `WHATSAPP_APP_SECRET`.
6. **Permanent token** (do this before you get annoyed by the 24h one):
   business.facebook.com > Business Settings > Users > **System Users** > Add.
   Give it the WABA asset with full control, then Generate Token with the
   `whatsapp_business_messaging` and `whatsapp_business_management` scopes.

### 2. Local

```bash
cp .env.example .env      # fill it in
npm install
npm run dev
```

### 3. Expose the webhook

Meta needs a public HTTPS URL. No signup needed with cloudflared:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then in **WhatsApp > Configuration > Webhook**:
- Callback URL: `https://<your-tunnel>.trycloudflare.com/webhook`
- Verify token: whatever you put in `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **`messages`** field. (Missing this is the #1 reason a
  correctly-built bot receives nothing.)

Message the test number from your phone. You should get `echo: <your text>` back.

## The agent

`src/agent/` holds everything model-facing; `src/core/handler.ts` just wires it
to the channel.

| File | What |
|---|---|
| `agent/claude.ts` | The Messages API call, error classification, fallbacks |
| `agent/memory.ts` | Rebuilds conversation history from the store |
| `agent/prompt.ts` | The system prompt - override with `SYSTEM_PROMPT` |

**Credentials.** The client is constructed with no arguments so the SDK's own
resolution order applies: `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`,
then an `ant auth login` profile on disk. Set only one - a present-but-empty
`ANTHROPIC_API_KEY` still claims its slot and authenticates as empty. With no
credential the agent boots, warns once, and answers every message with the
fallback line rather than crashing.

**History comes from the store, not from memory.** Every inbound and outbound
message is already persisted, so `buildHistory` reads the transcript back
rather than keeping a parallel cache that can drift from what was really sent.
It replays the last `HISTORY_LIMIT` turns - raise it for more context, and
every message gets more expensive.

**Ordering is by insertion, never by timestamp.** Inbound rows carry Meta's
second-resolution send time; outbound rows carry ours. A retried webhook can
arrive with a timestamp older than replies already stored, so sorting on it
scrambles the transcript. `rowid` is the order the agent actually saw.

**Failure is a reply, not an exception.** Refusals, empty completions, auth
errors, and rate limits all return the fallback message and record an event -
the customer gets a sentence, the dashboard gets a red tile.

## Dashboard

A read-only operator view, served by the agent itself at `/dashboard`. Live
conversation list, per-thread history, delivery receipts, and an event log fed
by server-sent events - no polling, no build step, no dependencies.

The boot log prints the URL with its token:

```
{"msg":"dashboard_ready","url":"http://localhost:3000/dashboard?token=..."}
```

Set `DASHBOARD_TOKEN` in `.env` to keep that URL stable across restarts;
leave it blank and a fresh token is minted every boot.

**Why a token and not a localhost check.** `cloudflared` runs on your machine,
so a tunnelled request reaches Express from `127.0.0.1` like any local one. An
"only allow loopback" guard would therefore admit the entire internet the
moment you start a tunnel. Every `/dashboard` and `/api` route is gated.

The most useful column is the **24h window** badge per conversation: green
while you can still send free-form replies, red once only templates will
deliver. That limit is the single most common cause of "the bot stopped
answering".

## Architecture

```
WhatsApp --webhook--> src/whatsapp/webhook.ts   verify signature, ack 200 fast
                              |
                      src/core/dedupe.ts        drop Meta's retries
                              |
                      src/core/handler.ts       <- Claude goes here (phase 3)
                              |
                      src/whatsapp/client.ts    send, mark read, download media
                              |
                      src/store/db.ts           history + events (node:sqlite)
                              |
                      src/dashboard/router.ts   /dashboard, /api, SSE stream
```

The agent layer never sees WhatsApp payload shapes - `webhook.ts` normalizes to
`InboundMessage` first, so the channel stays swappable.

## Things that will bite you

- **The 24-hour window.** You may only send free-form messages within 24h of the
  user's last message. Outside it, only pre-approved *template* messages. This is
  a hard API rule, not a guideline.
- **Ack before you think.** Meta retries any webhook that doesn't return 200 fast,
  which is why the reply is generated *after* `res.sendStatus(200)`.
- **Signatures matter.** Without the HMAC check, anyone with the URL can drive
  the bot and spend your API credits.
- **Test number limits.** 5 recipients, and it can't receive from unlisted numbers.
- **`node --watch` watches `node_modules`.** Any dependency touch restarts the
  process, and each restart drops the listening socket long enough for another
  app to steal the port. Scope it with `--watch-path=./src`.
- **Duplicate replies cost money now.** Dedupe is backed by the messages table
  rather than a `Map`, so it survives restarts. The remaining gap: a crash
  between storing the inbound message and sending the reply means Meta's retry
  is treated as a duplicate and never answered.
- **The dashboard's event bus is in-process.** One instance sees its own writes
  only; run several and each dashboard shows just its own traffic. A shared bus
  (Redis pub/sub) is the fix if this ever runs multi-instance.
