/**
 * The owner's side of bookings: create, move, change, cancel - every path
 * through the one overlap rule - plus the customer notice on cancel.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness, setSchedule, setWhatsappCredentials } from "../store/businesses.ts";
import { createService } from "../store/services.ts";
import { recordInbound } from "../store/db.ts";
import { listMessages } from "../store/queries.ts";
import { listAudit } from "../store/audit.ts";
import { wallClockNow } from "../store/bookings.ts";

const graph = new MockGraph();
let server: Server;
let base: string;
let A: number;
let B: number;
let owner: TestUser;
let ownerB: TestUser;
let hour: number; // 60-minute service
let half: number; // 30-minute service
let bService: number;
/** A day comfortably in the future, in the business's own zone. */
let D: string;
let D2: string;

before(async () => {
  A = createBusiness({ name: "Bookings Studio", timezone: "America/Toronto" }).id;
  B = createBusiness({ name: "Bookings Neighbour" }).id;
  const allWeek = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "09:00", close: "17:00" }]));
  setSchedule(A, allWeek);
  setSchedule(B, allWeek);
  setWhatsappCredentials(A, {
    phoneNumberId: "555555555555501", accessToken: "bookings-a-access-token-0000",
    appSecret: "bookings-a-secret-00000", verifyToken: "bookings-a-verify",
  });
  hour = createService(A, { name: "Lesson", durationMin: 60, priceCents: 2500, currency: "USD" }).id;
  half = createService(A, { name: "Check-in", durationMin: 30, priceCents: null, currency: "USD" }).id;
  bService = createService(B, { name: "Other", durationMin: 60, priceCents: null, currency: "CAD" }).id;
  D = wallClockNow("America/Toronto", Date.now() + 10 * 86_400_000).slice(0, 10);
  D2 = wallClockNow("America/Toronto", Date.now() + 11 * 86_400_000).slice(0, 10);
  owner = await makeUser("owner", A);
  ownerB = await makeUser("owner", B);

  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await graph.close();
  await new Promise((r) => server.close(r));
});

const api = (path: string, opts: Parameters<typeof call>[2] = {}) =>
  call(base, `/api/b/${A}${path}`, { cookie: owner.cookie, ...opts });

async function create(start: string, extra: Record<string, unknown> = {}) {
  return api("/bookings", { method: "POST", body: { customerName: "Client", serviceId: hour, start, ...extra } });
}
const idOf = (res: { json: Record<string, unknown> }) => Number((res.json["booking"] as Record<string, unknown>)["id"]);

// --- the overlap rule, at its edges ------------------------------------------------

test("back-to-back bookings are fine; a one-minute overlap is not", async () => {
  const first = await create(`${D}T10:00`);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const b = first.json["booking"] as Record<string, unknown>;
  assert.equal(b["end"], `${D}T11:00`);
  assert.equal(b["source"], "owner");
  assert.equal(b["status"], "booked");

  assert.equal((await create(`${D}T11:00`)).status, 201, "starting exactly when another ends is allowed");
  assert.equal((await create(`${D}T09:00`)).status, 201, "ending exactly when another starts is allowed");

  const clash = await create(`${D}T10:59`, { serviceId: half });
  assert.equal(clash.status, 409);
  assert.equal(clash.json["error"], "taken");
  assert.equal((await create(`${D}T08:31`, { serviceId: hour })).json["error"], "taken", "08:31-09:31 runs into 09:00");
});

test("an owner may book off the grid and outside opening hours, but never the past or past midnight", async () => {
  assert.equal((await create(`${D}T18:05`, { serviceId: half })).status, 201, "the owner knows about exceptions");
  const late = await create(`${D}T23:30`);
  assert.equal(late.status, 409);
  assert.equal(late.json["error"], "closed", "a booking may not run past midnight");
  const past = await create("2020-01-01T10:00");
  assert.equal(past.status, 409);
  assert.equal(past.json["error"], "past");
});

test("input is validated: shape, fields, and the service belonging to this business", async () => {
  assert.equal((await create("tomorrow at ten")).status, 400);
  assert.equal((await create(`${D}T25:00`)).json["error"], "malformed");
  assert.equal((await create(`${D}T12:00`, { serviceId: bService })).json["error"], "no_service", "B's service is not A's");
  assert.equal((await create(`${D}T12:00`, { rogue: true })).status, 400, "unknown fields are refused");
  assert.equal((await create(`${D}T12:00`, { waId: "not-a-number" })).status, 400);
  const noName = await api("/bookings", { method: "POST", body: { customerName: "  ", serviceId: hour, start: `${D}T12:00` } });
  assert.equal(noName.status, 400);
});

// --- changes re-check the rule ---------------------------------------------------------

test("moving a booking re-checks overlap and recomputes its end", async () => {
  const a = idOf(await create(`${D2}T09:00`));
  const b = idOf(await create(`${D2}T11:00`));

  const onto = await api(`/bookings/${b}`, { method: "PATCH", body: { start: `${D2}T09:30` } });
  assert.equal(onto.status, 409, "cannot be moved on top of another booking");

  const ok = await api(`/bookings/${b}`, { method: "PATCH", body: { start: `${D2}T13:15` } });
  assert.equal(ok.status, 200);
  assert.equal((ok.json["booking"] as Record<string, unknown>)["end"], `${D2}T14:15`);

  const self = await api(`/bookings/${a}`, { method: "PATCH", body: { start: `${D2}T09:30` } });
  assert.equal(self.status, 200, "a booking never collides with its own old time");
});

