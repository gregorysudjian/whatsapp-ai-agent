/**
 * Law 25: retention deletes only what is old, only for its own business;
 * erasing a customer removes everything about that number at one business
 * and nothing at another; the "you're talking to an automated assistant"
 * notice goes out exactly once.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { deliver, targetFor, textMessagePayload, type Target } from "../testing/webhook.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { setClientForTesting, type MessagesClient } from "../agent/claude.ts";
import { createBusiness, setWhatsappCredentials } from "./businesses.ts";
import { getSettings, setSettings } from "./settings.ts";
import { db } from "./db.ts";
import { listAudit, audit } from "./audit.ts";
import { cutoffFor, purgeBusiness } from "./privacy.ts";

const graph = new MockGraph();
let server: Server;
let base: string;
let P: number; // 6-month retention
let Q: number; // default 24 months, and the same customer as P
let D: number; // connected, for the disclosure
let target: Target;
let owner: TestUser;

const fakeModel = {
  messages: {
    stream: () => ({
      finalMessage: async () => ({
        id: "m", type: "message", role: "assistant", model: "claude-opus-5",
        content: [{ type: "text", text: "agent reply", citations: [] }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      }),
    }),
  },
} as unknown as MessagesClient;

const NOW = Date.now();
const MONTH = 30 * 86_400_000;
let n = 0;
const msg = db.prepare(`INSERT INTO messages (id, business_id, wa_id, direction, type, text, ts, sender) VALUES (?, ?, ?, 'in', 'text', 'x', ?, 'customer')`);
const contact = db.prepare(`INSERT INTO contacts (business_id, wa_id, first_seen, last_message_ts, inbound_count, outbound_count) VALUES (?, ?, ?, ?, 1, 0)`);
const event = db.prepare(`INSERT INTO events (business_id, ts, level, name, detail) VALUES (?, ?, 'info', 'x', ?)`);
const booking = db.prepare(`INSERT INTO bookings (business_id, wa_id, start_at, end_at, duration_min, created_at, updated_at) VALUES (?, ?, ?, ?, 60, 1, 1)`);
const count = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...(args as never[])) as { n: number }).n);

function seed(bid: number, wa: string, ageMs: number) {
  const t = NOW - ageMs;
  contact.run(bid, wa, t, t);
  msg.run(`priv-${bid}-${++n}`, bid, wa, t);
  event.run(bid, t, JSON.stringify({ waId: wa }));
  const day = new Date(t).toISOString().slice(0, 10);
  booking.run(bid, wa, `${day}T10:00`, `${day}T11:00`);
}

before(async () => {
  P = createBusiness({ name: "Privacy Six", timezone: "UTC" }).id;
  Q = createBusiness({ name: "Privacy Default", timezone: "UTC" }).id;
  D = createBusiness({ name: "Disclosure Studio" }).id;
  setSettings(P, { ...getSettings(P), privacy: { retentionMonths: 6, aiDisclosure: true, privacyUrl: "" } });
  setWhatsappCredentials(D, { phoneNumberId: "888888888888801", accessToken: "disclosure-access-token-0000", appSecret: "disclosure-secret-000000", verifyToken: "disclosure-verify" });
  setSettings(D, { ...getSettings(D), languages: ["en", "fr", "ar"], privacy: { retentionMonths: 24, aiDisclosure: true, privacyUrl: "https://example.test/privacy" } });
  target = targetFor(D);
  owner = await makeUser("owner", P);

  seed(P, "15140000001", 8 * MONTH); // old at P
  seed(P, "15140000002", 1 * MONTH); // recent at P
  seed(Q, "15140000001", 8 * MONTH); // the same old customer at Q: inside Q's 24 months

  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  setClientForTesting(fakeModel);
});

after(async () => {
  setClientForTesting(undefined);
  await graph.close();
  await new Promise((r) => server.close(r));
});

test("retention deletes what is older than the business's period, and nothing else", () => {
  assert.ok(cutoffFor(6, NOW) < NOW - 5 * MONTH && cutoffFor(6, NOW) > NOW - 7 * MONTH);
  const counts = purgeBusiness(P, NOW);
  assert.deepEqual(counts, { messages: 1, events: 1, bookings: 1, contacts: 1 });
  assert.equal(count(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND wa_id = '15140000001'`, P), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND wa_id = '15140000002'`, P), 1, "recent kept");
  assert.equal(count(`SELECT COUNT(*) AS n FROM contacts WHERE business_id = ?`, P), 1);

  assert.deepEqual(purgeBusiness(Q, NOW), { messages: 0, events: 0, bookings: 0, contacts: 0 }, "8 months is inside Q's 24");
  assert.equal(count(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ?`, Q), 1, "P's purge never touched Q");
});

test("'run now' purges this business and is audited", async () => {
  const res = await call(base, `/api/b/${P}/privacy/purge`, { method: "POST", cookie: owner.cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json["retentionMonths"], 6);
  assert.ok(listAudit(P).some((a) => a.action === "retention_purge_run"));
});

test("erasing a customer removes everything about that number here, and nothing at another business", async () => {
  const wa = "15140000002";
  audit({ userId: owner.user.id, businessId: P, action: "conversation_taken_over", target: wa });
  const bad = await call(base, `/api/b/${P}/contacts/${wa}/erase`, { method: "POST", cookie: owner.cookie, body: {} });
  assert.equal(bad.status, 400, "the body must confirm");

  seed(Q, wa, MONTH); // the same person at Q
  const res = await call(base, `/api/b/${P}/contacts/${wa}/erase`, { method: "POST", cookie: owner.cookie, body: { confirm: true } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json["erased"], { messages: 1, bookings: 1, events: 1, contact: true });
  for (const table of ["messages", "contacts", "bookings"]) {
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ? AND wa_id = ?`, P, wa), 0, table);
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ? AND wa_id = ?`, Q, wa), 1, `${table} at Q untouched`);
  }
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE business_id = ? AND detail LIKE ?`, P, `%${wa}%`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM audit_log WHERE business_id = ? AND target = ?`, P, wa), 0, "the number is gone from the audit trail");
  const erased = listAudit(P).find((a) => a.action === "contact_erased")!;
  assert.equal(erased.target, "…0002", "the erasure is recorded without the number");

  const again = await call(base, `/api/b/${P}/contacts/${wa}/erase`, { method: "POST", cookie: owner.cookie, body: { confirm: true } });
  assert.equal(again.status, 404);
});

test("a number that only has bookings (the owner booked someone who phoned) can be erased too", async () => {
  const wa = "15140000077";
  booking.run(P, wa, "2030-01-01T10:00", "2030-01-01T11:00");
  const res = await call(base, `/api/b/${P}/contacts/${wa}/erase`, { method: "POST", cookie: owner.cookie, body: { confirm: true } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((res.json["erased"] as Record<string, unknown>)["bookings"], 1);
});

test("erasing a number leaves the events of a longer number that contains it", async () => {
  event.run(P, NOW, JSON.stringify({ waId: "151400000991" }));
  contact.run(P, "15140000099", NOW, NOW);
  await call(base, `/api/b/${P}/contacts/15140000099/erase`, { method: "POST", cookie: owner.cookie, body: { confirm: true } });
  assert.equal(count(`SELECT COUNT(*) AS n FROM events WHERE business_id = ? AND detail LIKE '%151400000991%'`, P), 1);
});

test("privacy settings are validated", async () => {
  for (const privacy of [{ retentionMonths: 0, aiDisclosure: true, privacyUrl: "" }, { retentionMonths: 12, aiDisclosure: true, privacyUrl: "javascript:alert(1)" }]) {
    const res = await call(base, `/api/b/${P}/settings`, { method: "PUT", cookie: owner.cookie, body: { settings: { ...getSettings(P), privacy } } });
    assert.equal(res.status, 400, JSON.stringify(privacy));
  }
  // A settings document saved before privacy existed still loads, with the defaults.
  db.prepare(`UPDATE business_settings SET facts = json_remove(facts, '$.privacy') WHERE business_id = ?`).run(Q);
  assert.deepEqual(getSettings(Q).privacy, { retentionMonths: 24, aiDisclosure: true, privacyUrl: "" });
});

// --- the notice -----------------------------------------------------------------------------

async function say(from: string, text: string) {
  await deliver(base, textMessagePayload(text, { from, phoneNumberId: target.phoneNumberId }), target);
  await new Promise((r) => setTimeout(r, 250));
}

test("a new customer is told once that an automated assistant answers", async () => {
  graph.reset();
  await say("15149990001", "Hello, are you open Saturday?");
  assert.equal(graph.sentTexts.length, 2);
  assert.match(graph.sentTexts[0]!, /Disclosure Studio's automated assistant.*Privacy: https:\/\/example\.test\/privacy/);
  assert.equal(graph.sentTexts[1], "agent reply");
  graph.reset();
  await say("15149990001", "And Sunday?");
  assert.deepEqual(graph.sentTexts, ["agent reply"], "only once");
});

test("the notice follows the customer's language when the business speaks it", async () => {
  graph.reset();
  await say("15149990002", "Bonjour, vous êtes ouverts samedi ?");
  assert.match(graph.sentTexts[0]!, /^Bonjour ! Vous discutez avec l'assistant automatisé/);
  graph.reset();
  await say("15149990003", "مرحبا، هل أنتم مفتوحون يوم السبت؟");
  assert.match(graph.sentTexts[0]!, /المساعد الآلي/);
});

test("with the notice turned off, nothing extra is sent", async () => {
  setSettings(D, { ...getSettings(D), privacy: { ...getSettings(D).privacy, aiDisclosure: false } });
  graph.reset();
  await say("15149990004", "hi");
  assert.deepEqual(graph.sentTexts, ["agent reply"]);
});

test("security headers: no framework banner, a permissions policy, HSTS only behind HTTPS", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  assert.equal(res.headers.get("strict-transport-security"), null, "COOKIE_SECURE is off in tests");
});
