# Good morning

This file is updated after every step of the overnight run, so it is accurate even if the run
stopped early. The plan it followed is [plan.md](plan.md). Last night's earlier report is in
git history (`git show b08ac69:MORNING.md`).

**Run status:** 🔄 in progress — started 2026-09-11.

---

## 1. Start here

```
npm run build:web      # builds the dashboard (once, and after each update)
npm run dev            # starts the server on http://localhost:3001
```

Open **http://localhost:3001** and sign in as **admin@example.com** with the
password in `data/initial-credentials.txt`. You'll be asked to choose a new one first.
Then delete that file.

> The server now uses port **3001**, not 3000: your `.env` said 3000, which is where your
> AI Lead Agent project runs, so the two would have collided. I changed that one value.

---

## 2. What got built

| Step | What | State |
|---|---|---|
| D2 | Login and roles | ✅ done — accounts, sessions, audit log, route-table authorization test |
| D3 | Dashboard shell (sidebar, dark mode, EN/FR, mobile) | ✅ done — sign-in, forced password change, layout, overview tiles |
| D4 | Agent settings → system prompt | not started |
| D5 | Inbox with human takeover | not started |
| D6 | Bookings v2 and bookings page | not started |
| D7 | Reminders and confirmations | not started |
| D9 | Overview stats and charts | not started |
| D10 | Contacts and CSV export | not started |
| D12 | Admin panel | not started |
| D11 | Monthly PDF report | not started |
| D8 | Google Calendar | not started |
| D13 | Law 25 hardening | not started |
| D14 | Deploy-ready | not started |

---

## 3. How to test each finished step

### D2 — Login and roles
Two accounts exist in your real database; their one-time passwords are in
`data/initial-credentials.txt` (never committed, never printed in logs):
- **admin@example.com** — super admin, sees every business.
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

Pages not built yet say "Coming in this build". Everything is translated; a test fails if
any French string is missing, blank, or just the English pasted in.

---

## 4. What needs you

1. **Replace Ninja Co's placeholder prices.** You said "put anything now": Robotics USD 25 and
   Coding USD 20 (60 min each) are made up. The agent quotes prices to real customers, so change
   them before the bot goes live.
2. **Add `ANTHROPIC_AUTH_TOKEN` to `.env`.** Until then every reply is the fallback sentence.
3. **Back up `APP_ENCRYPTION_KEY`** from `.env` somewhere outside this project.

---

## 5. Known limitations and anything skipped

*(Filled in as the run goes.)*

---

## 6. Bugs found in earlier work

*(Filled in as the run goes.)*
