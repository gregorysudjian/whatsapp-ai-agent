/**
 * Tenant isolation, end to end. Two clients run side by side through the real
 * webhook, store, agent and send path; every test asks whether anything of
 * one can be seen, touched, or impersonated through the other.
 *
 * This is the Law 25 test file. If one of these fails, a client can see
 * another client's customers.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { textMessagePayload, statusPayload, deliver, targetFor, type Target } from "../testing/webhook.ts";
import { setClientForTesting, type MessagesClient } from "../agent/claude.ts";
import {
  createBusiness, setWhatsappCredentials, setBusinessStatus, listBusinesses,
  getWhatsappCredentials, setSchedule,
} from "./businesses.ts";
import {
  agentEnabled, setAgentEnabled, isPaused, pauseForHuman, db, type BusinessId,
} from "./db.ts";
import { listConversations, listMessages, listEvents, stats } from "./queries.ts";
import { createBooking } from "./bookings.ts";
import { createService } from "./services.ts";
import { subscribe, type AgentEvent } from "../core/events.ts";

const graph = new MockGraph();
let server: Server;
let baseUrl: string;
let A: BusinessId;
let B: BusinessId;
let targetA: Target;
let targetB: Target;

/** One customer who happens to text both businesses. */
const SHARED_CUSTOMER = "15145550000";

function replying(text: string): MessagesClient {
  return {
    messages: {
      stream: () => ({
        finalMessage: async () => ({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text, citations: [] }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: {
            input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null,
            cache_read_input_tokens: 0, server_tool_use: null, service_tier: null,
          },
        }),
      }),
    },
  } as unknown as MessagesClient;
}

async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 200));

