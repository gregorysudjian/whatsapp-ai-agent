/**
 * Google Calendar for one business: connect with OAuth, mirror bookings as
 * calendar events, and keep the agent from offering times the owner is busy.
 *
 * Everything here is best-effort around the booking, never in its way: a
 * booking succeeds whether or not Google answers, a sync failure is recorded
 * and shown on the settings page, and availability falls back to the
 * dashboard's own bookings when the calendar can't be read.
 *
 * The refresh token is encrypted with the app key, bound to the business
 * (like the WhatsApp secrets). Access tokens live only in memory.
 */

import crypto from "node:crypto";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { db, recordEvent, type BusinessId } from "../store/db.ts";
import { getBusiness } from "../store/businesses.ts";
import { canAccessBusiness, getUser } from "../store/users.ts";
import { availableSlots, endOf, getBooking, onBookingChange, setCalendarEventId, wallClockNow, type Booking, type SlotQuery } from "../store/bookings.ts";
import { getService } from "../store/services.ts";
import { addDays, startOfDay } from "../store/overview.ts";
import { decrypt, encrypt } from "../security/crypto.ts";

const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");
const STATE_TTL_MS = 10 * 60_000;
const BUSY_CACHE_MS = 2 * 60_000;

export function googleConfigured(): boolean {
  const g = config.google;
  return Boolean(g.clientId && g.clientSecret && g.redirectUri);
}

export class CalendarError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

// --- the stored connection ---------------------------------------------------------

interface Connection {
  businessId: BusinessId;
  email: string | null;
  refreshToken: string;
  calendarId: string;
  status: "connected" | "needs_reconnect";
  connectedAt: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

const tokenContext = (bid: BusinessId) => `business:${getBusiness(bid)!.publicId}:google_refresh_token`;

const getConnStmt = db.prepare(`SELECT * FROM calendar_connections WHERE business_id = ?`);
const upsertConnStmt = db.prepare(`
  INSERT INTO calendar_connections (business_id, google_email, refresh_token_enc, calendar_id, status, connected_at, last_sync_at, last_error)
  VALUES (?, ?, ?, 'primary', 'connected', ?, NULL, NULL)
  ON CONFLICT(business_id) DO UPDATE SET google_email = excluded.google_email, refresh_token_enc = excluded.refresh_token_enc,
    status = 'connected', connected_at = excluded.connected_at, last_error = NULL
`);
const deleteConnStmt = db.prepare(`DELETE FROM calendar_connections WHERE business_id = ?`);
const statusStmt = db.prepare(`UPDATE calendar_connections SET status = ?, last_error = ? WHERE business_id = ?`);
const syncedStmt = db.prepare(`UPDATE calendar_connections SET last_sync_at = ?, last_error = NULL WHERE business_id = ?`);
const syncErrorStmt = db.prepare(`UPDATE calendar_connections SET last_error = ? WHERE business_id = ?`);

function getConnection(bid: BusinessId): Connection | undefined {
  const r = getConnStmt.get(bid) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    businessId: bid,
    email: r["google_email"] == null ? null : String(r["google_email"]),
    refreshToken: decrypt(config.security.encryptionKey, String(r["refresh_token_enc"]), tokenContext(bid)),
    calendarId: String(r["calendar_id"]),
    status: r["status"] === "needs_reconnect" ? "needs_reconnect" : "connected",
    connectedAt: Number(r["connected_at"]),
    lastSyncAt: r["last_sync_at"] == null ? null : Number(r["last_sync_at"]),
    lastError: r["last_error"] == null ? null : String(r["last_error"]),
  };
}

export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
  status: "not_connected" | "connected" | "needs_reconnect";
  email: string | null;
  calendarId: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
}

/** For the settings page. Never includes a token. */
export function calendarStatus(bid: BusinessId): CalendarStatus {
  const c = getConnection(bid);
  return {
    configured: googleConfigured(),
    connected: c?.status === "connected",
    status: c ? c.status : "not_connected",
    email: c?.email ?? null,
    calendarId: c?.calendarId ?? null,
    lastSyncAt: c?.lastSyncAt ?? null,
    lastError: c?.lastError ?? null,
  };
}

/** Google said the grant is gone: stop trying, and tell the owner. */
function needsReconnect(bid: BusinessId, reason: string): void {
  accessTokens.delete(bid);
  busyCache.forEach((_, k) => { if (k.startsWith(`${bid}:`)) busyCache.delete(k); });
  statusStmt.run("needs_reconnect", reason.slice(0, 300), bid);
  log.warn("calendar_needs_reconnect", { businessId: bid, reason });
  recordEvent(bid, "warn", "calendar_needs_reconnect", { reason: reason.slice(0, 300) });
}