test("changing the service changes the length, and that is checked too", async () => {
  const short = idOf(await create(`${D2}T15:00`, { serviceId: half }));
  await create(`${D2}T15:30`, { serviceId: half });
  const longer = await api(`/bookings/${short}`, { method: "PATCH", body: { serviceId: hour } });
  assert.equal(longer.status, 409, "60 minutes from 15:00 runs into the 15:30 booking");
  const b = (await api(`/bookings/${short}`, { method: "PATCH", body: { notes: "bring a laptop", status: "confirmed" } })).json["booking"] as Record<string, unknown>;
  assert.equal(b["durationMin"], 30);
  assert.equal(b["notes"], "bring a laptop");
  assert.equal(b["status"], "confirmed");
  assert.ok(typeof b["confirmedAt"] === "number");
});

test("cancelling frees the time; reviving it re-checks", async () => {
  const day = wallClockNow("America/Toronto", Date.now() + 12 * 86_400_000).slice(0, 10);
  const id = idOf(await create(`${day}T10:00`));
  const cancel = await api(`/bookings/${id}/cancel`, { method: "POST", body: {} });
  assert.equal(cancel.status, 200);
  assert.equal((cancel.json["booking"] as Record<string, unknown>)["status"], "cancelled");

  const slots = await api(`/bookings/slots?date=${day}&serviceId=${hour}`);
  assert.ok((slots.json["slots"] as string[]).includes(`${day}T10:00`), "the cancelled time is offered again");

  assert.equal((await create(`${day}T10:00`)).status, 201, "and someone else can take it");
  const revive = await api(`/bookings/${id}`, { method: "PATCH", body: { status: "booked" } });
  assert.equal(revive.status, 409, "reviving onto a time now taken is refused");
});

// --- the customer notice on cancel ---------------------------------------------------------

test("cancel can tell the customer inside the 24h window, and says why when it cannot", async () => {
  const wa = "15558880001";
  recordInbound(A, {
    id: `wamid.bookings-${Date.now()}`, from: wa, text: "hi", senderName: "Nadia",
    timestamp: new Date(), raw: { type: "text" },
  } as Parameters<typeof recordInbound>[1]);
  const day = wallClockNow("America/Toronto", Date.now() + 13 * 86_400_000).slice(0, 10);

  const id = idOf(await create(`${day}T10:00`, { waId: wa }));
  graph.reset();
  const res = await api(`/bookings/${id}/cancel`, { method: "POST", body: { notify: true, message: "Sorry Nadia, we have to cancel Tuesday." } });
  assert.equal(res.json["notified"], true);
  assert.deepEqual(graph.sentTexts, ["Sorry Nadia, we have to cancel Tuesday."]);
  assert.equal(listMessages(A, wa).at(-1)?.sender, "human");

  const noPhone = idOf(await create(`${day}T12:00`));
  const r2 = await api(`/bookings/${noPhone}/cancel`, { method: "POST", body: { notify: true, message: "x" } });
  assert.equal(r2.json["notifyError"], "no_whatsapp");
  assert.equal((r2.json["booking"] as Record<string, unknown>)["status"], "cancelled", "the cancellation stands anyway");

  const stale = "15558880002";
  recordInbound(A, {
    id: `wamid.bookings-old-${Date.now()}`, from: stale, text: "hi", senderName: "Old",
    timestamp: new Date(Date.now() - 3 * 86_400_000), raw: { type: "text" },
  } as Parameters<typeof recordInbound>[1]);
  const old = idOf(await create(`${day}T14:00`, { waId: stale }));
  graph.reset();
  const r3 = await api(`/bookings/${old}/cancel`, { method: "POST", body: { notify: true, message: "x" } });
  assert.equal(r3.json["notifyError"], "window_closed");
  assert.equal(graph.sentTexts.length, 0);
});

// --- reads, scope, audit ----------------------------------------------------------------

test("the list filters by date and status, and gives 'now' in the business's zone", async () => {
  const all = await api(`/bookings?from=${D}&to=${D}`);
  const starts = (all.json["bookings"] as Record<string, unknown>[]).map((b) => String(b["start"]));
  assert.ok(starts.length >= 4 && starts.every((s) => s.startsWith(D)));
  assert.deepEqual(starts, [...starts].sort(), "in time order");
  assert.match(String(all.json["now"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(all.json["timezone"], "America/Toronto");

  const cancelled = await api(`/bookings?status=cancelled`);
  assert.ok((cancelled.json["bookings"] as Record<string, unknown>[]).every((b) => b["status"] === "cancelled"));
  assert.equal((await api(`/bookings?from=yesterday`)).status, 400);
});

test("another business's booking cannot be seen, changed or cancelled", async () => {
  const mine = idOf(await create(`${wallClockNow("America/Toronto", Date.now() + 14 * 86_400_000).slice(0, 10)}T10:00`));
  const asB = (path: string, opts: Parameters<typeof call>[2] = {}) => call(base, `/api/b/${B}${path}`, { cookie: ownerB.cookie, ...opts });
  assert.equal((await asB(`/bookings/${mine}`, { method: "PATCH", body: { notes: "hijacked" } })).status, 404);
  assert.equal((await asB(`/bookings/${mine}/cancel`, { method: "POST", body: {} })).status, 404);
  const list = (await asB(`/bookings`)).json["bookings"] as unknown[];
  assert.equal(list.length, 0);
  const still = (await api(`/bookings?status=booked`)).json["bookings"] as Record<string, unknown>[];
  assert.ok(still.some((b) => b["id"] === mine && b["notes"] === ""));
});

test("every booking write is audited", () => {
  const actions = new Set(listAudit(A).filter((r) => r.userId === owner.user.id).map((r) => r.action));
  for (const a of ["booking_created", "booking_updated", "booking_cancelled"]) assert.ok(actions.has(a), `missing ${a}`);
});
