# Good morning

This file was updated after every step of the overnight run. The plan it followed is
[plan.md](plan.md) (its section 10 logs every decision I made on my own). An earlier report is in
git history (`git show b08ac69:MORNING.md`).

**Run status:** ✅ done — every step of the plan (D2–D14) is built, tested and committed, plus fixes
from an independent code review at the end. **269 automated tests pass.** The server is running on
http://localhost:3001.

**In one paragraph:** the dashboard is complete. You sign in with your own password. Owners see
only their business. You see every business, plus an admin panel for clients, credentials, owner
accounts, usage and billing, and the audit log.

It has:
- a live WhatsApp-style **Inbox**, where a person can take a chat over from the agent and hand it back;
- **Bookings** with services, a week calendar and no double-booking;
- **Reminders** with Confirm and Cancel buttons (off until Meta approves your template);
- **Overview** charts, **Contacts** with a CSV export, and a monthly **PDF report**;
- **Google Calendar** sync (needs a 10-minute setup on your side);
- the **Québec Law 25** tools: retention, erasing a customer, and an "automated assistant" notice.

Nothing was sent to real customers tonight. Everything outside this computer was mocked in tests.

---

## 1. Start here

The server should already be running. If http://localhost:3001 doesn't open:

```
npm run build:web      # builds the dashboard
npm run dev            # starts the server on http://localhost:3001
```

Sign in as **gregory.sudjian@gmail.com** (the one-time password was given to you in chat; you choose your own at first sign-in).
You'll be asked to choose a new one first. Then delete that file.

**A 10-minute tour, in this order:** Overview → Inbox → Bookings (click an empty time to book) →
Contacts → Agent settings (every tab, including Reminders, Google Calendar and Privacy) → Reports
(download a PDF) → Admin → Clients (open Ninja Co) → Usage & billing → Audit log. Then sign out and
sign in as **owner@ninjaco.test** to see what an owner sees.

Your real database has almost no traffic yet (2 messages). The pages will look empty until
customers write in. The screenshots I checked were taken on a month of made-up demo traffic, in a
separate throwaway database.

> The server uses port **3001**, not 3000: your `.env` said 3000, which is where your
> AI Lead Agent project runs, so the two would have collided. I changed that one value.

---

## 2. What got built

| Step | What | State |
|---|---|---|
| D2 | Login and roles | ✅ done — accounts, sessions, audit log, route-table authorization test |
| D3 | Dashboard shell (sidebar, dark mode, EN/FR, mobile) | ✅ done — sign-in, forced password change, layout, overview tiles |
| D4 | Agent settings → system prompt | ✅ done — 8-tab settings page, services with prices, live prompt preview |
| D5 | Inbox with human takeover | ✅ done — live two-pane inbox, take over / reply / hand back, old token dashboard retired |
| D6 | Bookings v2 and bookings page | ✅ done — services and durations, statuses, overlap rule, customers manage their own, week/list page |
| D7 | Reminders and confirmations | ✅ done — template reminders with Confirm/Cancel buttons; off until you submit the template and switch it on |
| D9 | Overview stats and charts | ✅ done — six headline numbers with change vs the previous period, three charts, a daily table |
| D10 | Contacts and CSV export | ✅ done — searchable, sortable list; a spreadsheet-safe CSV export, audited |
| D12 | Admin panel | ✅ done — clients, WhatsApp credentials (write-only), owner accounts, usage & billing with CSV, audit log |
| D11 | Monthly PDF report | ✅ done — one page per month in the business's language; the current month is reported to date |
| D8 | Google Calendar | ✅ built and tested against a mock Google — needs your one-time Google Cloud setup to use for real |
| D13 | Law 25 hardening | ✅ done — retention with nightly clean-up, erase a customer, AI notice on first contact, header/cookie review, npm audit clean |
| D14 | Deploy-ready | ✅ done — Dockerfile, `npm start` from the build, backups, docs/deploy.md for a Canadian server (not deployed) |

---

## 3. How to test each finished step

