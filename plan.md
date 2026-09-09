# Overnight Plan — WhatsApp AI Agent

**Written:** 2026-09-09 · **Author:** Claude (autonomous session)
**Goal:** take the project from *"echo bot with a dashboard"* to *"Claude answers, remembers,
uses business tools, and doesn't fall over"* — without needing you awake for a single decision.

---

## 0. Ground rules for this session

Because you're asleep, every rule below exists so that you wake up to *progress*, not to a
half-finished refactor or a question I never got to ask.

1. **No questions, no permission prompts.** Every open decision is resolved in §2 below with a
   stated assumption. If I hit a genuine fork not covered there, I take the **reversible** option
   and log it in §9 (Decision log) rather than stopping.
2. **Never break `main` as it stands today.** Work lands in small commits (see §1.2). If a step
   can't be finished cleanly, it gets reverted rather than left dangling.
3. **No live sends, no live API spend.** There are no Anthropic credentials on this machine
   (verified: `ANTHROPIC_AUTH_TOKEN` is empty in `.env`, `ANTHROPIC_API_KEY` unset, `ant` CLI not
   installed). So **every Claude call and every Graph call is exercised against a fake**, never
   the real thing. This is a constraint, not a compromise — see §6.
4. **I do not touch your secrets.** `.env` is read-only to me; I only ever append *new* keys with
   safe defaults, and I never print a secret value into a file, log, or commit.
5. **`data/agent.db` is real conversation history.** Tests use a temp DB (`DB_PATH` override),
   never the live file. No destructive migration; schema changes are additive `CREATE TABLE IF NOT
   EXISTS` / `ALTER TABLE ... ADD COLUMN` guarded by a check.

---

## 1. Housekeeping first (30 min, blocking everything else)

### 1.1 The git situation — fix before anything else

`C:\Users\user\Desktop\projects\Claude\AI Whatsapp Agent` **is not a git repository.** The nearest
repo root is `C:\Users\user` — your entire home directory, with zero commits, and `.ssh/`,
`AppData/`, `NTUSER.DAT` and browser data all showing as untracked. A stray `git add .` from this
folder would stage your SSH private keys.

**Action:** `git init` inside the project folder so it becomes its own repo. This is additive and
reversible (`rm -rf .git`), it does not modify the home repo, and it gives every step below a
rollback point. I will **not** commit anything at the home-directory level.

Verify `.gitignore` already covers the dangerous paths — it does: `node_modules/`, `dist/`, `.env`,
`data/`, `*.db*`, `*.log`. First commit is the current tree as-is, so "before I touched it" is
always recoverable.

### 1.2 Commit discipline

One commit per numbered task below, message in the form `phase3: <what> — <why>`. Each commit is
left in a state where `npm run typecheck && npm test` passes. Attribution footer per repo policy.

### 1.3 Test harness — zero new dependencies

Verified on this machine: **Node 24.19 runs `.ts` test files natively**, including `.ts` import
specifiers (matches the existing `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`
setup). So:

```json
"test": "node --test --test-reporter=spec \"src/**/*.test.ts\"",
"test:watch": "node --test --watch \"src/**/*.test.ts\""
```

No jest, no vitest, no `tsx` in the test path, nothing added to `package.json` dependencies.
Caveat noted: native type-stripping rejects `enum`/`namespace`/decorators — none are used, and I
won't introduce them.

**Acceptance:** `npm test` runs green with at least one real assertion before I write feature code.

---

## 2. Decisions already made (so I don't have to ask)