// --- OAuth ---------------------------------------------------------------------------

const insertStateStmt = db.prepare(`INSERT INTO oauth_states (nonce, business_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`);
const takeStateStmt = db.prepare(`DELETE FROM oauth_states WHERE nonce = ? RETURNING business_id, user_id, expires_at`);
const purgeStatesStmt = db.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`);

/** Hash of a state, as kept in the browser-binding cookie (never the state itself). */
export const stateBinding = (state: string) => crypto.createHash("sha256").update(state).digest("base64url");

/**
 * The Google consent URL for this business, with a fresh single-use state.
 * The caller also gives the browser a cookie holding the state's hash
 * (stateBinding), which the callback requires: a consent link copied and sent
 * to someone else is then useless, because their browser lacks the cookie.
 */
export function startConnect(bid: BusinessId, userId: number, now: number = Date.now()): string {
  if (!googleConfigured()) throw new CalendarError("not_configured");
  purgeStatesStmt.run(now);
  const nonce = crypto.randomBytes(24).toString("base64url");
  insertStateStmt.run(nonce, bid, userId, now, now + STATE_TTL_MS);
  const url = new URL(config.google.authUrl);
  url.search = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: "code",
    scope: SCOPES,
    // offline + consent: Google only hands out a refresh token when asked for
    // one on a consent screen, and without it the connection dies in an hour.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: nonce,
  }).toString();
  return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(config.google.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new CalendarError(String(json["error"] ?? `token_http_${res.status}`), String(json["error_description"] ?? ""));
  return json;
}

/**
 * The callback's work. The state is the only thing trusted: it names the
 * business and the person who clicked "Connect", exists only if we created
 * it, and is deleted on first use.
 *
 * (The session cookie cannot be required here: it is SameSite=Strict, and a
 * redirect back from accounts.google.com is a cross-site navigation, so the
 * browser does not send it. The state carries that binding instead.)
 */
export async function finishConnect(code: string, state: string, binding: string | undefined, now: number = Date.now()): Promise<{ businessId: BusinessId; userId: number }> {
  if (!googleConfigured()) throw new CalendarError("not_configured");
  // The same browser that clicked Connect: its cookie holds this state's hash.
  const expected = typeof state === "string" ? stateBinding(state) : "";
  if (!binding || binding.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(binding), Buffer.from(expected))) {
    throw new CalendarError("wrong_browser");
  }
  const row = typeof state === "string" && state.length <= 100
    ? takeStateStmt.get(state) as { business_id: number; user_id: number; expires_at: number } | undefined
    : undefined;
  if (!row) throw new CalendarError("bad_state");
  if (row.expires_at < now) throw new CalendarError("expired_state");
  const bid = Number(row.business_id);
  const user = getUser(Number(row.user_id));
  if (!user || !canAccessBusiness(user, bid)) throw new CalendarError("bad_state");

  const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config.google.redirectUri });
  const refresh = typeof tokens["refresh_token"] === "string" ? tokens["refresh_token"] : "";
  const access = typeof tokens["access_token"] === "string" ? tokens["access_token"] : "";
  if (!refresh || !access) throw new CalendarError("no_refresh_token");

  const who: { email?: string } = await fetch(`${config.google.apiBase}/oauth2/v3/userinfo`, { headers: { authorization: `Bearer ${access}` } })
    .then((r) => (r.ok ? r.json() as Promise<{ email?: string }> : {}))
    .catch(() => ({}));

  upsertConnStmt.run(bid, who.email ?? null, encrypt(config.security.encryptionKey, refresh, tokenContext(bid)), now);
  accessTokens.set(bid, { token: access, expiresAt: now + Number(tokens["expires_in"] ?? 3600) * 1000 - 60_000 });
  log.info("calendar_connected", { businessId: bid });
  recordEvent(bid, "info", "calendar_connected");
  return { businessId: bid, userId: user.id };
}

export async function disconnect(bid: BusinessId): Promise<void> {
  const c = getConnection(bid);
  deleteConnStmt.run(bid);
  accessTokens.delete(bid);
  if (c) {
    // Best effort: tell Google to forget the grant too.
    await fetch(config.google.revokeUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: c.refreshToken }),
    }).catch(() => undefined);
  }
  recordEvent(bid, "info", "calendar_disconnected");
}

// --- calling the API --------------------------------------------------------------------

const accessTokens = new Map<BusinessId, { token: string; expiresAt: number }>();

async function accessToken(bid: BusinessId, c: Connection): Promise<string> {
  const cached = accessTokens.get(bid);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refreshToken });
    const token = String(t["access_token"] ?? "");
    accessTokens.set(bid, { token, expiresAt: Date.now() + Number(t["expires_in"] ?? 3600) * 1000 - 60_000 });
    return token;
  } catch (err) {
    if (err instanceof CalendarError && err.code === "invalid_grant") {
      needsReconnect(bid, "Google no longer accepts this connection (access was revoked or expired). Connect again.");
    }
    throw err;
  }
}

/** One authenticated call; a 401 refreshes the access token and tries once more. */
async function gapi(bid: BusinessId, c: Connection, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(bid, c);
    const res = await fetch(`${config.google.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && attempt === 0) { accessTokens.delete(bid); continue; }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  throw new CalendarError("unauthorized");
}