### D2 — Login and roles
Two accounts exist in your real database; their one-time passwords are in
`data/initial-credentials.txt` (never committed, never printed in logs):
- **gregory.sudjian@gmail.com** — super admin, sees every business (replaced the first account, admin@example.com, which is now deactivated).
- **owner@ninjaco.test** — owner of Ninja Co only.

Both must change their password at first login. Until then they can see
nothing but the change-password screen.

1. `npm run user -- list` → both accounts, `mustChangePassword: yes`, `lastLogin: never`.
2. Logging in happens on the new dashboard (D3, below).
3. To manage accounts later: `npm run user -- create-owner <email> --business <id>`,
   `reset-password <email>`, `deactivate <email>`.

What protects it: passwords hashed with scrypt; sessions stored only as hashes; a
session ends after 12 idle hours or 7 days; 5 wrong passwords lock that email for 15
minutes; the same error for "wrong password" and "no such account"; a password change
logs out every other device. `src/auth/authz.test.ts` walks every dashboard route and
proves an owner of one business gets "not found" for another's — it was checked by
deliberately breaking the guard four different ways.

### D3 — The new dashboard
1. Open http://localhost:3001 → the sign-in page (EN/FR and light/dark/system toggles top right).
2. Sign in as the super admin → you must choose a new password (your first sign-in).
3. You land on **Ninja Co → Overview**: message counts, contacts, chats waiting for a person.
4. Top bar: the business switcher (only super admins see it). Sidebar footer: language,
   theme, change password, sign out. The arrow on the sidebar edge collapses it.
5. Narrow the window below ~1000px: the sidebar becomes a menu button, and a bottom bar
   appears with Overview / Messages / Bookings / More.