before(async () => {
  const a = createBusiness({ name: "Clinic Alpha", defaultLanguage: "fr" });
  const b = createBusiness({ name: "Studio Beta" });
  A = a.id;
  B = b.id;

  setWhatsappCredentials(A, {
    phoneNumberId: "111111111111111", accessToken: "alpha-access-token-000000000",
    appSecret: "alpha-app-secret-00000", verifyToken: "alpha-verify",
  });
  setWhatsappCredentials(B, {
    phoneNumberId: "222222222222222", accessToken: "beta-access-token-0000000000",
    appSecret: "beta-app-secret-000000", verifyToken: "beta-verify",
  });
  // Every day open, so the booking test does not depend on the weekday.
  const allWeek = Object.fromEntries(
    ["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "08:00", close: "20:00" }]),
  );
  setSchedule(A, allWeek);
  setSchedule(B, allWeek);

  targetA = targetFor(A);
  targetB = targetFor(B);

  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  setClientForTesting(replying("hello from the agent"));
});

after(async () => {
  setClientForTesting(undefined);
  await graph.close();
  await new Promise((r) => server.close(r));
});

beforeEach(() => graph.reset());

// --- routing and signatures -----------------------------------------------

test("each client's messages land in that client only", async () => {
  await deliver(baseUrl, textMessagePayload("bonjour", { from: "15145550001", phoneNumberId: targetA.phoneNumberId }), targetA);
  await deliver(baseUrl, textMessagePayload("hi there", { from: "15145550002", phoneNumberId: targetB.phoneNumberId }), targetB);
  await until("both replies", () => graph.sentTexts.length >= 2);

  const aIds = listConversations(A).map((c) => c.waId);
  const bIds = listConversations(B).map((c) => c.waId);
  assert.ok(aIds.includes("15145550001") && !aIds.includes("15145550002"));
  assert.ok(bIds.includes("15145550002") && !bIds.includes("15145550001"));
});

test("each reply goes out on its own client's number, with its own token", async () => {
  await deliver(baseUrl, textMessagePayload("question for alpha", { from: "15145550003", phoneNumberId: targetA.phoneNumberId }), targetA);
  await deliver(baseUrl, textMessagePayload("question for beta", { from: "15145550004", phoneNumberId: targetB.phoneNumberId }), targetB);
  await until("both replies", () => graph.sentTexts.length >= 2);

  const sends = graph.requests.filter((r) => r.body["type"] === "text");
  const toA = sends.find((r) => r.body["to"] === "15145550003")!;
  const toB = sends.find((r) => r.body["to"] === "15145550004")!;

  assert.match(toA.path, /\/111111111111111\/messages$/, "alpha's reply must use alpha's number");
  assert.equal(toA.authorization, "Bearer alpha-access-token-000000000");
  assert.match(toB.path, /\/222222222222222\/messages$/, "beta's reply must use beta's number");
  assert.equal(toB.authorization, "Bearer beta-access-token-0000000000");
});

test("a payload signed with A's secret is rejected at B's URL", async () => {
  const forged = { ...targetB, appSecret: targetA.appSecret };
  const res = await deliver(
    baseUrl,
    textMessagePayload("impersonating", { from: "15145550005", phoneNumberId: targetB.phoneNumberId }),
    forged,
  );
  assert.equal(res.status, 403);
  await settle();
  assert.equal(listMessages(B, "15145550005").length, 0);
});

test("B's URL cannot be used to inject messages for A's number", async () => {
  // Correctly signed for B, but claiming to be for A's phone number: the
  // signature proves the sender is B's Meta app, not which number it is for.
  const res = await deliver(
    baseUrl,
    textMessagePayload("cross-number", { from: "15145550006", phoneNumberId: targetA.phoneNumberId }),
    targetB,
  );
  assert.equal(res.status, 200, "acked, so Meta does not retry");
  await settle();

  assert.equal(listMessages(A, "15145550006").length, 0, "nothing may land in A");
  assert.equal(listMessages(B, "15145550006").length, 0, "nor in B, since it is not B's number");
  assert.ok(listEvents(B).some((e) => e.name === "phone_number_mismatch"));
  assert.equal(graph.sentTexts.length, 0);
});

test("an unknown webhook URL looks exactly like a bad signature", async () => {
  // A distinct response would let anyone enumerate which URLs are real clients.
  const unknown = { ...targetA, path: "/webhook/b/does-not-exist" };
  const res = await deliver(baseUrl, textMessagePayload("probe", { phoneNumberId: targetA.phoneNumberId }), unknown);
  const bad = await deliver(baseUrl, textMessagePayload("probe"), { ...targetA, appSecret: "wrong-secret-0000000" });
  assert.equal(res.status, 403);
  assert.equal(bad.status, 403);

  const verifyUnknown = await fetch(`${baseUrl}/webhook/b/does-not-exist?hub.mode=subscribe&hub.verify_token=x&hub.challenge=c`);
  assert.equal(verifyUnknown.status, 403);
});

test("each client's handshake accepts only its own verify token", async () => {
  const handshake = (t: Target, token: string) =>
    fetch(`${baseUrl}${t.path}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=ok123`);

  assert.equal(await (await handshake(targetA, "alpha-verify")).text(), "ok123");
  assert.equal((await handshake(targetA, "beta-verify")).status, 403, "B's token must not open A");
});

test("a receipt on B's webhook cannot change A's message", async () => {
  await deliver(baseUrl, textMessagePayload("need an answer", { from: "15145550007", phoneNumberId: targetA.phoneNumberId }), targetA);
  await until("stored reply", () => listMessages(A, "15145550007").some((m) => m.direction === "out"));
  const aReply = listMessages(A, "15145550007").find((m) => m.direction === "out")!;

  await deliver(baseUrl, statusPayload(
    { id: aReply.id, status: "failed", timestamp: "0", recipient_id: "15145550007" },
    targetB.phoneNumberId,
  ), targetB);
  await settle();

  assert.notEqual(
    listMessages(A, "15145550007").find((m) => m.id === aReply.id)?.status, "failed",
    "B's receipts must only ever touch B's rows",
  );
});

// --- the same customer, two businesses ------------------------------------

test("one customer texting both clients is two separate relationships", async () => {
  await deliver(baseUrl, textMessagePayload("first to alpha", { from: SHARED_CUSTOMER, phoneNumberId: targetA.phoneNumberId }), targetA);
  await until("alpha's reply", () => graph.sentTexts.length >= 1);

  // Beta stays silent for this one, so beta's latest message for this
  // customer is unique text. If both agents replied, their identical replies
  // would make a leaked preview indistinguishable from a correct one - which
  // is exactly how an earlier version of this test passed with the leak on.
  setAgentEnabled(B, false);
  try {
    await deliver(baseUrl, textMessagePayload("then to beta", { from: SHARED_CUSTOMER, phoneNumberId: targetB.phoneNumberId }), targetB);
    await until("beta stored it", () => listMessages(B, SHARED_CUSTOMER).length > 0);
  } finally {
    setAgentEnabled(B, true);
  }

  const aThread = listMessages(A, SHARED_CUSTOMER).map((m) => m.text);
  const bThread = listMessages(B, SHARED_CUSTOMER).map((m) => m.text);
  assert.ok(aThread.includes("first to alpha") && !aThread.includes("then to beta"));
  assert.ok(bThread.includes("then to beta") && !bThread.includes("first to alpha"));

  // The inbox preview is the classic leak: a subquery matching on phone
  // number alone surfaces beta's latest message in alpha's list.
  const aPreview = listConversations(A).find((c) => c.waId === SHARED_CUSTOMER);
  assert.equal(aPreview?.lastText, aThread[aThread.length - 1], "alpha's preview must be alpha's own last message");
  assert.notEqual(aPreview?.lastText, "then to beta");
});

test("pausing a customer at one client does not pause them at the other", () => {
  pauseForHuman(A, SHARED_CUSTOMER, "wants a person");
  assert.equal(isPaused(A, SHARED_CUSTOMER), true);
  assert.equal(isPaused(B, SHARED_CUSTOMER), false);
});

// --- per-client controls --------------------------------------------------

test("turning one client's agent off leaves the other answering", async () => {
  setAgentEnabled(A, false);
  try {
    assert.equal(agentEnabled(A), false);
    assert.equal(agentEnabled(B), true);

    await deliver(baseUrl, textMessagePayload("anyone?", { from: "15145550008", phoneNumberId: targetA.phoneNumberId }), targetA);
    await deliver(baseUrl, textMessagePayload("anyone?", { from: "15145550009", phoneNumberId: targetB.phoneNumberId }), targetB);
    await until("B's reply", () => graph.sentTexts.length >= 1);
    await settle();

    const recipients = graph.requests.filter((r) => r.body["type"] === "text").map((r) => r.body["to"]);
    assert.deepEqual(recipients, ["15145550009"], "only B answers");
  } finally {
    setAgentEnabled(A, true);
  }
});

test("the same hour can be booked at both clients", () => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const slot = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;

  const svcA = createService(A, { name: "Consult", durationMin: 60, priceCents: null, currency: "CAD" }).id;
  const svcB = createService(B, { name: "Session", durationMin: 60, priceCents: null, currency: "CAD" }).id;
  const book = (bid: BusinessId, waId: string, serviceId: number) =>
    createBooking(bid, { waId, customerName: "X", serviceId, start: slot, source: "agent" });

  assert.equal(book(A, "15145550010", svcA).ok, true);
  assert.equal(book(B, "15145550011", svcB).ok, true,
    "a slot was unique across every client before multi-tenancy");
  assert.deepEqual(book(A, "15145550012", svcA), { ok: false, reason: "taken" });
  assert.deepEqual(book(A, "15145550013", svcB), { ok: false, reason: "no_service" },
    "a service id belongs to one client: A cannot book B's service");

  // And in the other order: whichever client books first, the other is unaffected.
  const later = slot.replace("T10:00", "T14:00");
  assert.equal(createBooking(B, { waId: "15145550014", customerName: "X", serviceId: svcB, start: later, source: "agent" }).ok, true);
  assert.equal(createBooking(A, { waId: "15145550015", customerName: "X", serviceId: svcA, start: later, source: "agent" }).ok, true,
    "B's booking must not block A either");
});

