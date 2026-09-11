# Overnight Plan — the WhatsApp Agent Dashboard

**Written:** 2026-09-11 · **For:** one unattended overnight run · **Owner asleep:** yes
**Goal:** take the project from *"multi-business backend + an old single-page dashboard"* to
*"a real product: owners log in, run their inbox, edit their agent, manage bookings; the
agent books, reminds and confirms; you run clients and billing from an admin panel."*

The previous plan (phases 3-5, all done) is in git history: `git show 812dfe5:plan.md`.

---

## 0. How to run this plan (read first, every time)

1. **Read this whole file before touching code.** It is written so a session with no memory of
   earlier conversations can execute it correctly.
2. **Resume, don't restart.** Run `git log --oneline`. Every step commits with the prefix
   `dash-<N>:`. Start at the first step in §5's execution order that has no commit. If the
   latest commit is a `wip` or the tree is dirty, see §1 rule 7.
3. **Never end the turn to ask a question.** The owner is asleep. Every decision is made in §3.
   A genuinely new fork gets the *reversible* choice and a line in the decision log (§10), then
   work continues. Stop only when every step is done, or every remaining step is blocked (§1.9).
4. **Finish each step completely before the next:** code → tests → typecheck → build → visual
   check (UI steps) → update `MORNING.md` → commit. Then immediately start the next step.

---

## 1. Ground rules (non-negotiable)

1. **No real outbound traffic. Ever.** Business #1 (Ninja Co) holds **real Meta credentials**.
   Any code path that sends against the live database can message real people. Therefore:
   - All tests use `.env.test` (fake credentials, `data/test.db`, `GRAPH_BASE_URL` → mock).
   - **Never** run `npm run fake-webhook` at the live server during the night.
   - The live server on :3001 is **stopped** for the whole run (§1.8) and restarted only at
     the very end, after the final checks.
   - New outbound features (reminders, calendar sync) ship **disabled by default per business**.
     The owner turns them on deliberately. A reminder job that wakes up at 3am against the live
     database must find nothing enabled.
   - No calls to real Anthropic, Meta or Google APIs. Mocks only (§6).
2. **Never edit an applied migration.** Migrations 1 and 2 are applied to the live database.
   Only append new ones (`user_version` 3, 4, ...). Before a new migration first runs on
   `data/agent.db`: back it up (`VACUUM INTO data/backups/...`), run the migration on a copy,
   compare row counts, then boot for real.
3. **Tenant isolation is the product.** Every new table with client data gets `business_id
   INTEGER NOT NULL REFERENCES businesses(id)` with **no default**. Every new data function takes
   `businessId` first. Every new API route resolves the business from the **session**, never
   from the request body. The authorization test in D2 (§5) must cover every new route
   automatically — if a step adds a route and that test does not see it, the step is not done.
4. **Secrets stay server-side.** Nothing returned to the browser contains a token, app secret,
   password hash, session id or refresh token. Encrypt any new secret with
   `security/crypto.ts` (context string `business:<publicId>:<field>`).
5. **Validate every input** at the API boundary (zod, §3). Reject, don't coerce.
6. **Green before commit.** `npm test` (all pass), `npm run typecheck`, `npm run build`
   (backend) and `npm run build:web` (from D3). Never commit a red tree.
7. **Never leave `main` broken.** If a step can't be finished cleanly within its budget
   (§5), commit only its *minimum acceptable* version if that is green. If even that fails,
   `git stash` or `git reset --hard` to the last `dash-` commit, write why in `MORNING.md`,
   and move to the next step that doesn't depend on it.
8. **Processes.** At the start: stop the dev server and kill orphans (the `tsx watch` parent
   survives `TaskStop`; find it with
   `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*AI Whatsapp Agent*' }`).
   Never kill anything outside this project (the AI Lead Agent runs on :3000). At the end,
   start exactly one server on :3001 and confirm no duplicates.
9. **Blocked ≠ stuck.** If npm install, Edge, or anything environmental fails twice, log it,
   skip to the next independent step, and come back once at the end.
10. **Other sessions.** At the start, run `ListAgents`. If another session is working in
    *this* repo, message it: *"Overnight run in progress on AI Whatsapp Agent — please don't
    edit files here until MORNING.md says it's finished."* Two sessions editing the same files
    overwrite each other (it happened once already).
11. **No tunnels, no published artifacts, no pushes.** Local only.
12. **Skills to load at the right moment:** `claude-api` before changing anything in
    `src/agent/` (the prompt and tools); `dataviz` before writing any chart (D9).

---

## 2. Where the project stands (verified 2026-09-11)

- **Branch** `main`, clean, last commit `b08ac69`. **127 tests** pass. Node 24.19, npm 11.
- **Backend:** Express 5 + TypeScript run by `tsx`; SQLite via built-in `node:sqlite`;
  schema `user_version = 2` (multi-tenant). Anthropic SDK 0.124. No other runtime deps.
