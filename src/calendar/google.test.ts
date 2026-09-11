/**
 * Google Calendar, against the mock in src/testing/mock-google.ts: connecting
 * with a state that works once, a refresh token stored only encrypted,
 * bookings mirrored as events (create, move, cancel), the owner's busy time
 * kept out of availability, and a revoked grant surfacing as "reconnect".
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGoogle } from "../testing/mock-google.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness, setSchedule } from "../store/businesses.ts";
import { createService } from "../store/services.ts";
import { db } from "../store/db.ts";
import { createBooking, getBooking, updateBooking, wallClockNow } from "../store/bookings.ts";
import { listAudit } from "../store/audit.ts";
import { setUserActive } from "../store/users.ts";
import {
  availableSlotsWithCalendar, calendarIdle, calendarStatus, finishConnect, forgetCalendarCaches, startCalendarSync, startConnect,
} from "./google.ts";

const google = new MockGoogle();
let server: Server;
let base: string;
let G: number; // connected to Google
let N: number; // never connected
let owner: TestUser;
let svc: number;
const REFRESH = "refresh-token-secret-0123456789";
let day: string;

before(async () => {
  G = createBusiness({ name: "Calendar Clinic", timezone: "UTC" }).id;
  N = createBusiness({ name: "No Calendar Shop", timezone: "UTC" }).id;
  const allWeek = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "08:00", close: "18:00" }]));
  setSchedule(G, allWeek);
  setSchedule(N, allWeek);
  svc = createService(G, { name: "Consultation", durationMin: 60, priceCents: null, currency: "CAD" }).id;
  createService(N, { name: "Visit", durationMin: 60, priceCents: null, currency: "CAD" });
  owner = await makeUser("owner", G);
  day = wallClockNow("UTC", Date.now() + 5 * 86_400_000).slice(0, 10);

  await google.listen(4598);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  startCalendarSync();
});

after(async () => {
  await calendarIdle();
  await google.close();
  await new Promise((r) => server.close(r));
});

beforeEach(() => google.reset());

/** The whole connect flow, the way a browser does it. Returns the callback's redirect. */
async function connect(code: string, email = "owner@gmail.test", refreshToken = REFRESH) {
  const start = await call(base, `/api/b/${G}/google/connect`, { method: "POST", cookie: owner.cookie, body: {} });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const url = new URL(String(start.json["url"]));
  google.codes.set(code, { email, refreshToken });
  const state = url.searchParams.get("state")!;
  // No cookie: the browser doesn't send a SameSite=Strict cookie on Google's redirect back.
  const res = await fetch(`${base}/api/google/callback?code=${code}&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  return { url, state, status: res.status, location: res.headers.get("location") ?? "" };
}

// --- connecting ---------------------------------------------------------------------------

test("connecting: the consent URL asks for offline access, and the callback stores the account", async () => {
  const r = await connect("code-1");
  assert.equal(r.url.searchParams.get("access_type"), "offline");
  assert.equal(r.url.searchParams.get("prompt"), "consent");
  assert.match(r.url.searchParams.get("scope")!, /calendar\.events/);
  assert.match(r.url.searchParams.get("scope")!, /calendar\.freebusy/);
  assert.equal(r.url.searchParams.get("client_id"), "test-google-client-id");
  assert.equal(r.status, 303);
  assert.equal(r.location, `/b/${G}/settings?tab=calendar&google=connected`);

  const st = calendarStatus(G);
  assert.equal(st.status, "connected");
  assert.equal(st.email, "owner@gmail.test");
  assert.ok(listAudit(G).some((a) => a.action === "calendar_connected" && a.userId === owner.user.id));
});

test("the refresh token is stored encrypted and never returned", async () => {
  const raw = JSON.stringify(db.prepare(`SELECT * FROM calendar_connections WHERE business_id = ?`).get(G));
  assert.ok(!raw.includes(REFRESH), "encrypted at rest");
  const res = await call(base, `/api/b/${G}/google`, { cookie: owner.cookie });
  assert.equal((res.json["calendar"] as Record<string, unknown>)["status"], "connected");
  assert.ok(!JSON.stringify(res.json).includes(REFRESH));
});

test("a state works once, can't be invented, and expires", async () => {
  const first = await connect("code-2");
  assert.equal(first.status, 303);
  google.codes.set("code-3", { email: "x@gmail.test", refreshToken: "other-refresh-00000000" });
  const again = await fetch(`${base}/api/google/callback?code=code-3&state=${encodeURIComponent(first.state)}`, { redirect: "manual" });
  assert.equal(again.headers.get("location"), "/?google=bad_state", "the same state twice is refused");

  const forged = await fetch(`${base}/api/google/callback?code=code-3&state=made-up-state`, { redirect: "manual" });
  assert.equal(forged.headers.get("location"), "/?google=bad_state");

  const old = new URL(startConnect(G, owner.user.id, Date.now() - 11 * 60_000)).searchParams.get("state")!;
  await assert.rejects(finishConnect("code-3", old), /expired_state/);

  // A state made for someone who has since lost access is worthless too.
  const other = await makeUser("owner", G);
  const theirs = new URL(startConnect(G, other.user.id)).searchParams.get("state")!;
  setUserActive(other.user.id, false);
  await assert.rejects(finishConnect("code-3", theirs), /bad_state/);
  assert.equal(calendarStatus(G).email, "owner@gmail.test", "nothing was overwritten by any of that");
});

test("an owner can't start a connection for another business", async () => {
  const res = await call(base, `/api/b/${N}/google/connect`, { method: "POST", cookie: owner.cookie, body: {} });
  assert.equal(res.status, 404);
  assert.equal(calendarStatus(N).status, "not_connected");
});

// --- bookings -> events ---------------------------------------------------------------------

test("a booking becomes an event; moving it patches the event; cancelling deletes it", async () => {
  const made = createBooking(G, { waId: "15550001234", customerName: "Ana", serviceId: svc, start: `${day}T10:00`, source: "owner", notes: "first visit" });
  assert.ok(made.ok, JSON.stringify(made));
  await calendarIdle();
  const inserts = google.calendarCalls().filter((c) => c.method === "POST" && c.path === "/calendar/v3/calendars/primary/events");
  assert.equal(inserts.length, 1);
  const ev = inserts[0]!.body as { summary: string; description: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string } };
  assert.equal(ev.summary, "Consultation - Ana");
  assert.deepEqual(ev.start, { dateTime: `${day}T10:00:00`, timeZone: "UTC" });
  assert.equal(ev.end.dateTime, `${day}T11:00:00`);
  assert.match(ev.description, /first visit/);
  assert.ok(!ev.description.includes("15550001234"), "the phone number stays in the dashboard");
  const id = made.ok ? made.booking.id : 0;
  const eventId = getBooking(G, id)!.calendarEventId!;
  assert.match(eventId, /^evt\d+$/);

  google.requests.length = 0; // the log only; the event must still exist in "Google"
  updateBooking(G, id, { start: `${day}T14:00` }, "owner");
  await calendarIdle();
  const patch = google.calendarCalls().find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, `/calendar/v3/calendars/primary/events/${eventId}`);
  assert.equal((patch.body["start"] as { dateTime: string }).dateTime, `${day}T14:00:00`);

  updateBooking(G, id, { status: "cancelled" }, "owner");
  await calendarIdle();
  assert.ok(google.calendarCalls().some((c) => c.method === "DELETE" && c.path.endsWith(`/events/${eventId}`)),
    JSON.stringify(google.calendarCalls().map((c) => `${c.method} ${c.path}`)));
  assert.equal(getBooking(G, id)!.calendarEventId, null);
});

test("an event deleted in Google comes back when the booking changes", async () => {
  const made = createBooking(G, { waId: null, customerName: "Ben", serviceId: svc, start: `${day}T08:00`, source: "owner" });
  assert.ok(made.ok);
  await calendarIdle();
  const id = made.ok ? made.booking.id : 0;
  google.events.clear(); // the owner deleted it in Google Calendar
  updateBooking(G, id, { notes: "still coming" }, "owner");
  await calendarIdle();
  assert.ok(google.calendarCalls().some((c) => c.method === "POST"), "re-created");
  assert.ok(google.events.has(getBooking(G, id)!.calendarEventId!));
});

test("when Google fails, the booking still stands and the error is shown", async () => {
  google.failNext = 500;
  const made = createBooking(G, { waId: null, customerName: "Cy", serviceId: svc, start: `${day}T12:00`, source: "owner" });
  assert.ok(made.ok, "the booking never waits on Google");
  await calendarIdle();
  assert.match(calendarStatus(G).lastError ?? "", /insert_500/);
  assert.equal(getBooking(G, made.ok ? made.booking.id : 0)!.calendarEventId, null);
});

test("a business without a calendar makes no Google calls", async () => {
  const made = createBooking(N, { waId: null, customerName: "Di", serviceId: Number((db.prepare(`SELECT id FROM services WHERE business_id = ?`).get(N) as { id: number }).id), start: `${day}T10:00`, source: "owner" });
  assert.ok(made.ok);
  await calendarIdle();
  assert.equal(google.calendarCalls().length, 0);
});

// --- busy time -------------------------------------------------------------------------------

test("the owner's busy time is not offered, and free/busy is cached for two minutes", async () => {
  forgetCalendarCaches();
  const quiet = wallClockNow("UTC", Date.now() + 9 * 86_400_000).slice(0, 10);
  google.busy = [{ start: `${quiet}T10:15:00Z`, end: `${quiet}T11:00:00Z` }];
  const slots = await availableSlotsWithCalendar(G, quiet, { serviceId: svc });
  assert.ok(!slots.includes(`${quiet}T10:00`), "overlaps the busy block");
  assert.ok(!slots.includes(`${quiet}T09:30`), "a 60-minute slot running into it is out too");
  assert.ok(slots.includes(`${quiet}T09:00`) && slots.includes(`${quiet}T11:00`), "touching it is fine");
  const fb = google.requests.filter((r) => r.path === "/calendar/v3/freeBusy");
  assert.equal(fb.length, 1);
  assert.deepEqual(fb[0]!.body["items"], [{ id: "primary" }]);

  await availableSlotsWithCalendar(G, quiet, { serviceId: svc });
  assert.equal(google.requests.filter((r) => r.path === "/calendar/v3/freeBusy").length, 1, "served from the cache");
});

test("if free/busy can't be read, bookings still work from the dashboard's own calendar", async () => {
  forgetCalendarCaches();
  const d = wallClockNow("UTC", Date.now() + 10 * 86_400_000).slice(0, 10);
  google.failNext = 503;
  const slots = await availableSlotsWithCalendar(G, d, { serviceId: svc });
  assert.ok(slots.length > 10);
});

// --- losing access ----------------------------------------------------------------------------

test("a revoked grant flips the connection to 'reconnect' and stops calling Google", async () => {
  forgetCalendarCaches();
  google.revoked.add(REFRESH);
  const made = createBooking(G, { waId: null, customerName: "Ed", serviceId: svc, start: `${day}T16:00`, source: "owner" });
  assert.ok(made.ok);
  await calendarIdle();
  const st = calendarStatus(G);
  assert.equal(st.status, "needs_reconnect");
  assert.match(st.lastError ?? "", /Connect again/);
  google.reset();
  createBooking(G, { waId: null, customerName: "Flo", serviceId: svc, start: `${day}T17:00`, source: "owner" });
  await calendarIdle();
  assert.equal(google.requests.length, 0, "no more calls until the owner reconnects");

  const again = await connect("code-9", "owner@gmail.test", "fresh-refresh-token-0000000");
  assert.equal(again.status, 303);
  assert.equal(calendarStatus(G).status, "connected", "connecting again repairs it");
});

test("disconnecting forgets the account and revokes the grant", async () => {
  const res = await call(base, `/api/b/${G}/google`, { method: "DELETE", cookie: owner.cookie });
  assert.equal(res.status, 200);
  assert.equal((res.json["calendar"] as Record<string, unknown>)["status"], "not_connected");
  assert.ok(google.requests.some((r) => r.path === "/revoke" && r.form["token"] === "fresh-refresh-token-0000000"));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM calendar_connections WHERE business_id = ?`).get(G)!["n"], 0);
});
