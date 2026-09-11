# Deploying in Canada

One small server runs everything: the WhatsApp webhook, the agent, the dashboard and its
database. Nothing here has been deployed yet — this is the recipe.

## 1. Where

Pick a data centre in Canada, ideally Québec for Law 25 (the database holds your clients'
customers' conversations):

| Provider | Canadian regions | Notes |
|---|---|---|
| OVHcloud | Beauharnois, Québec (BHS) | inexpensive VPS, Québec-based data centre |
| DigitalOcean | Toronto (TOR1) | simple droplets |
| AWS Lightsail / EC2 | Canada Central — Montréal (`ca-central-1`) | |
| Azure | Canada East — Québec City; Canada Central — Toronto | |

A 1 vCPU / 1–2 GB RAM Linux VM (Ubuntu 24.04) is plenty for a handful of clients.

> **Where the data goes besides your server.** The database stays in Canada, but each
> conversation is also processed by **Meta** (WhatsApp Cloud API) and each agent reply by
> **Anthropic** (Claude API), both outside Québec/Canada. Law 25 asks for a privacy impact
> assessment before personal information leaves Québec, and for the privacy policy to say so.
> Mention both processors in each client's privacy policy (the link you set in Agent settings →
> Privacy is sent to customers with the first-contact notice).

## 2. The server

```bash
# on the VM, as a sudo user
sudo apt update && sudo apt install -y docker.io caddy
sudo usermod -aG docker $USER   # log out and in again
```

Point a domain at the VM (an `A` record, e.g. `agent.example.ca`).

## 3. Secrets

Create `/srv/agent/.env` (readable by you only: `chmod 600`):

```
APP_ENCRYPTION_KEY=...        # the SAME key as today - see below
ANTHROPIC_AUTH_TOKEN=...
COOKIE_SECURE=1               # cookies only over HTTPS
TRUST_PROXY=1                 # real client IPs from Caddy, for the login throttle
GOOGLE_CLIENT_ID=...          # optional, see docs/google-calendar-setup.md
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://agent.example.ca/api/google/callback
```

**`APP_ENCRYPTION_KEY` must be the key the database was created with.** Every WhatsApp token
and Google connection is encrypted with it; a new key makes them unreadable. Keep a copy in a
password manager, **separately from the database backups** — whoever holds both holds
everything.

## 4. Run it

```bash
git clone <your repo> /srv/agent/app && cd /srv/agent/app
docker build -t whatsapp-agent .
docker run -d --name agent --restart unless-stopped \
  -p 127.0.0.1:3001:3001 --env-file /srv/agent/.env \
  -v agent-data:/data whatsapp-agent
docker logs -f agent          # "server_started", one "business" line per client
```

Bound to `127.0.0.1` on purpose: only Caddy talks to it.

Moving an existing install: stop the old server, run `npm run backup`, copy the newest
`data/backups/agent-*.db` into the volume as `agent.db`
(`docker cp agent-....db agent:/data/agent.db`, then `docker restart agent`).

## 5. HTTPS

`/etc/caddy/Caddyfile`:

```
agent.example.ca {
  reverse_proxy 127.0.0.1:3001
}
```

`sudo systemctl reload caddy` — Caddy fetches and renews the certificate itself. With
`COOKIE_SECURE=1` the app also sends HSTS, so browsers stay on HTTPS.

## 6. First sign-in

```bash
docker exec -it agent node dist/cli/user.js bootstrap     # first super admin, if the DB is new
```

Then open `https://agent.example.ca`, sign in, and add clients from **Admin → Clients**.

## 7. Each client's WhatsApp number

In **Admin → Clients → (client)**: paste the client's phone number ID, access token, app secret
and a verify token of your choosing. The panel shows that client's **webhook URL**
(`https://agent.example.ca/webhook/b/<id>`). In the client's Meta app → WhatsApp →
Configuration → Webhook: paste that URL and the same verify token, **Verify and save**, then
subscribe to the **messages** field. Send a test message; it appears in the client's Inbox.

Each client has its own URL, so one client's traffic can never be read as another's.

## 8. Backups

The app copies the database automatically before any upgrade that changes its structure
(`/data/backups/agent-before-schema-*.db`). For daily backups, a cron job on the VM:

```bash
# /etc/cron.d/agent-backup - 03:15 every night, keep 30 days
15 3 * * * root docker exec agent node dist/cli/backup.js && \
  docker cp agent:/data/backups /srv/agent/backups-latest && \
  find /srv/agent/backups-latest -name 'agent-*.db' -mtime +30 -delete
```

Copy `/srv/agent/backups-latest` off the server too (another Canadian region or provider). The
backups hold personal information: store them encrypted. The nightly retention clean-up does not
reach into backups, so old ones must be deleted on schedule (the job above keeps 30 days), or an
erased customer lives on in last month's copy.

To restore: `docker stop agent`, copy the backup over `/data/agent.db`, `docker start agent`.

## 9. Updating

```bash
cd /srv/agent/app && git pull
docker build -t whatsapp-agent . && docker rm -f agent && docker run ... (same command as step 4)
```

Schema changes run at start, after the automatic backup. Check `docker logs agent`.

## Checklist

- [ ] VM in a Canadian region, domain pointing at it
- [ ] `.env` with the original `APP_ENCRYPTION_KEY`, `COOKIE_SECURE=1`, `TRUST_PROXY=1`
- [ ] `APP_ENCRYPTION_KEY` stored in a password manager, apart from the backups
- [ ] Caddy serving HTTPS; `http://` redirects
- [ ] nightly backups copied off the server
- [ ] each client's Meta webhook verified and subscribed to `messages`
- [ ] each client's privacy policy mentions Meta and Anthropic as processors
- [ ] Google OAuth redirect URI updated to the HTTPS address (if Calendar is used)