- **Businesses:** #1 **Ninja Co** — active, `Asia/Beirut`, real Meta credentials, webhook
  `/webhook/b/h5tnavLREe10`, hours Mon–Fri 08:00–15:00. #2 **Test Clinic** — inactive, fake
  credentials (the owner's test client; leave it).
- **No Anthropic credential** on the machine. Every real reply is the fallback sentence. The
  owner wants the variable named **`ANTHROPIC_AUTH_TOKEN`** in all hints and docs.
- **Old dashboard:** `src/dashboard/ui.html` + `router.ts`, one shared `DASHBOARD_TOKEN`,
  pinned to business #1. Replaced in D5.
- **Key files**
  | Area | Files |
  |---|---|
  | Tenancy, schema | `src/store/schema.ts` (migrations), `db.ts` (writes), `queries.ts` (reads) |
  | Clients | `src/store/businesses.ts` (CRUD, encrypted creds, facts, schedule, timezone) |
  | Bookings | `src/store/bookings.ts` (per-business schedule, business-timezone "past") |
  | Agent | `src/agent/claude.ts` (tool loop, retries), `tools.ts`, `persona.ts`, `memory.ts` |
  | WhatsApp | `src/whatsapp/webhook.ts` (per-client routing), `client.ts` (send, retries, 24h guard) |
  | Core | `src/core/handler.ts`, `queue.ts`, `events.ts` (scoped pub/sub), `throttle.ts` |
  | Security | `src/security/crypto.ts` (AES-256-GCM, context-bound) |
  | Tooling | `src/cli/business.ts`, `src/testing/{mock-graph,webhook,setup,cli-webhook}.ts` |

---

## 3. Decisions already made (do not reopen)

| Question | Decision | Why |
|---|---|---|
| Frontend | **React 19 + Vite 8 + TypeScript + Tailwind 4** (`@tailwindcss/vite`), `react-router` 7, `recharts` 3, `lucide-react` icons, `@fontsource-variable/inter` | Eight pages with auth, forms, charts and two languages. Fonts self-hosted: no Google Fonts call, nothing leaves the server (Law 25). |
| Frontend location | `web/` as its own package (`web/package.json`), built to `web/dist`, served by Express at `/` with an SPA fallback. Root scripts `build:web`, `dev:web` (Vite on :5173, proxy `/api` → :3001). | One URL in production; hot reload in development. Root `tsconfig` excludes `web/`. |
| Component library | None. Hand-built components with Tailwind. | A CLI-initialised library (shadcn) is a risk unattended; a dozen components is enough. |
| i18n | Own dictionaries `web/src/i18n/{en,fr}.ts`, typed keys, `t()`. Choice stored per user (`users.locale`) with localStorage fallback. | Two languages don't justify a library. A test forces every key to exist in both. |
| Theme | Light / dark / system, `dark` class on `<html>`, stored per browser. | |
| Validation | **zod 4** on the backend at every API boundary. | Settings, bookings and admin forms are nested; hand validation is where bugs hide. |
| Passwords | `scrypt` from `node:crypto`, per-user salt, stored `scrypt$N$r$p$salt$hash`. Min 10 chars, not equal to the email. | No dependency. |
| Sessions | 32 random bytes, base64url, in an HttpOnly `SameSite=Strict` cookie `wa_session` (`Secure` when `COOKIE_SECURE=1`). Only the **SHA-256** of the token is stored. Sliding 12h, absolute 7 days. | A stolen database does not yield usable sessions. |
| CSRF | SameSite=Strict **plus** an `Origin` check on every non-GET `/api` request. | Belt and braces. |
| Login rate limit | In-memory: 5 failures per email per 15 min, 30 per IP. Always the same generic error message. | Single instance, matches the documented event-bus assumption. |
| API shape | `/api/auth/*`, `/api/b/:businessId/*` (owner: must equal their own business; super admin: any), `/api/admin/*` (super admin only). | Scope is visible in every URL and enforced by one middleware. |
| Roles | `super_admin` (business_id NULL, sees all) and `owner` (exactly one business). A `CHECK` constraint enforces the pairing. | Matches the brief; staff roles can come later. |
| First accounts | Created overnight: super admin **admin@example.com**; owner of Ninja Co **owner@ninjaco.test**. Random 16-character passwords written to `data/initial-credentials.txt` (gitignored via `data/`), never logged, **forced change on first login**. | The owner needs a way in at 7am. |
| Services | Their own table (`services`, stable ids), not JSON. FAQs, tone, languages and handoff rules are JSON in `business_settings`. | Bookings reference a service; renaming or deactivating one must not orphan past bookings. |
| Booking model | Wall-clock start/end in the **business timezone** (`YYYY-MM-DDTHH:MM`), duration from the service, slot grid of 30 min, **one booking at a time** (capacity 1), overlap checked inside `BEGIN IMMEDIATE`. | Matches how the tutoring business works; capacity > 1 is a later setting. |
| Reminders | Meta **template** messages (they must go outside the 24h window), quick-reply buttons with payloads `confirm:<bookingId>` / `cancel:<bookingId>`, sent by an in-process scheduler every 60 s that claims each reminder atomically. **Off by default per business.** | Templates are the only thing Meta will deliver a day later. |
| Calendar | Google Calendar over plain REST with `fetch` (no `googleapis`), OAuth per business, refresh token encrypted. Built and tested against a mock; the owner does the Google Cloud setup in the morning. | The owner's trial calendar is Google. OAuth needs a human. |
| PDF | `pdfkit`, charts drawn with its primitives. | No headless browser in production. |
| Hosting | Canadian region (owner's decision). Deployment itself is out of scope tonight; D14 makes it ready. | |

---

## 4. Architecture in one picture

```
Browser (web/, React)  --cookie wa_session-->  /api/auth/*            login, logout, me, password
                                               /api/b/:bid/*          owner or super admin, scoped
                                               /api/admin/*           super admin only
                                               /api/b/:bid/stream     SSE, subscribe(bid)
Meta  --signed-->  /webhook/b/:publicId  --> queue(bid:wa) --> handler: control=ai? --> Claude + tools
Scheduler (60 s)  --> due reminders (enabled businesses only) --> sendTemplate()
Google (mock tonight) <-- calendar sync on booking create/update/cancel (connected businesses only)
```

Middleware order for `/api`: security headers → JSON body → session → `requireAuth` →
`requireBusinessAccess` (for `/api/b/:bid`) or `requireSuperAdmin` (for `/api/admin`) → zod →
handler → audit log. Every mutating handler writes to `audit_log`.

---

## 5. The steps

**Execution order (MUST, then SHOULD, then COULD):**
`D2 → D3 → D4 → D5 → D6` · then `D7 → D9 → D10 → D12` · then `D11 → D8 → D13 → D14`.

The numbers follow the build order the owner approved. Calendar (D8) runs late on purpose:
it can't be completed without the owner's Google setup, and everything before it can.

Budgets are **relative** (in "units", roughly an hour of steady work each). If a step reaches
1.5× its budget, ship its *minimum* and move on. Realistically the MUST tier is the night's
core; everything after it is a bonus to push as far as possible.

---

### D2 — Login and roles · MUST · budget 1.5

**Database (next migration):**
`users(id, email UNIQUE COLLATE NOCASE, password_hash, role CHECK IN ('super_admin','owner'),
business_id NULL REFERENCES businesses, name, locale CHECK IN ('en','fr') DEFAULT 'en',
active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0,
created_at, last_login_at, CHECK ((role='super_admin' AND business_id IS NULL) OR
(role='owner' AND business_id IS NOT NULL)))`;
`sessions(token_hash PK, user_id REFERENCES users ON DELETE CASCADE, created_at, last_seen_at,
expires_at, ip, user_agent)`;
`audit_log(id, ts, user_id NULL, business_id NULL, action, target, detail, ip)`.

**Code:** `src/auth/{passwords,sessions,middleware,routes}.ts`, `src/store/users.ts`,
`src/store/audit.ts`. Routes: `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me` (user plus the businesses they may access), `POST /api/auth/password`.
Middleware: `requireAuth`, `requireBusinessAccess` (parses `:bid` as an integer; for an owner
of another business, **404**, not 403, so business ids can't be enumerated),
`requireSuperAdmin`, `originCheck`, security headers (CSP `default-src 'self'`,
`frame-ancestors 'none'`, nosniff, `Referrer-Policy: same-origin`).
CLI `src/cli/user.ts` (`npm run user`): `create-admin <email>`, `create-owner <email> --business
<id>`, `reset-password <email>`, `list`, `deactivate <email>`. Passwords are prompted with the
line-buffered prompter from `cli/business.ts` (reuse it: move it to `src/cli/prompt.ts`).

**Tests:** password hash and verify; wrong password; timing-safe compare; rate limit locks and
unlocks; session expiry (sliding and absolute); only the hash is stored; logout kills the
session; `must_change_password` blocks every route except `/password`; Origin check rejects a
foreign origin; **`authz.test.ts` — the route-table test:** walk the Express router stack,
collect every `/api/b/:bid/...` route, and for each method assert that (a) an anonymous
request gets 401, (b) an owner of business A requesting business B gets 404, (c) an owner of A
requesting A passes auth (any status except 401/403/404-from-authz). It must fail if any route
is added without `requireBusinessAccess`. **Mutation-test it:** remove the middleware from one
route and confirm the test goes red.

**Done when:** all of the above green; the two first accounts exist in the live database with
passwords in `data/initial-credentials.txt`.
**Minimum:** login/logout/me, sessions, both middlewares, the route-table test.

---

### D3 — Dashboard shell · MUST · budget 2

**Setup:** in `web/`, install the §3 stack at the versions shown by `npm view` (pin exact
versions in `package.json`). Tailwind 4 through `@tailwindcss/vite`, dark mode through
`@custom-variant dark (&:where(.dark, .dark *));`. Express serves `web/dist` with the SPA
fallback for any path not under `/api`, `/webhook` or `/health`.

**Screens:** Login (email, password, language toggle, error states, "change your password"
screen when forced). App layout: left **sidebar** (Overview, Inbox, Bookings, Contacts,
Settings, Reports; Admin for super admins), collapsible on desktop, a drawer on mobile with a
bottom bar for the three most-used pages; **top bar** with a business switcher (super admin
only, remembers the choice), language toggle EN/FR, theme toggle, user menu (change password,
log out). Empty placeholder pages for everything not built yet, each saying *"Coming in this
build"* in both languages.

**Design standard:** clean and modern, Inter, a restrained neutral palette with one accent,
generous spacing, 8px radius, visible focus rings, a 44px minimum touch target on mobile, no
horizontal scroll at 360px, every text in the i18n dictionaries.

**Tooling built in this step, used by every later UI step: `src/testing/screenshot.ts`.**
A screenshot driver over the Chrome DevTools Protocol using Node 24's **built-in `WebSocket`**
(no Playwright). Launch Edge with `--headless=new --remote-debugging-port=<free port>`, connect,
then `Network.setCookie` (a session minted directly in the database for a test user, so no
login bypass exists in the app), `Emulation.setDeviceMetricsOverride` (true 375px mobile
widths, which `--window-size` can't reach on Windows), `Emulation.setEmulatedMedia`
(`prefers-color-scheme`), `Page.navigate`, wait for network idle, `Page.captureScreenshot`.
Run against a **test-database server** (`.env.test` plus a free port), never the live one.
Output to the scratchpad. **Look at every screenshot.** A blank page is a failure.

**Tests:** an i18n completeness test (every key in `en` exists in `fr` and vice versa, with no
empty strings); the web typecheck (`tsc -p web`); `vite build`; screenshots of login and
layout × light/dark × 1440/375 × EN/FR.

**Minimum:** login, layout with sidebar and top bar, theme and language toggles, served by
Express.

---

### D4 — Agent settings → the system prompt · MUST · budget 1.5

**Database:** a `services(id, business_id NOT NULL, name, description, duration_min CHECK >0,
price_cents NULL, currency DEFAULT 'CAD', active, sort, created_at, updated_at)` table.
`business_settings.facts` JSON grows into a versioned **settings v2**:
`{ version: 2, about, address, contact, tone: 'friendly'|'professional'|'concise',
customToneNotes, languages: ['en','fr',...], faqs: [{q,a}] (max 50), handoff: { keywords:
string[], onAnger: bool, onAccountChange: bool, rules: string }, neverDo: string[],
reminders: { enabled: false, hoursBefore: 24, templateName: 'appointment_reminder',
templateLanguage: 'en' } }`. Migrate v1 facts in place (the old `hours` text is dropped: hours
now come only from `schedule`). Seed Ninja Co (owner's answers, 2026-09-11): services
"Robotics class" 60 min **USD 25** and "Coding class" 60 min **USD 20**. These are
**placeholder prices the owner will replace**, so flag them first in MORNING.md, because the
agent quotes prices to real customers. Languages **en, fr, ar** (the agent may reply in any
code on the list; the dashboard UI stays EN/FR). Human contact: none; the agent says someone
will follow up in the same WhatsApp chat.

**Prompt:** rewrite `buildSystemPrompt(settings, schedule, services, business)` so the **hours
text is generated from the schedule**, removing the duplication noted in `persona.ts`. Include
services with durations and prices, FAQs, tone, the language policy (reply in the customer's
language if it's in `languages`, else the default), and handoff rules. It must stay
**byte-stable**: deterministic order, no timestamps. Unit-test that. `persona.ts` shrinks to
the seed only. `get_business_info` returns the structured settings.

**API:** `GET/PUT /api/b/:bid/settings`, `GET/PUT /api/b/:bid/schedule`,
`GET/POST/PUT/DELETE /api/b/:bid/services` (DELETE deactivates if bookings reference the
service). All zod-validated with length caps. Every write goes to the audit log.

**Page:** Settings with tabs: Business (about, address, contact, timezone, default language),
Hours (seven rows, a toggle and open/close per day, copy Monday to all), Services (list plus a
modal editor), FAQs (reorderable list), Tone and language, Handoff rules, Reminders (visible,
but "Coming soon" until D7). Unsaved-changes guard; a "Preview what the agent knows" panel
showing the generated prompt facts.

**Tests:** prompt snapshot for Ninja Co; byte stability across calls; hours text matches the
schedule; validation rejects oversize and malformed input; an owner can't edit another
business (covered by `authz.test.ts`). **Minimum:** API plus prompt generation plus a single
Settings form page.

---

### D5 — Inbox with human takeover · MUST · budget 2

**Database:** `messages.sender` (`customer` | `ai` | `human` | `system`, backfilled: `in` →
customer, `out` → ai), `messages.sent_by_user_id`; `contacts.control` (`ai` | `human`,
backfilled from `paused`), `contacts.taken_over_by`, `contacts.taken_over_at`. Keep
`needs_human` / `handoff_reason`. `isPaused` becomes `control === 'human'`, and the webhook
**skips the AI reply while a human is in control** (test it end to end).

**API:** `GET /api/b/:bid/conversations?filter=all|needs_human|human|ai&q=`,
`GET /api/b/:bid/conversations/:waId/messages`, `POST .../takeover`, `POST .../reply`
(`{text}` ≤ 4096; goes through `sendText`; outside the 24h window returns **409** with a
translated explanation instead of pretending), `POST .../handback`,
`GET /api/b/:bid/stream` (SSE, `subscribe(bid)`, auth by cookie). Every takeover, reply and
handback goes to the audit log.

**Page:** a WhatsApp-style two-pane inbox: the conversation list (search, filter chips,
needs-human first, 24h-window badge, unread dot) and the thread (bubbles with `dir="auto"` so Arabic renders
right-to-left, day separators, ticks for sent / delivered / read / failed, sender label AI or
human-with-name). A **"You're in
control"** banner with "Hand back to AI"; a composer, disabled with an explanation when
outside the window. Mobile: the list, tap in, then a back arrow. Live via SSE; the scroll
position is preserved (the old UI's lesson). **Then retire the old dashboard:** delete
`ui.html`, the old `router.ts` routes and `DASHBOARD_TOKEN`, with tests updated.

**Tests:** takeover suppresses the AI (webhook e2e); a manual reply is stored as
`sender=human` with the user id; handback resumes the AI; 409 outside the window; SSE carries
only its own business (reuse the pattern from `isolation.test.ts`).
**Minimum:** list plus thread plus takeover/reply/handback working; SSE optional.

---

### D6 — Bookings v2 and the bookings page · MUST · budget 2

**Database:** rebuild `bookings` (transaction, row counts verified):
`id, business_id NOT NULL, wa_id, customer_name, service_id NULL REFERENCES services,
start_at, end_at, duration_min, status CHECK IN ('booked','confirmed','cancelled','completed',
'no_show'), source CHECK IN ('agent','owner'), notes, reminder_sent_at, confirmed_at,
cancelled_at, calendar_event_id, created_at, updated_at`. Migrate the old `slot` to
`start_at`, 60 min, `booked`, `agent`. Drop `UNIQUE(business_id, slot)`; replace it with an
**overlap check** against non-cancelled bookings inside `BEGIN IMMEDIATE`.

**Logic (`store/bookings.ts`):** slots on a 30-minute grid that fit the service duration
inside the day's hours, exclude overlaps, exclude the past (business timezone, keep
`isPastInZone`). Agent tools: `check_availability(date, service_id)`, `create_booking(service_id,
start, name, notes?)`, `list_my_bookings()`, `cancel_my_booking(booking_id)`,
`reschedule_my_booking(booking_id, start)`. Customers only ever see and change **their own**
bookings (by `wa_id` from the verified webhook, never from tool input).

**API:** `GET /api/b/:bid/bookings?from&to&status`, `POST` (the owner creates one),
`PATCH /:id` (time, service, status, notes, with an overlap check), `POST /:id/cancel`
(optional `notifyCustomer`: free-form text inside the window, otherwise skipped with a clear
message until D7 templates exist). Audit every write.

**Page:** Bookings with a week agenda view (days × times) plus a list view with filters,
status pills, a detail drawer (edit, cancel, mark completed or no-show), "New booking", and
empty states. Mobile: a day-by-day list.

**Tests:** overlap (edges, back-to-back is allowed, one-minute overlap is not); duration fits
the closing time; timezone "past"; a customer can't cancel another customer's booking; an
owner edit re-checks overlap; the migration preserves old bookings.
**Minimum:** the model, tools and API, plus a list page with cancel.

---

### D7 — Reminders and confirmations · SHOULD · budget 1.5

`sendTemplate(bid, to, name, lang, components)` in `client.ts` (templates **bypass** the 24h
guard, since that's what they're for); the mock Graph accepts template payloads. The scheduler
`src/core/scheduler.ts` runs every 60 s and, **only for businesses with
`reminders.enabled`**, claims due bookings atomically (`UPDATE ... SET reminder_sent_at=?
WHERE id=? AND reminder_sent_at IS NULL`, checking `changes === 1`), so it's restart-safe and
never sends twice. The webhook handles `button` messages: parse `confirm:<id>` /
`cancel:<id>`, verify the booking belongs to *this* business and *this* `wa_id`, update the
status, reply with a short free-form confirmation (the customer just messaged, so the window
is open), and **don't** forward it to the AI. Settings → Reminders tab becomes live (toggle,
hours before, template name and language). Write `docs/whatsapp-templates.md` with the exact
EN and FR templates to submit in Meta Business Manager (category UTILITY, body with
`{{1}}`=name, `{{2}}`=date, `{{3}}`=time, two quick-reply buttons).
**Tests:** due vs not due; disabled business sends nothing; double run sends once; a cancelled
booking is skipped; a button from the wrong `wa_id` is ignored; confirm and cancel update the
booking. **Minimum:** scheduler plus button handling, tested.

### D9 — Overview: stats and charts · SHOULD · budget 1

**Load the `dataviz` skill first.** `GET /api/b/:bid/overview?from&to` (dates in the business
timezone). Returns conversations started, messages by sender (customer / AI / human),
AI-handled share, bookings by status, human handoffs, and **response time** (the time from a
customer message to the next outbound in the same conversation, median and p90), plus daily
series. Page: stat tiles, messages-per-day (stacked AI vs human), bookings per day, a response
time trend, with date presets 7 / 30 / 90 days and a custom range. **Tests:** fixed-fixture
numbers, timezone day boundaries, empty range.

### D10 — Contacts and CSV export · SHOULD · budget 0.75

`GET /api/b/:bid/contacts?q&sort`, and `GET .../contacts.csv`: UTF-8 **with BOM** (Excel and
French accents), CRLF, **formula-injection escaping** (prefix `'` on cells starting with
`= + - @` tab or CR), audited. Page: a searchable table (name, number, first seen, last
message, messages in/out, bookings, control state), row → opens the inbox thread.
**Tests:** escaping, BOM, the export contains only this business.

### D12 — Admin panel · SHOULD · budget 1.25

Super admin only (`/api/admin/*`, covered by a route-table test mirroring `authz.test.ts`).
Clients: list (status, connected, owner, this month's usage), create, edit (name, timezone,
language), **connect credentials** (a write-only form; shows only the `redact()` form),
activate/deactivate, create an owner account (temporary password shown **once**, forced
change). Usage and billing per client per month: inbound, AI replies, human replies, template
sends, tokens in/out/cached, estimated model cost; month picker; CSV export. Audit log viewer
(filter by client, action). **Tests:** an owner gets 404 on every admin route; credentials
never appear in any admin response; usage numbers are correct on fixtures.

### D11 — Monthly PDF report · COULD · budget 1

`GET /api/b/:bid/reports/monthly?month=YYYY-MM` → `application/pdf`, in the business's
default language: header with the business name and month, summary tiles, a messages bar
chart, bookings by status, response time, handoffs. Audited. Reports page: month list plus a
download button. **Tests:** returns a valid PDF (`%PDF-` header), the right month's numbers,
French labels when the language is fr.

### D8 — Google Calendar · COULD · budget 1.5

Env `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
(`http://localhost:3001/api/google/callback`). `calendar_connections(business_id PK,
google_email, refresh_token_enc, calendar_id DEFAULT 'primary', status, connected_at,
last_error)`. Flow: `GET /api/b/:bid/google/connect` → Google consent (scopes
`calendar.events` and `calendar.freebusy`, `access_type=offline`, `prompt=consent`) with a
**signed `state`** bound to the session and business → callback exchanges the code, encrypts
the refresh token. Sync on booking create/update/cancel (non-blocking; failures logged and
shown, the booking still succeeds). Availability subtracts free/busy (a 2-minute cache).
`invalid_grant` → status `needs_reconnect`, shown in Settings (Testing-mode tokens expire
after 7 days). A mock Google server in `src/testing/mock-google.ts`. Write
`docs/google-calendar-setup.md` for the owner (create the project, consent screen in Testing,
add their trial account as a test user, create the OAuth client, paste the three env vars).
**Tests:** the state can't be forged or reused; the token is stored encrypted; create, patch
and delete are called with the right ids; free/busy removes slots; `invalid_grant` flips the
status.

### D13 — Law 25 hardening · COULD · budget 1

Per-business **retention** (months, default 24) with a nightly purge job plus a manual "run
now"; **erase a contact** (messages, bookings, contact row; audited; its own confirmation
dialog); **AI disclosure** on a first contact (setting, default on: *"You're chatting with
<business>'s automated assistant. Privacy: <url>"*, EN/FR); a privacy-policy URL setting; a
review of security headers and cookies behind a proxy (`TRUST_PROXY`, `COOKIE_SECURE`);
`npm audit` with results in MORNING. **Tests:** the purge removes only older rows of that
business; erase removes everything for that `wa_id` in that business only; the disclosure is
sent once.

### D14 — Deploy-ready · COULD · budget 0.5

`npm start` serves the built SPA plus the API; a `Dockerfile` (node:24-slim, non-root,
`/data` volume); `docs/deploy.md` for a Canadian region (a VPS in Toronto or Montréal,
HTTPS through a reverse proxy, backups of `data/` **and** `APP_ENCRYPTION_KEY` stored
separately, a Meta webhook per client). No actual deployment.

---

## 6. Verification toolkit (use, don't reinvent)

- **Mocks:** `src/testing/mock-graph.ts` (scriptable Graph responses; records path, body and
  bearer token), `webhook.ts` (signed Meta payloads, `targetFor(bid)`), fake Claude clients
  via `setClientForTesting`. Add `mock-google.ts` in D8.
- **Test DB:** `npm test` wipes `data/test.db` first (`pretest`); files run one at a time.
- **Screenshots:** `src/testing/screenshot.ts` (built in D3), against a test-DB server only.
- **Migration dry run:** `VACUUM INTO` a copy of `data/agent.db`, migrate the copy, compare
  counts per table and business, then boot for real.
- **Mutation checks:** for every scoping or authorization guard you add, break it once and
  watch the right test fail. A guard with no failing test is not protected.

---

## 7. Known traps in this codebase (each one has bitten already)

- **Windows plus Git Bash.** Big files: use the Write tool, not heredocs. In Python edits use
  raw strings, because `"\n"` inside a normal Python string becomes a real newline in the
  TypeScript file (this broke `ui.html` and `cli/business.ts`).
- **Node strip-only TypeScript** (tests run without tsx): no `enum`, no `namespace`, no
  decorators, **no constructor parameter properties**.
- `exactOptionalPropertyTypes` is on: optional fields can't be assigned `undefined` unless
  typed `| undefined`.
- **Test files run in separate processes on one shared DB.** Ids made from counters collide
  across files; the synthesizers already use a per-process `runId`, and new fixtures must too.
  Wait on the *stored row*, not the mock receiving the request.
- **SQLite:** double quotes are identifiers, not strings. `ON CONFLICT DO NOTHING` hides
  collisions silently. **`rowid` order is conversation order**, so a table rebuild must copy
  with `ORDER BY rowid`.
- **Edge headless:** the minimum window is ~490px (use CDP device metrics instead); an open
  `EventSource` keeps the page "loading" forever (capture over CDP, or use `?nostream=1`).
- **CSS:** a class with `display:` beats the `[hidden]` attribute (the old UI keeps
  `[hidden]{display:none!important}`); inline styles beat media queries.
- **Processes:** `TaskStop` on `npm run dev` leaves the `tsx watch` parent alive, and it will
  restart and **migrate the live DB** on the next file save. Kill it. The same goes for a timed-out
  `npm test`: the `node --test` runner survives `TaskStop`; find it by command line and kill it.
- **Mutation checks: restore from a copy, never `git checkout <file>`.** That also reverts the
  step's uncommitted work in the file (it wiped D5's `db.ts` changes once; they were
  recovered from the transcript). `cp file /tmp/x.bak`, mutate, `cp` back.
- **Route-walking tests and streams:** `testing/auth.ts` `call()` returns right after the
  headers of a `text/event-stream` response. Any new never-ending route must do the same, or
  `authz.test.ts` hangs.
- **Anthropic SDK 0.124:** error classes are statics on the default export; `APIError` (not
  `APIStatusError`); `APIConnectionError` extends `APIError`, so check it first. With no
  credential the SDK throws a plain `Error`.

---

## 8. Commit discipline

One commit per step, or more for big steps (`dash-5a:`, `dash-5b:`), message
`dash-<N>: <what> — <why>`, a body with the reasoning and anything surprising, ending with
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Before every commit:
`git diff --cached --name-only` must not include `.env` or `data/`, and scan the diff for
`EAA[A-Za-z0-9]{20,}` or `sk-ant-`. Commit this plan first as `dash-0: overnight plan`.

---

## 9. The morning handoff — `MORNING.md`

Rewrite `MORNING.md` at the start of the run (the old one is in git) and **update it after
every step**, so an interrupted night still leaves an accurate report. Sections:

1. **Start here** (three lines): `npm run build:web`, `npm run dev`, open
   `http://localhost:3001`, log in as `admin@example.com` with the password in
   `data/initial-credentials.txt`, and change it.
2. **What got built**, a table of steps: done / partial / not started, with one line each.
3. **How to test each finished step**: numbered clicks on real screens, plus what you should
   see. Also include how to log in as the Ninja Co owner and see that Test Clinic is
   invisible.
4. **What needs you**: `ANTHROPIC_AUTH_TOKEN`; submitting the WhatsApp templates
   (`docs/whatsapp-templates.md`) and enabling reminders; Google Calendar setup
   (`docs/google-calendar-setup.md`); prices for Ninja Co's services; backing up
   `APP_ENCRYPTION_KEY`.
5. **Known limitations and anything skipped, and why.**
6. **Bugs found in earlier work.**

---

## 10. Decision log

*(Appended during the run: every choice not already in §3, with how to reverse it.)*

- **Owner's answers before sleeping (2026-09-11):** placeholder prices ("put anything now,
  I'll change them later") — USD 25 robotics / USD 20 coding, 60 min each; agent languages
  Arabic, French, English; no human contact for handoffs; npm packages approved.
  Settings `languages` therefore accepts any ISO 639-1 code, not just en/fr.
- **D3, versions:** React Router's latest is now **8.x** and TypeScript's **7.x** (a
  native rewrite). Pinned **react-router 7.18.3** and **typescript 5.9.3** instead: the
  plan was written for Router 7, the backend already uses TS 5, and an unattended night is
  the wrong time to learn a new major API. *Reverse:* bump both in `web/package.json` and fix
  what breaks.
- **D3, port:** `.env` had `PORT=3000`, which collides with the owner's AI Lead Agent
  project. Changed to `PORT=3001`, the port used throughout. *Reverse:* set it back and
  stop the other project first.
- **D3, screenshots:** built `src/testing/screenshot.ts` on CDP with Node's built-in
  WebSocket (no Playwright), plus `npm run shots`, which runs on its own throwaway
  database (`data/shots.db`) with demo data, never the live one.
- **D4, services:** removing a service always *deactivates* it (never deletes), even before
  bookings reference services in D6 - simpler, and history-preserving. *Reverse:* a hard
  delete for services with no bookings.
- **D4, the clock:** the agent had no idea of the current date, so relative dates ("tomorrow")
  could not be resolved. Added a second system block with the business-local date and time,
  placed after the cache breakpoint so the cached prefix stays byte-stable.
- **D5, in-flight replies:** a reply the model is still writing when a person takes over is
  dropped (`humanTookOverSince`), and so is one written while the owner hits the kill switch.
  The agent's *own* hand-off message still goes out: only a takeover by a person (a
  `taken_over_by` user) cancels it. *Reverse:* remove the check in `handler.ts`.
- **D5, replying takes over:** a manual reply to a conversation the agent has first takes it
  over, or the agent would answer the customer's next message on top of the person.
- **D5, the kill switch moved** from the retired token dashboard to `PUT /api/b/:bid/agent`
  (a Pause/Resume button on Overview, with a confirmation), audited.
- **D5, the stream re-checks the session** on every 25-second heartbeat without counting as
  activity: logging out or losing access closes it, and an open tab doesn't keep a session
  alive past its 12-hour idle limit.
- **D6, times stay wall-clock strings** ("2030-01-31T10:00", business-local), with an end time
  and a duration: the timezone-correct "past" check keeps working, string order is time order
  for the overlap check, and Google Calendar accepts a wall-clock time plus a timezone as is.
- **D6, one resource:** one booking at a time per business, whoever made it; back-to-back is
  allowed. *Reverse:* a capacity per service, counted in the overlap query.
- **D6, owner vs agent rules:** the agent books on the 30-minute grid inside opening hours; an
  owner may pick any minute, even outside hours. Neither can book the past, an overlap, or past
  midnight.
- **D6, `migrate(db, target)`:** tests build a genuine older database instead of faking
  `user_version` on a new one (which re-ran migration 6 on an already-new table).
- **D6, deep links:** `?view=list`, `?open=<id>`, `?new=1` on the bookings page (also how the
  screenshots reach the drawer and the dialog).
- **D7, the kill switch also stops reminders:** "Pause agent" is what an owner hits in a hurry;
  it should mean no automatic messages at all. *Reverse:* drop the `agentEnabled` check in
  `runReminders`.
- **D7, no reminder for last-minute bookings:** skipped when the booking was made after its
  reminder time would have been. **A failed reminder stays claimed** (not retried every
  minute against a template Meta rejects); the failure is an event with Meta's error.
- **D7, button replies** are fixed sentences in en/fr/ar chosen by the template language,
  sent as `system` messages; a button for someone else's booking is ignored silently.
- **D9, charts are hand-built SVG** (no chart library): two forms, a few hundred lines, full
  control of the dataviz spec. Palette = categorical slots 1-2 (blue, orange), validated with
  the dataviz checker against the real card surfaces (#ffffff light, #18181b dark), all PASS.
- **D9, what counts:** reply time = from the first unanswered customer message to the next
  reply by the agent or a person (automatic notices don't count), capped at 24h (beyond that it
  is "unanswered"). "Bookings made" is by creation day; "appointments" by start day.
- **D10, phone numbers in the CSV are digits only** (no "+"): a leading "+" would read as a
  formula and need the apostrophe escape. The export is audited (row count, search), and is
  `Cache-Control: no-store`.
- **D12, super admins are CLI-only:** the panel manages owner accounts; a super admin can't be
  created, reset or deactivated from it (so nobody locks themselves out with one click).
  *Reverse:* allow role `super_admin` in `ownerOr404`.
- **D12, billing months follow each client's timezone**; "this month" on the Clients list is
  the UTC month.
- **D11, pdfkit 0.20.2 with built-in Helvetica** (no font files to ship; no Arabic glyphs).
  The current month is reported to date, compared with the equal-length window before it.
  `src/testing/report-preview.ts` renders and photographs a report from the demo database.
- **D8, the OAuth callback doesn't need the session cookie** (SameSite=Strict isn't sent on
  Google's cross-site redirect). A random single-use state stored server-side (business, user,
  10-minute expiry, deleted on use) carries the binding; the user must still have access at
  callback time. Mutation-tested (reuse, expiry, access).
- **D8, sync is a booking-change hook** (`onBookingChange` in bookings.ts), so every write path
  syncs; it never blocks or fails a booking. `executeTool` became async for free/busy.
- **D8, events carry service, name and notes, not the phone number** (data minimisation).
- **D5, audit holds no message text:** a manual reply is logged with its length only; the text
  already lives in the conversation, and a copy would double what an erasure request must reach.
