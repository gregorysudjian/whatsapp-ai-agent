# Good morning

Overnight run finished. **11 commits, 83 tests passing, typecheck clean.**
Nothing was sent to a real customer and no API spend was incurred.

Start the app the way you always did:

```bash
npm run dev
```

---

## Do these three things (about 10 minutes)

### 1. Add your Anthropic auth token — the one real blocker

Put it in `.env`:

```
ANTHROPIC_AUTH_TOKEN=<your token>
```

Leave `ANTHROPIC_API_KEY` absent: the SDK checks it first, so any value there,
even an empty one, would be used instead of the auth token. The code deletes
empty credential vars at boot and says so in the log.

Until a token is present the agent boots fine, warns once, and answers every
message with the fallback sentence. That path is tested — it is not a crash.

### 2. Business details — done

`src/agent/persona.ts` is set to Ninja Co, robotics and coding tutoring,
Monday to Friday 8am–3pm. Bookings follow the same hours. Address and human
contact are still blank; the agent offers a human when asked for them.

### 3. Send one real message

Everything below was verified against fakes. What I could **not** verify is
that the real Anthropic API accepts my exact request shape and that real
WhatsApp delivery works. So:

```bash
npm run dev
cloudflared tunnel --url http://localhost:3000     # needs installing first
```

Point Meta's webhook at `https://<tunnel>/webhook`, message your test number,
and watch the dashboard.

---

## What you got

| Phase | What | State |
|---|---|---|
| 3 | Claude answering, conversation memory | done |
| 4 | Business tools, human handoff | done |
| 5 | 24h guard, retries, throttle, kill switch | done |
| 5.3 | Media / vision | not started (stretch, as planned) |

**The agent** (`src/agent/`) — persona, memory rebuilt from the store, a manual
tool loop capped at 5 iterations, streaming, prompt caching on the system
prompt, and typed error handling that retries rate limits but never auth
failures.

**Tools** — `get_business_info`, `lookup_order`, `check_availability`,
`create_booking`, `escalate_to_human`. All backed by real SQLite tables, so they
can genuinely fail and the agent has to cope.

**Safety rails** — Meta's 24-hour window is checked before every send; Graph
429s and 5xx retry with backoff honouring `Retry-After`; a token bucket paces
outbound sends; and a kill switch you can hit from the dashboard.

**The dashboard** — now shows model spend, per-reply token counts, a
`needs human` queue sorted to the top, and an agent on/off toggle.

**Testing** — `npm test`. 83 tests on `node --test`, no new dependencies. Drive
a conversation yourself without a phone or tunnel:

```bash
npm run fake-webhook -- "are you open today?"
```

---

## Things I'd want you to know

**Your home directory is a git repository.** `C:\Users\user` is a repo with zero
commits and `.ssh/`, `AppData/` and browser data all untracked in it. A stray
`git add .` up there would stage your SSH private keys. This project is now its
own repo so it's no longer *inside* that one, but the hazard upstairs is
untouched and worth dealing with.

**Two real Graph calls went out during testing.** Early on I ran the fake-webhook
CLI against the live server, which still had your real credentials, so two
requests hit Meta — both rejected (`131009` bad message id, `131030` recipient
not in allowed list). Nothing reached anyone. My mistake; after that I pointed
everything at the mock.

**Known gap, deliberately left:** if the process dies between storing an inbound
message and sending the reply, Meta's retry is now treated as a duplicate and
goes unanswered. Durable dedupe traded a double-reply bug (which costs money
twice) for a rare dropped-reply one. Fixing it properly means tracking
replied-vs-received separately. It's in the README's gotchas.

**Cost per reply** is roughly 2,000–3,000 input tokens (mostly the cached system
prompt and history) and ~100 output. At Opus 5 list prices that's under a cent
per exchange, and the dashboard tracks it. Effort is `medium` because tool
selection benefits from it; drop to `low` in `src/agent/claude.ts` if you want
it cheaper and are not using tools much.

---

## Bugs I found in my own earlier work

Worth knowing because they were all invisible until something actually ran:

1. **History was ordered by timestamp.** Inbound rows carry Meta's
   second-resolution send time, outbound rows carry ours. A retried webhook
   arrives with a timestamp older than replies already stored, and the
   transcript reorders into `user, user, assistant, assistant` — a scrambled
   conversation fed to the model, silently. Now ordered by insertion.

2. **`APIConnectionError extends APIError`**, and my error chain checked the
   base class first, so the connection branch was unreachable and every network
   failure was misreported. Ordering is load-bearing; a test pins it now.

3. **A missing credential throws a plain `Error`**, not any SDK class, so it was
   being filed as `"unknown"` — the most likely failure on a fresh checkout,
   reported as the least useful category.

4. **`max_tokens` was 1024.** Thinking tokens count against it, so a
   WhatsApp-sized cap risked truncating mid-thought and returning empty text.
   Now 8192; brevity comes from the prompt instead.

5. **A test passed for the wrong reason** — my fake client returned `undefined`
   once its queue emptied, and the fallback path swallowed the resulting
   `TypeError`.

Full reasoning for every decision is in the commit messages, and `plan.md` §9
has the decision log with reversal instructions.