| Question | Decision | Why |
|---|---|---|
| Model | `claude-opus-5` | Repo's `.env` already sets it; current-generation default. Never date-suffixed. |
| Thinking | Adaptive, on (the Opus 5 default) — **no `budget_tokens`** | `budget_tokens` is **rejected with a 400** on Opus 5. Disabling thinking on Opus 5 has known failure modes (tool calls leaking into visible text). Left on. |
| Effort | `output_config: { effort: "low" }` for ordinary replies, `"medium"` once tools are in the loop | Customer-support chat is the archetypal low-effort workload; tool selection benefits from a step up. Cost per reply matters when every inbound message is a call. |
| Streaming | Yes — `client.messages.stream(...).finalMessage()` | Not for token-by-token UI (WhatsApp can't render it), but to avoid HTTP timeouts and keep long turns safe. |
| `max_tokens` | `8192` | **Not** a lowball: thinking tokens count against `max_tokens`, so a WhatsApp-sized cap of 2048 would risk truncating mid-thought. The reply is kept short by the system prompt, not by starving the budget. |
| Prompt caching | System prompt + tool definitions cached (`cache_control: {type:"ephemeral"}`), volatile content after the breakpoint | The system prompt is resent on every single inbound message. Cheapest available win. |
| Agent loop | **Manual `while (stop_reason === "tool_use")` loop**, not the beta Tool Runner | Tool Runner needs `betaZodTool` + a zod dependency and the beta surface; the manual loop adds no dependency and lets me persist each turn to SQLite between iterations, which the dashboard needs. |
| History source | Existing `messages` table via `src/agent/memory.ts` | Already written and correct (drops leading assistant turns, skips empty media turns). Wire it up rather than reinvent it. |
| Empty-string env vars | Treat as unset **and `delete process.env[key]`** at boot | A present-but-empty `ANTHROPIC_AUTH_TOKEN` — exactly what's in your `.env` right now — sits ahead of every other credential source in the SDK's resolution chain and shadows it. This is the single most likely "why won't it authenticate" bug tomorrow morning. |
| Persona | Generic, configurable support agent; business facts in `src/agent/persona.ts` with obvious placeholders | I don't know your business. A file with `BUSINESS_NAME` etc. at the top is a 2-minute edit for you and doesn't block anything tonight. |
| Human handoff | Flag the conversation in SQLite + surface it loudly on the dashboard; no email/SMS integration | Any outbound notification channel would need credentials I don't have. |

---

## 3. Phase 3 — Claude in the loop (the main event)

### 3.1 `src/agent/persona.ts` — system prompt
Single exported `buildSystemPrompt()` returning a **byte-stable** string (no timestamps, no UUIDs —
those are silent cache invalidators). Contents: role, tone, hard rules (never invent order details,
never promise refunds, escalate rather than guess), WhatsApp-specific constraints (short replies,
plain text — no markdown tables, no headers; WhatsApp renders none of it), and the placeholder
business facts block.

### 3.2 `src/agent/claude.ts` — the API layer
- Lazily-constructed `Anthropic` client, **injectable** — `setClientForTesting()` / a module-level
  factory. This is what makes the whole thing testable without a key.
- `generateReply(waId, systemPrompt, history, tools)` → `{ text, usage, toolCalls, stopReason }`.
- Typed error handling as a **chain, not one broad catch**: `AuthenticationError` (→ log loudly,
  reply with a neutral "I'm having trouble right now"), `RateLimitError` (→ backoff + retry once),
  `APIConnectionError` (→ retry), `APIError` (→ give up gracefully). No string-matching on messages.
- Guard `stop_reason === "refusal"` before reading content, and check `stop_details` — it is `null`
  for every other stop reason, so it must be guarded.
- Log `usage.input_tokens` / `cache_read_input_tokens` / `output_tokens` per call as a structured
  event, and persist it (§3.5) so cost is visible on the dashboard rather than a monthly surprise.

### 3.3 `src/core/handler.ts` — replace the echo
New flow: dedupe (already done upstream) → `markReadAndTyping` → load history → call Claude →
persist assistant turn → `sendText`. On any failure, send a plain apology rather than silence, and
record the error event. Media-only messages keep their current "I can only read text" path until
§5.3 lands.

### 3.4 Per-conversation serialization
Today, two webhook payloads for the same person arriving close together run concurrently — both
read the same history, both reply, and the transcript interleaves. Add a small keyed promise-chain
queue (`src/core/queue.ts`): messages from the same `wa_id` run strictly in order; different
contacts still run in parallel. In-process only, matching the existing event bus's documented
single-instance assumption.

### 3.5 Cost/usage persistence
`ALTER TABLE messages ADD COLUMN` for `input_tokens`, `output_tokens`, `cache_read_tokens`,
`latency_ms` (guarded — additive, safe on the existing DB). Surfaced in §7.

### 3.6 Tests (`src/agent/claude.test.ts`, `src/core/handler.test.ts`)
Fake Anthropic client returning canned `Message` objects. Covered: happy path; refusal stop reason;
rate-limit retry then success; rate-limit exhausted → apology sent, not silence; history correctly
ordered and role-alternating; empty history (first-ever message) doesn't crash; a 4096+ char model
reply gets split by the existing `splitMessage`.

---

## 4. Phase 4 — Business tools

Manual tool loop in `src/agent/tools.ts`, with a hard **max 5 iterations** stop (a runaway loop is
real money). Tool definitions typed as `Anthropic.Tool`, `strict: true` with
`additionalProperties: false`, and — important — **tool inputs parsed as JSON, never string-matched**
(Opus 5 varies its escaping in tool arguments).

Tools, all backed by real SQLite tables so they aren't theatre:

| Tool | Does |
|---|---|
| `get_business_info` | Hours, address, contact — reads `persona.ts` |
| `lookup_order` | `orders` table by order id + phone number; seeded with fixtures |
| `create_booking` | Writes to `bookings`; rejects past dates and double-bookings |
| `check_availability` | Free slots for a date |
| `escalate_to_human` | Sets `needs_human` on the contact, tells the user a person will follow up, and **stops the agent replying in that thread** until cleared |

Each tool is a plain function with its own unit test, tested independently of the model. One
integration test drives a scripted two-turn tool conversation through the fake client.

---

## 5. Phase 5 — The things that break in production

### 5.1 The 24-hour window guard
Currently nothing stops a send outside Meta's free-form window; the API just rejects it and the
reply vanishes. Add a pre-send check against `contacts.last_inbound_ts`: outside the window, skip
the send, record a `window_closed` event, and mark the message on the dashboard. Per the README
this is *"the single most common cause of the bot stopped answering"* — it deserves an explicit
signal instead of a Graph error.

### 5.2 Retries, rate limits, kill switch
- Graph 429/5xx → exponential backoff with jitter, 3 attempts, `Retry-After` honoured. 4xx → no
  retry (retrying a bad request just burns quota).
- Simple token-bucket outbound throttle.
- **Kill switch**: `agent_enabled` flag in a `settings` table, plus per-contact pause. When off,
  messages are still received, stored and shown on the dashboard — the agent just doesn't reply.
  This is the "oh no, stop it" button, so it gets a POST route (§7) and is checked *before* the
  Claude call, not after.

### 5.3 Media (stretch)
`downloadMedia` already exists. Images → base64 `image` content block to Claude (vision), size-
capped. Audio/voice → polite "I can't listen to voice notes yet" (the Messages API does not do
speech-to-text; anything else would need a service I can't configure tonight). Documents → filename
acknowledged only.

---

## 6. How I verify without credentials

This is the crux of the whole plan, so it's explicit.

1. **Fake Anthropic client** — injected; returns real-shaped `Message` objects, including
   `tool_use` blocks, `refusal` stops, and thrown typed SDK errors.
2. **Mock Graph server** — a local `node:http` server speaking Meta's response shape. New optional
   `GRAPH_BASE_URL` env override (defaults to the real Graph URL, so production behaviour is
   unchanged) points the client at it. This exercises `sendText`, chunking, wamid capture, retry
   and backoff for real, over a real socket.
3. **Signed webhook synthesizer** (`scripts/fake-webhook.ts`) — builds a Meta-shaped payload and
   signs it with the actual `WHATSAPP_APP_SECRET` HMAC, so `verifySignature` is exercised on the
   real path rather than bypassed. This lets me drive complete end-to-end conversations against a
   locally-running server tonight, with no phone and no tunnel.
4. **End-to-end run** — boot the app against a temp DB + mock Graph + fake Claude, POST a signed
   webhook, assert: 200 acked fast, message stored, reply sent, transcript ordered, dashboard API
   reflects all of it, duplicate delivery ignored on replay.

What I **cannot** verify tonight, stated plainly: that the real Anthropic API accepts my exact
request shape, and that real WhatsApp delivery works. Both are §8's first two lines.

---

## 7. Dashboard updates

The dashboard is currently read-only by design and I'll keep that shape for reads, but the kill
switch needs a write. Adding a **`POST /api/agent/toggle`** and **`POST /api/conversations/:waId/clear-handoff`**, both behind the existing token `guard` — same auth, no new surface area.
Plus: tokens/cost per conversation, a `needs_human` badge, agent on/off indicator, window-closed
markers, and tool-call events in the log. All served by the existing SSE stream.

---

## 8. What's waiting for you in the morning

A `MORNING.md` will list this concretely, but in short:

1. **Put a real credential in `.env`** — set `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`, not
   both). It is currently *present but empty*, which is worse than absent; §2 handles that in code,
   but the value still has to come from you.
2. **Edit `src/agent/persona.ts`** — replace the placeholder business facts. Roughly a 2-minute job.
3. **Start the tunnel and send one message** to confirm the real path, since I could only prove the
   fake one.
4. Skim §9's decision log for anything you'd have decided differently.

---

## 9. Decision log

Every non-obvious choice, and how to reverse it.

| # | Decision | Why | To reverse |
|---|---|---|---|
| 1 | `git init` in the project | The nearest repo root was the home directory; a stray `git add .` would stage `~/.ssh` | `rm -rf .git` |
| 2 | Test env in `.env.test`, committed | Importing any module pulls in `config.ts`, which validates env and opens SQLite; without it the suite would run against real credentials and the live database | Delete it and pass env another way |
| 3 | `--test-concurrency=1` | Test files share one SQLite file; parallel writers flake rather than fail honestly | Drop the flag once each file gets its own DB |
| 4 | Empty credential vars deleted at boot, scoped to the Anthropic chain | An empty string claims its slot and authenticates as empty. Scoped rather than global because empty is legitimate elsewhere | Remove `pruneEmptyCredentials` from `config.ts` |
| 5 | `GRAPH_BASE_URL` override added | Lets the suite exercise sending over a real socket against a mock; unset in production | Remove the `optional()` call in `config.ts` |
| 6 | CLI at `src/testing/cli-webhook.ts`, not `scripts/` | `rootDir` is `src`, and adding `scripts/` to the program broke `tsc` | Move it and set `rootDir` to `.` |
| 7 | `max_tokens` 8192, streaming | Thinking tokens count against `max_tokens`; a small cap truncates mid-thought | Lower `ANTHROPIC_MAX_TOKENS` in `.env` |
| 8 | Effort `medium`, not `low` | Tool selection benefits from a step up; plain chat did not | One line in `src/agent/claude.ts` |
| 9 | Manual tool loop, not the beta Tool Runner | No zod dependency, no beta surface, and each turn can be persisted between iterations | Rewrite `generateReply` around the beta tool runner |
| 10 | Dedupe moved to SQLite | An in-memory Map forgets on restart and Meta's retries outlive one; with a model behind it a duplicate costs money twice | Restore the Map in `src/core/dedupe.ts` |
| 11 | History ordered by `rowid`, not `ts` | Inbound rows carry Meta's clock, outbound ours; a late retry scrambles the transcript | Change `ORDER BY` in `queries.ts` |
| 12 | Window guard inside `sendText` | Covers every send path, including the fallback reply | Move the check into `handler.ts` |
| 13 | Kill switch in the database, not an env var | Flips without a restart and is reachable from the dashboard | Read an env var in `agentEnabled()` |
| 14 | Wrong-owner order lookup answers identically to not-found | Saying "that order exists but isn't yours" confirms the id to whoever is asking | Branch on `wrong_phone` in `tools.ts` |
| 15 | Two dashboard POST routes added | A stop button you must SSH in to press is not a stop button | Delete the routes; the UI degrades to read-only |
| 16 | Media/vision (section 5.3) not attempted | Stated as stretch; items 1-11 solid was the better trade | Ordinary follow-up work |

**Not done, and why:** section 5.3 media/vision. The plan called it genuinely
stretch and said 1-11 solid beat 13 shaky. `downloadMedia` already exists, so
this is a clean starting point rather than a hole.

---

## 10. Order of work

Strictly sequential; each line is a commit, and anything unfinished is reverted rather than left
half-applied.

```
 1. git init + baseline commit               ← rollback point for everything
 2. npm test harness + first real test
 3. config: empty-env fix, GRAPH_BASE_URL override
 4. mock Graph server + signed webhook synthesizer   ← the tools that verify the rest
 5. persona.ts + claude.ts (+ tests)
 6. handler.ts rewrite + per-conversation queue (+ tests)
 7. usage/cost columns + dashboard surfacing
 8. 24h window guard (+ tests)
 9. retries / throttle / kill switch (+ tests)
10. tools.ts + business tables + tool loop (+ tests)
11. dashboard: handoff badge, agent toggle, tool events
12. media/vision                              ← stretch
13. README + .env.example + MORNING.md
```

Items 1–9 are the commitment. 10–11 are expected. 12 is genuinely stretch, and I'd rather ship
1–11 solid than all thirteen shaky.
