# WhatsApp AI Agent

A customer-support agent on WhatsApp, built on the **Meta WhatsApp Cloud API** with
**Claude** doing the reasoning. TypeScript / Node.

## Status

| Area | What | State |
|---|---|---|
| Agent | Webhook, signatures, Claude with tools, memory, retries, 24h guard, kill switch | done |
| Multi-business | Tenancy, encrypted credentials, per-client webhooks | done |
| Dashboard | Logins and roles, overview with charts, inbox with human takeover, bookings, contacts + CSV, agent settings, monthly PDF, admin panel | done |
| Bookings | Services and durations, no double-booking, customers manage their own on WhatsApp, reminders with Confirm/Cancel, Google Calendar sync | done |
| Privacy (Law 25) | Retention, erasure, AI notice, audit log | done |
| Deploy | Dockerfile and a guide (docs/deploy.md) | ready, not deployed |
| Media / voice | Images and voice notes | todo |

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
cloudflared tunnel --url http://localhost:3001
```

Then in **WhatsApp > Configuration > Webhook**:
- Callback URL: `https://<your-tunnel>.trycloudflare.com/webhook`
- Verify token: whatever you put in `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **`messages`** field. (Missing this is the #1 reason a
  correctly-built bot receives nothing.)

Message the test number from your phone: the agent answers (with `ANTHROPIC_AUTH_TOKEN` set; without it, a fallback sentence), and the conversation appears in the dashboard's Inbox.

## Tests

```bash
npm test          # node --test, no jest/vitest/tsx in the test path
npm run typecheck
```

Tests load `.env.test`, never `.env`: importing any module pulls in `config.ts`,
which validates env at import time and opens SQLite, so without a separate env
the suite would run against real Graph credentials and the live conversation
database.

Two external services are faked and nothing else is:

- `src/testing/mock-graph.ts` speaks Graph's real response shapes over a socket,
  so chunking, wamid capture, retry and backoff all execute for real.
- `src/testing/webhook.ts` signs payloads with the real app-secret HMAC rather
  than bypassing `verifySignature`.

Drive a conversation yourself, no phone or tunnel needed:

```bash
npm run fake-webhook -- "are you open today?"
npm run fake-webhook -- "and tomorrow?" --from 15145551234
```

**Caveat:** the suite runs under Node's strip-only TypeScript mode, which
rejects `enum`, `namespace`, decorators, and constructor parameter properties.
None are used; don't introduce them.

## Multiple businesses

One server runs the agent for many clients. Each business has its own
WhatsApp number, its own Meta credentials, its own settings, and its own data -
and nothing of one is visible through another.

**Every client gets its own webhook URL:** `/webhook/b/<publicId>`. The
server checks the signature with *that client's* app secret, and then checks
that the payload is for that client's phone number. The bare `/webhook` still
works and maps to business #1, so an existing Meta setup keeps working.

```bash
npm run business -- list                       # clients, status, webhook URLs
npm run business -- add "Clinique X" --language fr --timezone America/Toronto
npm run business -- connect 2                  # prompts for the Meta credentials
npm run business -- show 2                     # secrets shown redacted, never in full
npm run business -- messages 2                 # that client's conversations only
npm run business -- deactivate 2               # acked, but not stored or answered
```

**Credentials are encrypted at rest** with AES-256-GCM using
`APP_ENCRYPTION_KEY` from `.env` (`npm run gen-key` makes one). Each
ciphertext is bound to its business and field, so copying one client's
encrypted token into another client's row in the database does not decrypt.
**Back the key up:** without it, stored credentials cannot be recovered.

**Isolation is enforced twice.** Every data function takes a business id, so
TypeScript rejects an unscoped call; and every client-owned table declares
`business_id NOT NULL` with no default and a foreign key, so the database
rejects an unscoped row. `src/store/isolation.test.ts` drives two clients side
by side through the real webhook and send path and probes each cross-client
route; each of its leak checks was verified by switching the leak on and
watching the test fail.

**Opening hours are per business and per weekday**, and "is this slot in the
past" is judged in the business's own timezone, not the server's.

## The agent

`src/agent/` holds everything model-facing; `src/core/handler.ts` just wires it
to the channel.

| File | What |
|---|---|
| `agent/claude.ts` | The Messages API call, error classification, fallbacks |
| `agent/memory.ts` | Rebuilds conversation history from the store |
| `agent/prompt.ts` | Builds the system prompt from each business's settings (byte-stable, cached) |
| `agent/persona.ts` | Seed values for the default business only |
| `agent/tools.ts` | Tool schemas and their executors |

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

**Tools run in a capped manual loop.** Five iterations maximum - a runaway loop
is real money. The assistant turn is echoed back verbatim, thinking blocks
included, and all tool results go back in *one* user message; splitting them
across several teaches the model to stop making parallel calls.

**Failure is a reply, not an exception.** Refusals, empty completions, auth
errors, and rate limits all return the fallback message and record an event -
the customer gets a sentence, the dashboard gets a red tile.

## Dashboard

A React app (in `web/`) served by the agent itself at `/`, behind per-person
logins: a super admin sees every client, a business owner sees only their own.
Build it with `npm run build:web`; during development `npm run dev:web` serves
it with hot reload and proxies `/api` to the agent.

Create the first accounts with `npm run user -- bootstrap`. There is no shared
token and no "localhost is trusted" rule: `cloudflared` runs on this machine, so
a tunnelled request reaches Express from `127.0.0.1` like any local one.

The inbox shows each conversation's **24h window**: while it is open, a person
can take the conversation over and reply; once it closes, only approved
templates deliver. That limit is the single most common cause of "the bot
stopped answering".

## Architecture

```
WhatsApp --webhook--> src/whatsapp/webhook.ts   verify signature, ack 200 fast
                              |
                      src/core/dedupe.ts        drop Meta's retries
                              |
                      src/core/handler.ts       buttons, AI notice, Claude + tools
                              |
                      src/whatsapp/client.ts    send text/templates, mark read, media
                              |
                      src/store/*               node:sqlite, every row scoped by business
                              |
                      src/api/*                 /api/b/:bid (owner), /api/admin (super admin), SSE
                              |
                      web/                      React dashboard, served at /

   alongside: src/core/reminders.ts (template reminders), src/calendar/google.ts
   (Google Calendar), src/core/privacy-jobs.ts (retention), src/reports/ (PDF)
```

The agent layer never sees WhatsApp payload shapes - `webhook.ts` normalizes to
`InboundMessage` first, so the channel stays swappable.

## Operating it

- **Kill switch** - **Pause agent** on the Overview. Messages are still received,
  stored and shown while it is off; replies and reminders are withheld, so turning
  it off never loses a question.
- **Handoff** - `escalate_to_human` marks the conversation "Needs a person" at the
  top of the Inbox; **Take over** / **Hand back to agent** move it between a person
  and the agent.
- **Spend** - tracked per reply; per client per month under Admin -> Usage & billing.

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

## Deploying

A `Dockerfile` builds one image with the agent and the dashboard; `docs/deploy.md` walks through
a Canadian VM, HTTPS with Caddy, secrets, backups, and connecting each client's Meta webhook.
Other guides: `docs/whatsapp-templates.md` (reminder templates for Meta) and
`docs/google-calendar-setup.md` (Google Calendar).
