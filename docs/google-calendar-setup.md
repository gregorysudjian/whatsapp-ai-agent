# Setting up Google Calendar

Once per server (about ten minutes), you create a Google "OAuth client" that lets the
dashboard ask a business owner for access to their calendar. After that, each business
connects its own calendar from **Agent settings → Google Calendar** with one click.

What the dashboard asks Google for, and nothing more:

| Permission | Why |
|---|---|
| `calendar.events` | add, move and remove the events that mirror bookings |
| `calendar.freebusy` | see *when* the owner is busy (not what the events are), so the agent doesn't offer those times |
| `openid`, `email` | show which Google account is connected |

## 1. Create a project

1. Open <https://console.cloud.google.com/> with the Google account that will own the
   setup (for testing: your trial account).
2. Top bar → project picker → **New project** → name it (e.g. `WhatsApp Agent`) → **Create**,
   and make sure it is selected.

## 2. Turn on the Calendar API

**APIs & Services → Library** → search **Google Calendar API** → **Enable**.

## 3. The consent screen

**APIs & Services → OAuth consent screen** (called **Google Auth Platform → Branding /
Audience** in newer consoles):

1. User type **External** → **Create**.
2. App name (what owners will see, e.g. `Ninja Co Assistant`), support email, developer email.
   Save.
3. **Scopes** → **Add or remove scopes** → add
   `https://www.googleapis.com/auth/calendar.events` and
   `https://www.googleapis.com/auth/calendar.freebusy` (plus `openid` and `email`, which are
   usually listed already). Save.
4. **Test users** → **Add users** → add every Google account that will connect a calendar
   (your trial account). While the app is in **Testing**, only these accounts can connect.
5. Leave the publishing status on **Testing** for now.

> **Testing mode expires connections after 7 days.** Google revokes the refresh token of an
> app in Testing a week after consent. The dashboard notices ("Google stopped accepting this
> connection") and shows **Connect again** on the Google Calendar tab — one click fixes it.
> To stop this, publish the app (**Audience → Publish app**); for these two scopes Google may
> ask for verification first.

## 4. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

1. Application type **Web application**, any name.
2. **Authorized redirect URIs** → **Add URI** → exactly:
   - on your computer: `http://localhost:3001/api/google/callback`
   - once deployed: `https://<your-domain>/api/google/callback` (add both if you use both)
3. **Create**. Copy the **Client ID** and **Client secret**.

## 5. Give them to the server

Add to `.env` (never commit it):

```
GOOGLE_CLIENT_ID=123456789-abc....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3001/api/google/callback
```

The redirect URI here must match the one in step 4 character for character. Restart the
server (`npm run dev`).

## 6. Connect a business

1. Sign in to the dashboard → **Agent settings → Google Calendar** → **Connect Google Calendar**.
2. Pick the Google account (it must be a test user from step 3.4) → Google warns that the app
   isn't verified (normal in Testing) → **Continue** → allow access.
3. You land back on the tab: **Connected as you@gmail.com**.

From then on:

- a booking (from the agent or the dashboard) appears as an event in that account's main
  calendar, titled `<service> - <customer name>`, with the booking's notes. The customer's
  phone number is **not** copied to Google;
- moving or cancelling a booking updates or deletes its event; an event you delete in Google
  comes back if the booking changes again;
- times you're busy in that calendar are not offered to customers (checked live, cached for
  two minutes);
- if Google is unreachable, bookings carry on as normal and the tab shows the error.

**Disconnect** on the same tab removes the connection and asks Google to revoke it; existing
events stay in the calendar.

## Troubleshooting

| You see | Cause |
|---|---|
| "Google Calendar isn't set up on this server yet" | one of the three `GOOGLE_*` values is missing; restart after adding them |
| Google says `redirect_uri_mismatch` | `GOOGLE_REDIRECT_URI` and the URI in step 4 differ (http vs https, port, trailing slash) |
| Google says "access blocked" / "not a test user" | add that account under Test users (step 3.4) |
| "Connect again" after a week | Testing-mode expiry (see the note in step 3) |
| "The connection didn't go through" | the Connect link is valid for 10 minutes and works once; start again |