test("stats are counted per client", () => {
  const count = (id: BusinessId) => Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND direction = 'in'`).get(id) as { n: number }).n,
  );
  const everyone = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'`).get() as { n: number }).n,
  );

  assert.ok(count(A) > 0 && count(B) > 0, "both clients have traffic by now");
  assert.equal(stats(A).inbound, count(A));
  assert.equal(stats(B).inbound, count(B));
  assert.ok(stats(A).inbound < everyone, "a client's total must not include anyone else's");
});

test("a live-feed subscriber sees only its own client", async () => {
  const seenByA: AgentEvent[] = [];
  const stop = subscribe(A, (e) => seenByA.push(e));
  try {
    await deliver(baseUrl, textMessagePayload("for beta only", { from: "15145550013", phoneNumberId: targetB.phoneNumberId }), targetB);
    await until("B's reply", () => graph.sentTexts.length >= 1);
    await settle();
    assert.ok(seenByA.every((e) => e.businessId === A), "A's stream must never carry B's events");
    assert.ok(!seenByA.some((e) => "waId" in e && e.waId === "15145550013"));
  } finally {
    stop();
  }
});

// --- deactivation and secrets ---------------------------------------------

test("a deactivated client's messages are acked but neither stored nor answered", async () => {
  setBusinessStatus(B, "inactive");
  try {
    const res = await deliver(baseUrl, textMessagePayload("still there?", { from: "15145550014", phoneNumberId: targetB.phoneNumberId }), targetB);
    assert.equal(res.status, 200, "acked, or Meta retries indefinitely");
    await settle();
    assert.equal(listMessages(B, "15145550014").length, 0, "no retention without purpose");
    assert.equal(graph.sentTexts.length, 0);
  } finally {
    setBusinessStatus(B, "active");
  }
});

