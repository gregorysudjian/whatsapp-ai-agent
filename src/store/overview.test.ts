/**
 * The Overview's numbers, on a fixture small enough to count by hand.
 * The business is in Tokyo (UTC+9, no daylight saving) so day boundaries sit
 * at 15:00 UTC: exactly where a server-clock bug would misfile messages.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness } from "./businesses.ts";
import { db } from "./db.ts";
import { overview, startOfDay } from "./overview.ts";

let T: number; // Tokyo
let O: number; // another business, same times - must never leak in
let owner: TestUser;
let server: Server;
let base: string;

const Z = (iso: string) => Date.parse(iso);
let n = 0;
const insertMessage = db.prepare(`INSERT INTO messages (id, business_id, wa_id, direction, type, text, ts, sender) VALUES (?, ?, ?, ?, 'text', 'x', ?, ?)`);
const insertContact = db.prepare(`INSERT OR IGNORE INTO contacts (business_id, wa_id, first_seen, inbound_count, outbound_count) VALUES (?, ?, ?, 0, 0)`);
const insertBooking = db.prepare(`INSERT INTO bookings (business_id, start_at, end_at, duration_min, status, source, created_at, updated_at) VALUES (?, ?, ?, 60, ?, ?, ?, ?)`);
const insertEvent = db.prepare(`INSERT INTO events (business_id, ts, level, name) VALUES (?, ?, 'info', ?)`);

function msg(bid: number, wa: string, dir: "in" | "out", iso: string, sender: "customer" | "ai" | "human" | "system") {
  insertMessage.run(`ov-${bid}-${++n}`, bid, wa, dir, Z(iso), sender);
}

function seed(bid: number) {
  // Tokyo Jan 1 00:00 is Dec 31 15:00 UTC.
  insertContact.run(bid, "8100000000", Z("2029-12-31T14:59:00Z")); // Dec 31 23:59 Tokyo: the previous period
  msg(bid, "8100000000", "in", "2029-12-31T14:59:00Z", "customer");

  insertContact.run(bid, "8100000001", Z("2029-12-31T16:00:00Z")); // Jan 1 01:00 Tokyo
  msg(bid, "8100000001", "in", "2029-12-31T16:00:00Z", "customer"); // never answered

  insertContact.run(bid, "8100000002", Z("2030-01-01T01:00:00Z")); // Jan 1 10:00
  msg(bid, "8100000002", "in", "2030-01-01T01:00:00Z", "customer");
  msg(bid, "8100000002", "out", "2030-01-01T01:00:30Z", "ai"); // 30 s
  msg(bid, "8100000002", "in", "2030-01-01T02:00:00Z", "customer");
  msg(bid, "8100000002", "in", "2030-01-01T02:01:00Z", "customer"); // same wait, not a new one
  msg(bid, "8100000002", "out", "2030-01-01T02:03:00Z", "system"); // an automatic notice is no answer
  msg(bid, "8100000002", "out", "2030-01-01T02:05:00Z", "human"); // 5 min from 02:00

  insertContact.run(bid, "8100000003", Z("2030-01-01T15:30:00Z")); // Jan 2 00:30 Tokyo
  msg(bid, "8100000003", "in", "2030-01-01T15:30:00Z", "customer");
  msg(bid, "8100000003", "out", "2030-01-01T15:32:00Z", "ai"); // 2 min

  insertContact.run(bid, "8100000004", Z("2030-01-03T01:00:00Z")); // Jan 3
  msg(bid, "8100000004", "in", "2030-01-03T01:00:00Z", "customer"); // unanswered

  insertBooking.run(bid, "2030-01-02T10:00", "2030-01-02T11:00", "confirmed", "agent", Z("2030-01-01T01:01:00Z"), 0);
  insertBooking.run(bid, "2030-01-03T10:00", "2030-01-03T11:00", "cancelled", "owner", Z("2030-01-02T03:00:00Z"), 0);
  insertBooking.run(bid, "2030-02-01T10:00", "2030-02-01T11:00", "booked", "agent", Z("2029-12-01T00:00:00Z"), 0); // outside both

  insertEvent.run(bid, Z("2030-01-01T02:02:00Z"), "handoff_requested");
  insertEvent.run(bid, Z("2030-01-01T02:04:00Z"), "taken_over");
}

before(async () => {
  T = createBusiness({ name: "Overview Tokyo", timezone: "Asia/Tokyo" }).id;
  O = createBusiness({ name: "Overview Other", timezone: "Asia/Tokyo" }).id;
  seed(T);
  seed(O);
  seed(O); // twice as much traffic next door
  owner = await makeUser("owner", T);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise((r) => server.close(r)); });

test("a business-local day starts at its own midnight", () => {
  assert.equal(startOfDay("2030-01-01", "Asia/Tokyo"), Z("2029-12-31T15:00:00Z"));
  // Toronto springs forward on 2030-03-10; the day still starts at local midnight.
  assert.equal(startOfDay("2030-03-10", "America/Toronto"), Z("2030-03-10T05:00:00Z"));
  assert.equal(startOfDay("2030-03-11", "America/Toronto"), Z("2030-03-11T04:00:00Z"));
});

test("totals over a range, counted by hand", () => {
  const o = overview(T, "2030-01-01", "2030-01-03");
  assert.deepEqual(o.range, { from: "2030-01-01", to: "2030-01-03", timezone: "Asia/Tokyo", days: 3 });
  const t = o.totals;
  assert.equal(t.conversationsStarted, 4);
  assert.equal(t.inbound, 6);
  assert.equal(t.aiReplies, 2);
  assert.equal(t.humanReplies, 1);
  assert.equal(t.systemMessages, 1);
  assert.equal(t.aiShare, 2 / 3);
  assert.equal(t.bookingsMade, 2);
  assert.equal(t.bookingsByAgent, 1);
  assert.equal(t.handoffs, 1);
  assert.equal(t.takeovers, 1);
  // Answered waits: 30 s, 2 min, 5 min (the notice at 02:03 does not count as an answer).
  assert.equal(t.responseMedianMs, 120_000);
  assert.equal(t.responseP90Ms, 300_000);
  assert.equal(t.unanswered, 2);
  assert.deepEqual(o.bookingsByStatus, { booked: 0, confirmed: 1, completed: 0, no_show: 0, cancelled: 1 });
});

test("each message lands on the business's day, not the server's", () => {
  const o = overview(T, "2030-01-01", "2030-01-03");
  const [d1, d2, d3] = o.daily;
  assert.deepEqual(d1, { date: "2030-01-01", conversations: 2, inbound: 4, ai: 1, human: 1, bookings: 1, responseMedianMs: 30_000 });
  assert.deepEqual(d2, { date: "2030-01-02", conversations: 1, inbound: 1, ai: 1, human: 0, bookings: 1, responseMedianMs: 120_000 },
    "15:30 UTC on Jan 1 is Jan 2 in Tokyo");
  assert.deepEqual(d3, { date: "2030-01-03", conversations: 1, inbound: 1, ai: 0, human: 0, bookings: 0, responseMedianMs: null });
});

test("the previous period is the same length, just before", () => {
  const o = overview(T, "2030-01-01", "2030-01-03");
  assert.equal(o.previous.inbound, 1, "Dec 31 23:59 Tokyo");
  assert.equal(o.previous.conversationsStarted, 1);
  assert.equal(o.previous.aiShare, null, "no replies at all is 'no share', not 0%");
});

test("an empty range is zeros and nulls, not errors", () => {
  const o = overview(T, "2031-06-01", "2031-06-07");
  assert.equal(o.daily.length, 7);
  assert.equal(o.totals.inbound, 0);
  assert.equal(o.totals.responseMedianMs, null);
  assert.equal(o.totals.aiShare, null);
});

test("the API scopes to the business and validates the range", async () => {
  const res = await call(base, `/api/b/${T}/overview?from=2030-01-01&to=2030-01-03`, { cookie: owner.cookie });
  assert.equal(res.status, 200);
  assert.equal((res.json["totals"] as Record<string, number>)["inbound"], 6, "the neighbour's traffic is not counted");

  const def = await call(base, `/api/b/${T}/overview`, { cookie: owner.cookie });
  assert.equal((def.json["range"] as Record<string, number>)["days"], 30, "defaults to the last 30 days");

  for (const q of ["from=2030-01-05&to=2030-01-01", "from=2028-01-01&to=2030-01-01", "from=yesterday"]) {
    const bad = await call(base, `/api/b/${T}/overview?${q}`, { cookie: owner.cookie });
    assert.equal(bad.status, 400, q);
  }
  const other = await call(base, `/api/b/${O}/overview`, { cookie: owner.cookie });
  assert.equal(other.status, 404);
});