6. Sign out, sign in as **owner@ninjaco.test**: no switcher and no Admin section. Type
   `/b/2/overview` into the address bar → "Page not found" (that's Test Clinic, not theirs).

Pages not built yet say "Coming in this build".

### D4 — Agent settings
**Agent settings** in the sidebar. Everything here is what the agent is told; changes apply
from the next customer message.
1. **Business** — name, description, timezone (Ninja Co: Asia/Beirut), address, and the contact
   given on handoff (empty, as you chose: the agent says someone will follow up in the chat).
2. **Hours** — a switch and times per day. Ninja Co: Monday–Friday 08:00–15:00. Change one,
   press **Save changes** (the bar appears at the bottom when something changed).
3. **Services** — Robotics class and Coding class with the placeholder prices. **Edit** one;
   leave the price empty and the agent will say it doesn't have a price.
4. **FAQs**, **Tone & languages** (English, French and Arabic are on), **Handoff** rules.
5. **What the agent sees** — the exact text the agent gets, generated from all of the above.
   Change the hours, save, come back here: the hours line changes with it.

The agent now also knows today's date and time in Beirut, so "tomorrow at 10" works — it
had no way to know what day it was before. Everything is translated; a test fails if
any French string is missing, blank, or just the English pasted in.

### D5 — Inbox and human takeover
**Inbox** in the sidebar (on a phone, the bottom bar's **Messages**).
1. The list: search by name or number, filter chips (All / Needs a person / With a person / With
   the agent). Chats where the agent asked for a person are on top with an amber badge; a
   green dot means the customer spoke last.
2. Open a chat: WhatsApp-style bubbles (Arabic reads right to left), day separators, delivery
   ticks, and who wrote each outgoing message: **Agent** or the person's email / **You**.
3. **Take over** → blue banner "You're handling this conversation". From then on the agent
   stays silent in that chat (other chats are unaffected). Type a reply, press Enter.
4. **Hand back to agent** → the agent answers the next message again.
5. Replying without taking over first takes over automatically (the hint under the box says so).
6. More than 24h since the customer's last message? The reply box is replaced by an
   explanation: WhatsApp only allows approved templates then (those come with D7).
7. New messages appear by themselves ("Live" top left); if you've scrolled up to read, a
   "New messages" button appears instead of yanking you down.
8. **Overview → Pause agent** is the kill switch for every chat at once (it asks first).

To see it with real traffic you need `ANTHROPIC_AUTH_TOKEN` (for the agent's replies) and a
customer message to Ninja Co's number. **Careful:** a reply from the inbox is a real WhatsApp
message to a real customer.

The old `/dashboard?token=…` page is gone, along with `DASHBOARD_TOKEN` (you can delete that
line from `.env`; it's ignored).

### D6 — Bookings
**Bookings** in the sidebar.
1. **Week** view: a calendar of the week, times in Beirut time whatever your computer's
   timezone. Grey = closed. The red line is "now". Colours: blue booked, green confirmed,
   grey completed, red no-show (cancelled ones are hidden here).
2. Click an empty spot in the grid → **New booking** at that time. The dialog offers the free
   times for the chosen service (on the half hour, inside opening hours); "Or another time"
   lets you book any minute, even outside opening hours — only overlaps and the past are refused.
3. Click a booking → the side panel: change the name, service, date, time, status or notes and
   **Save**; quick buttons **Mark confirmed** (upcoming) or **Mark completed / no-show** (past);
   **Open the conversation** jumps to the inbox.
4. **Cancel booking** → optionally tick "Tell the customer on WhatsApp" (a message is
   pre-written). If their last message was over 24h ago, WhatsApp won't deliver it and the page
   says so — the booking is still cancelled.
5. **List** view: Upcoming / Past 90 days / Cancelled. On a phone, the week is a day-by-day list.

On WhatsApp, the agent now books a specific service (taking its length into account), and a
customer can ask to see, move or cancel **their own** bookings — never anyone else's, even with
a guessed booking number.

Rules everywhere: two bookings may touch (10:00–11:00 then 11:00–12:00) but never overlap,
whoever made them.

### D7 — Reminders and confirmations
**Off by default**, on purpose: reminders message customers who didn't write first, and
WhatsApp only delivers them once Meta has approved your template.
1. Submit the template: [docs/whatsapp-templates.md](docs/whatsapp-templates.md) has the
   exact English, French and Arabic wording and the button order, step by step.
2. When Meta shows it **Active**: **Agent settings → Reminders** → switch on, choose when
   (24 hours before by default) and the template's language, **Save**.
3. From then on, every booking with a WhatsApp number gets one reminder (never two, even if
   the server restarts), with **Confirm** and **Cancel** buttons. Tapping one updates the
   booking on the Bookings page and the customer gets a one-line answer — the AI isn't involved.
4. The tab shows a preview of what the customer receives.

Also: **Pause agent** stops reminders too; moving a booking sends a new reminder for the new
time; a booking made after its reminder time (e.g. booked last-minute) gets none.

### D9 — Overview
**Overview** (the first page after sign-in).
1. The period row: **7 / 30 / 90 days** or **Custom** (two dates, then Show). Days are Beirut
   days, whatever your computer's timezone.
2. Six numbers: new conversations, messages received, the share of replies written by the
   agent (vs your team), bookings made, conversations handed to a person, and the typical
   (median) reply time with "90% within …". Arrows compare with the previous period of the
   same length — green is better, red is worse (for reply time, faster is green).
3. Charts: replies per day (agent vs team, stacked), bookings made per day, and reply time per
   day. Hover a day (or focus a chart and use ← →) for the exact numbers.
4. Appointments in the period by status, and how many customer messages went unanswered for 24h.
5. **Daily numbers** at the bottom opens the same data as a table.
6. **Pause agent** is still at the top right.

It will look empty on your real data until customers write in — the screenshots were taken on
a month of made-up demo traffic in a throwaway database.

### D10 — Contacts
**Contacts** in the sidebar: everyone who has written to Ninja Co, with first contact, last
message, messages in/out, bookings and who's handling them. Search by name or number; click a
column title to sort; click a person to open their conversation.

**Export CSV** downloads the list (the current search and sort, headers in the dashboard's
language). It opens cleanly in Excel — accents and Arabic intact — and a customer who named
themselves `=HYPERLINK(...)` on WhatsApp can't run a formula on your computer (such cells are
defused). Every export is recorded in the audit log.

### D12 — Admin panel (super admin only)
Signed in as **gregory.sudjian@gmail.com**, the sidebar has an **Admin** section.
1. **Clients**: every business, whether its WhatsApp is connected, its owners, and this month's
   messages and model cost. **New client** creates one (name, timezone, language).
2. Click a client → its panel:
   - **Details**: name, timezone, language, and **Active** (while inactive, its WhatsApp
     messages are neither stored nor answered).
   - **WhatsApp connection**: the webhook URL to paste into that client's Meta app (with Copy),
     and a form for its phone number ID, access token, app secret and verify token. They are
     stored encrypted and never shown again — only masked (`****-one`).
   - **Owner accounts**: create one → a **temporary password is shown once** (copy it and send it
     privately; they must pick their own at first sign-in). Reset a password, deactivate an account.
3. **Usage & billing**: pick a month → per client: messages received, agent and team replies,
   template sends (reminders), tokens, and the indicative model cost, with totals and **Export CSV**.
4. **Audit log**: who did what and when, filterable by client and action.

Owners can't reach any of this: every admin address answers "not found" to them (tested for
every route, including future ones).

### D11 — Monthly report
**Reports** in the sidebar: one row per month, newest first, each with **Download PDF**. The
report is one A4 page in the business's language (Ninja Co: English; change it in Agent
settings → Business): the six headline numbers with the change against the previous period,
replies per day (agent vs team), appointments by status and reply times. The month in progress
says "to date (1 to 11)" and compares with the same number of days before it. Each download is
recorded in the audit log.

Limitation: the PDF uses the built-in Helvetica font, which has no Arabic letters — fine for the
report's own words (English/French), but a business *name* written in Arabic would not print.

### D8 — Google Calendar
**Built, not yet switched on** — it needs a Google "OAuth client", which only you can create
(about 10 minutes, once): follow [docs/google-calendar-setup.md](docs/google-calendar-setup.md),
then put the three `GOOGLE_*` values in `.env` and restart.

Then: **Agent settings → Google Calendar → Connect Google Calendar** → pick your trial account
on Google's screen → back on the tab, "Connected as …". From then on:
- every booking (agent or dashboard) appears in that calendar as `<service> - <name>`; moving or
  cancelling it updates or deletes the event;
- times you're busy in the calendar aren't offered to customers;
- if Google is down, bookings carry on and the tab shows the error;
- while the Google app is in "Testing", Google drops the connection after 7 days — the tab
  then says so, with a **Connect again** button.

Until you do the setup, the tab says "not set up on this server yet" and nothing calls Google.
Everything was tested against a stand-in Google server (connect, a link that works once and
expires, encrypted token, create/move/cancel events, busy times, revoked access).

### D13 — Privacy (Québec Law 25)
**Agent settings → Privacy**
1. **How long conversations are kept**: 24 months by default. Every night, messages, bookings
   and customers older than that are deleted (for that business only). **Run the clean-up now**
   does it on demand.
2. **Tell each new customer, once, that an automated assistant answers** — on by default. The
   notice goes right before the agent's first reply to someone, in English, French or Arabic
   (whichever their first message looks like, among the business's languages), with your
   privacy-policy link if you add one. *Your two existing live contacts haven't had it yet, so
   they'll get it once, with their next reply.* Switch it off here if you prefer.

**Contacts → bin icon** erases one customer when they ask to be forgotten: all their messages,
bookings (and the Google Calendar events), the contact, and their number in the activity log —
at this business only. It asks twice and records *that* an erasure happened, not who.

Also tightened for deployment: no `X-Powered-By` header; a Permissions-Policy; HSTS once
`COOKIE_SECURE=1`; the development origin is no longer trusted in production; expired sessions
are now actually cleaned up (they weren't); the boot log warns if production runs without
`COOKIE_SECURE=1` / `TRUST_PROXY=1`. **`npm audit`: 0 vulnerabilities** in both the server and
the dashboard.

### D14 — Ready to deploy (not deployed)
- **[docs/deploy.md](docs/deploy.md)**: a Canadian VM (Québec or Toronto), Docker, HTTPS with
  Caddy, secrets, nightly backups, and connecting each client's Meta webhook. It also flags a
  Law 25 point for your privacy policies: conversations pass through Meta and Anthropic outside
  Québec.
- `npm run build:all` then `npm start` runs the compiled server (checked tonight: health, the
  dashboard and the API answer; it no longer needs a `.env` file if the variables are set).
- `npm run backup` makes a consistent copy of the database into `data/backups/`, and the server
  now backs the database up by itself before any upgrade that changes its structure.
- The **Dockerfile** could not be test-built here (Docker isn't installed on this PC); build it
  once on the server before relying on it.

---

## 4. What needs you

1. **Replace Ninja Co's placeholder prices.** You said "put anything now": Robotics USD 25 and
   Coding USD 20 (60 min each) are made up. The agent quotes prices to real customers, so change
   them before the bot goes live: **Agent settings → Services → Edit**.
2. **Submit the reminder template to Meta** ([docs/whatsapp-templates.md](docs/whatsapp-templates.md)),
   then switch reminders on in Agent settings → Reminders.
3. **Google Calendar setup** ([docs/google-calendar-setup.md](docs/google-calendar-setup.md)), then
   connect it in Agent settings → Google Calendar.
4. **Add `ANTHROPIC_AUTH_TOKEN` to `.env`.** Until then every reply is the fallback sentence.
5. **Back up `APP_ENCRYPTION_KEY`** from `.env` somewhere outside this project.
6. **Before deploying:** read [docs/deploy.md](docs/deploy.md), and add Meta and Anthropic as data
   processors to each client's privacy policy (Law 25: conversations leave Québec through them).
7. You can delete `DASHBOARD_TOKEN` from `.env`; it's no longer used.

---

## 5. Known limitations and anything skipped

- **D5:** the inbox updates live, but a person typing a reply is not shown to other people
  looking at the same chat (no "someone is typing" or locking). Two people can both take over;
  the last one is shown as the owner.
- **Billing history shrinks with retention:** usage & billing figures (and old PDFs) are counted
  from the messages table, so months older than the retention period read lower after the
  clean-up. Export the usage CSV each month for your records; a permanent monthly total is a
  small follow-up.
- **Calendar after erasure:** if Google can't be reached when a customer is erased, the dashboard
  says how many events are left to delete by hand; it doesn't retry by itself.
- **A reminder right after a move:** a customer who moves their booking into the reminder window
  gets the reminder straight away.
- **D6:** one booking at a time per business (a single room or teacher). A business that runs
  two classes at once would need a "capacity" per service; not built.
- **D6:** the bookings page refreshes when you come back to the tab, not live while you watch it.
- **D11:** the PDF font has no Arabic letters (a business *name* in Arabic wouldn't print).
- **D14:** the Dockerfile wasn't test-built (no Docker on this PC).
- **Media / voice notes** are still not understood by the agent (it says so to the customer).

---

## 6. Bugs found in earlier work (all fixed)

- **Expired sessions were never deleted:** the clean-up function existed, but nothing called it.
  It now runs with the retention job.
- **An AI reply could land on top of a person:** if someone took a chat over while the model was
  still writing, the stale reply was sent anyway. Now it's dropped.
- **The server advertised "Express"** in every response, and trusted the development origin in
  production. Both fixed.
- **Settings tabs on a phone:** a link to a later tab didn't scroll it into view.
- **The "not connected" badge** squeezed into the phone header, where it was meant to be hidden.
- Found in tonight's own work and fixed before committing (details in the git log):
  - a time picker that loaded forever;
  - a report comparing 11 days with 30;
  - a Google error message being overwritten;
  - invisible characters in two files.