test("listing businesses never exposes a credential", () => {
  const serialised = JSON.stringify(listBusinesses());
  for (const secret of ["alpha-access-token", "alpha-app-secret", "beta-access-token", "beta-app-secret", "alpha-verify"]) {
    assert.ok(!serialised.includes(secret), `${secret} leaked into a Business object`);
  }
});

test("credentials are encrypted at rest", () => {
  const row = db.prepare(`SELECT * FROM businesses WHERE id = ?`).get(A) as Record<string, unknown>;
  const raw = JSON.stringify(row);
  assert.ok(!raw.includes("alpha-access-token"), "the token must not be readable in the database");
  assert.ok(!raw.includes("alpha-app-secret"));
  assert.equal(getWhatsappCredentials(A)?.accessToken, "alpha-access-token-000000000", "but decrypts for use");
});

test("A's encrypted token copied into B's row does not decrypt", () => {
  const aToken = (db.prepare(`SELECT wa_access_token_enc AS t FROM businesses WHERE id = ?`).get(A) as { t: string }).t;
  const bToken = (db.prepare(`SELECT wa_access_token_enc AS t FROM businesses WHERE id = ?`).get(B) as { t: string }).t;
  db.prepare(`UPDATE businesses SET wa_access_token_enc = ? WHERE id = ?`).run(aToken, B);
  try {
    assert.throws(() => getWhatsappCredentials(B), "a database-level copy must not move one client's credential to another");
  } finally {
    db.prepare(`UPDATE businesses SET wa_access_token_enc = ? WHERE id = ?`).run(bToken, B);
  }
});

test("two clients cannot claim the same phone number", () => {
  assert.throws(
    () => setWhatsappCredentials(B, {
      phoneNumberId: "111111111111111", accessToken: "x".repeat(30),
      appSecret: "y".repeat(20), verifyToken: "zzzzzz",
    }),
    /already connected to another business/,
  );
});

test("the database itself refuses a row with no business", () => {
  assert.throws(
    () => db.prepare(`INSERT INTO messages (id, wa_id, direction, type, ts) VALUES ('orphan', '1', 'in', 'text', 1)`).run(),
    /NOT NULL/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO messages (id, business_id, wa_id, direction, type, ts) VALUES ('ghost', 999999, '1', 'in', 'text', 1)`).run(),
    /FOREIGN KEY/,
  );
});