// --- bookings -> events --------------------------------------------------------------------

function eventFor(b: Booking, tz: string) {
  // "24:00" is our end-of-day; Google wants the next day's midnight.
  const end = b.end.endsWith("T24:00") ? `${addDays(b.end.slice(0, 10), 1)}T00:00` : b.end;
  return {
    summary: `${b.serviceName ?? "Booking"} - ${b.customerName ?? "customer"}`,
    // Kept to what the owner needs at a glance; the phone number stays in the dashboard.
    description: [`Booked ${b.source === "agent" ? "by the WhatsApp agent" : "from the dashboard"} (booking #${b.id}).`, b.notes && `Notes: ${b.notes}`]
      .filter(Boolean).join("\n"),
    start: { dateTime: `${b.start}:00`, timeZone: tz },
    end: { dateTime: `${end}:00`, timeZone: tz },
    extendedProperties: { private: { whatsappAgentBookingId: String(b.id) } },
  };
}

/**
 * Make the calendar match the booking: create, update, or (when cancelled)
 * delete its event. Errors are recorded on the connection, never thrown at
 * the booking.
 */
export async function syncBooking(bid: BusinessId, b: Booking): Promise<void> {
  const c = getConnection(bid);
  if (!c || c.status !== "connected" || !googleConfigured()) return;
  const tz = getBusiness(bid)?.timezone ?? "UTC";
  const events = `/calendar/v3/calendars/${encodeURIComponent(c.calendarId)}/events`;
  try {
    if (b.status === "cancelled") {
      if (b.calendarEventId) {
        const r = await gapi(bid, c, "DELETE", `${events}/${encodeURIComponent(b.calendarEventId)}`);
        // 404/410: already gone from the calendar - which is where we wanted it.
        if (r.status >= 300 && r.status !== 404 && r.status !== 410) throw new CalendarError(`delete_${r.status}`);
        setCalendarEventId(bid, b.id, null);
      }
    } else if (b.calendarEventId) {
      const r = await gapi(bid, c, "PATCH", `${events}/${encodeURIComponent(b.calendarEventId)}`, eventFor(b, tz));
      if (r.status === 404 || r.status === 410) {
        // The owner deleted it in Google; the booking still stands, so put it back.
        const created = await gapi(bid, c, "POST", events, eventFor(b, tz));
        if (created.status >= 300) throw new CalendarError(`insert_${created.status}`);
        setCalendarEventId(bid, b.id, String(created.json["id"]));
      } else if (r.status >= 300) throw new CalendarError(`patch_${r.status}`);
    } else {
      const r = await gapi(bid, c, "POST", events, eventFor(b, tz));
      if (r.status >= 300) throw new CalendarError(`insert_${r.status}`);
      setCalendarEventId(bid, b.id, String(r.json["id"]));
    }
    syncedStmt.run(Date.now(), bid);
    busyCache.forEach((_, k) => { if (k.startsWith(`${bid}:`)) busyCache.delete(k); });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("calendar_sync_failed", { businessId: bid, bookingId: b.id, err: message });
    // A lost grant has already said what to do ("connect again"); keep that message.
    if (!(err instanceof CalendarError && err.code === "invalid_grant")) {
      syncErrorStmt.run(`Booking #${b.id}: ${message}`.slice(0, 300), bid);
    }
    recordEvent(bid, "warn", "calendar_sync_failed", { bookingId: b.id, error: message.slice(0, 200) });
  }
}

/**
 * Delete one event now and say whether it worked (gone already counts).
 * For erasure, where the booking row no longer exists to retry from.
 */
export async function deleteEvent(bid: BusinessId, eventId: string): Promise<boolean> {
  const c = getConnection(bid);
  if (!c || c.status !== "connected" || !googleConfigured()) return false;
  try {
    const r = await gapi(bid, c, "DELETE", `/calendar/v3/calendars/${encodeURIComponent(c.calendarId)}/events/${encodeURIComponent(eventId)}`);
    return r.status < 300 || r.status === 404 || r.status === 410;
  } catch {
    return false;
  }
}

/**
 * Is the owner busy in Google between start and start + duration? For
 * bookings the agent makes: availability already hides busy times, but a
 * model can still ask for a time it was never offered. Unreadable calendar:
 * not a conflict (a Google outage must not stop bookings).
 */
export async function calendarConflict(bid: BusinessId, start: string, durationMin: number): Promise<boolean> {
  try {
    const end = endOf(start, durationMin) ?? `${start.slice(0, 10)}T24:00`;
    const busy = await busyOn(bid, start.slice(0, 10));
    return busy.some(([bs, be]) => bs < end && be > start);
  } catch {
    return false;
  }
}

/** In-flight syncs, so tests (and shutdown) can wait for them. */
const pending = new Set<Promise<void>>();
export function calendarIdle(): Promise<void> {
  return Promise.all([...pending]).then(() => undefined);
}

/** The last sync queued for each booking: syncs of one booking run in order. */
const chains = new Map<string, Promise<void>>();

let started = false;
/** Wire booking changes to the calendar. Called once at boot (and by tests). */
export function startCalendarSync(): void {
  if (started) return;
  started = true;
  onBookingChange((bid, booking) => {
    const key = `${bid}:${booking.id}`;
    // After the previous sync of this booking, with the booking as it is THEN:
    // a create still waiting on Google must have saved its event id before a
    // cancel or a move looks for it, or the event is orphaned or duplicated.
    const p = (chains.get(key) ?? Promise.resolve())
      .then(() => {
        const fresh = getBooking(bid, booking.id);
        return fresh ? syncBooking(bid, fresh) : undefined;
      })
      .finally(() => {
        pending.delete(p);
        if (chains.get(key) === p) chains.delete(key);
      });
    chains.set(key, p);
    pending.add(p);
  });
}

// --- free/busy -> availability --------------------------------------------------------------

const busyCache = new Map<string, { at: number; busy: [string, string][] }>();

/** The owner's busy times on a business-local date, as wall-clock [start, end) pairs. */
export async function busyOn(bid: BusinessId, date: string): Promise<[string, string][]> {
  const c = getConnection(bid);
  if (!c || c.status !== "connected" || !googleConfigured()) return [];
  const key = `${bid}:${date}`;
  const hit = busyCache.get(key);
  if (hit && Date.now() - hit.at < BUSY_CACHE_MS) return hit.busy;
  const tz = getBusiness(bid)?.timezone ?? "UTC";
  const r = await gapi(bid, c, "POST", "/calendar/v3/freeBusy", {
    timeMin: new Date(startOfDay(date, tz)).toISOString(),
    timeMax: new Date(startOfDay(addDays(date, 1), tz)).toISOString(),
    timeZone: tz,
    items: [{ id: c.calendarId }],
  });
  if (r.status >= 300) throw new CalendarError(`freebusy_${r.status}`);
  const cal = (r.json["calendars"] as Record<string, { busy?: { start: string; end: string }[] }> | undefined)?.[c.calendarId];
  const busy = (cal?.busy ?? []).map((x) => [wallClockNow(tz, Date.parse(x.start)), wallClockNow(tz, Date.parse(x.end))] as [string, string]);
  busyCache.set(key, { at: Date.now(), busy });
  return busy;
}

/**
 * The store's free slots, minus anything the owner's calendar says is busy.
 * If the calendar can't be read, the store's answer stands - a Google outage
 * must not stop bookings.
 */
export async function availableSlotsWithCalendar(bid: BusinessId, date: string, q: SlotQuery = {}): Promise<string[]> {
  const slots = availableSlots(bid, date, q);
  if (slots.length === 0) return slots;
  let busy: [string, string][];
  try {
    busy = await busyOn(bid, date);
  } catch (err) {
    log.warn("calendar_freebusy_failed", { businessId: bid, err: String(err) });
    return slots;
  }
  if (busy.length === 0) return slots;
  const duration = q.serviceId !== undefined ? getService(bid, q.serviceId)?.durationMin ?? 60 : q.durationMin ?? 60;
  return slots.filter((s) => {
    const e = endOf(s, duration) ?? `${s.slice(0, 10)}T24:00`;
    return !busy.some(([bs, be]) => bs < e && be > s);
  });
}

/** Tests only: forget cached access tokens and busy times, as a restart would. */
export function forgetCalendarCaches(): void {
  accessTokens.clear();
  busyCache.clear();
}
