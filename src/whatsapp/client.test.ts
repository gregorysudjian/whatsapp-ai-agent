import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockGraph } from "../testing/mock-graph.ts";
import { sendText, markReadAndTyping, splitMessage } from "./client.ts";
import { listMessages } from "../store/queries.ts";
import { recordInbound } from "../store/db.ts";
import type { InboundMessage } from "./types.ts";
import { DEFAULT_BUSINESS_ID as B } from "../store/businesses.ts";

let seq = 0;
/**
 * Sends are only permitted inside Meta's 24h window, which opens when the
 * contact messages in. Every send test needs a contact who has done so.
 */
function openWindow(waId: string, minutesAgo = 0): void {
  const id = `seed-client-${++seq}`;
  const msg: InboundMessage = {
    id, from: waId, senderName: "T",
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    text: "opening the window",
    raw: { id, from: waId, timestamp: "0", type: "text", text: { body: "opening the window" } },
  };
  recordInbound(B, msg);
}

const graph = new MockGraph();

before(async () => { await graph.listen(4599); });
after(async () => { await graph.close(); });
beforeEach(() => { graph.reset(); });

test("sendText reaches Graph and stores the returned wamid", async () => {
  const wa = "12000000001";
  openWindow(wa);
  await sendText(B, wa, "hello from the agent");

  assert.deepEqual(graph.sentTexts, ["hello from the agent"]);

  // The wamid Graph assigned must be persisted, or later delivery receipts
  // have no row to attach to.
  const stored = listMessages(B, wa).filter((m) => m.direction === "out");
  assert.equal(stored.length, 1);
  assert.match(stored[0]!.id, /^wamid\.MOCK_/);
});

test("a reply over 4096 chars is split into several sends", async () => {
  const wa = "12000000002";
  openWindow(wa);
  const long = ("word ".repeat(2000)).trim(); // ~10k chars
  await sendText(B, wa, long);

  assert.ok(graph.sentTexts.length > 1, `expected multiple sends, got ${graph.sentTexts.length}`);
  for (const chunk of graph.sentTexts) {
    assert.ok(chunk.length <= 4096, `chunk of ${chunk.length} exceeds WhatsApp's limit`);
  }
  const stored = listMessages(B, wa).filter((m) => m.direction === "out");
  assert.equal(stored.length, graph.sentTexts.length, "each chunk stored");
  assert.equal(new Set(stored.map((m) => m.id)).size, stored.length, "wamids must be distinct");
});

test("a Graph error surfaces as a thrown error, not a silent drop", async () => {
  graph.script_({ status: 400, error: { message: "Invalid recipient", type: "OAuthException", code: 131026 } });
  openWindow("12000000003");
  await assert.rejects(() => sendText(B, "12000000003", "will fail"), /Graph API 400/);
});

test("markReadAndTyping never throws - it is cosmetic", async () => {
  // A 5xx is retryable, so this exercises the retry path too: one failure,
  // one success, and no exception either way.
  graph.script_({ status: 500 });
  await markReadAndTyping(B, "wamid.whatever");
  assert.equal(graph.requests.length, 2, "retried once, then succeeded");
});

test("a read receipt that keeps failing is swallowed, not thrown", async () => {
  graph.script_({ status: 500 }, { status: 500 }, { status: 500 });
  await markReadAndTyping(B, "wamid.doomed");   // must not reject
  assert.equal(graph.requests.length, 3, "capped, and the failure stays contained");
});

test("splitMessage prefers paragraph boundaries", () => {
  const text = "a".repeat(3000) + "\n\n" + "b".repeat(3000);
  const parts = splitMessage(text);
  assert.equal(parts.length, 2);
  assert.ok(parts[0]!.endsWith("a"));
  assert.ok(parts[1]!.startsWith("b"));
});

test("a send outside the 24h window is skipped, not attempted", async () => {
  const wa = "12000000010";
  openWindow(wa, 25 * 60); // last inbound 25 hours ago

  const wamids = await sendText(B, wa, "too late");

  assert.deepEqual(wamids, [], "no wamid, because nothing was sent");
  assert.equal(graph.requests.length, 0, "Graph must not be called at all");
  assert.equal(
    listMessages(B, wa).filter((m) => m.direction === "out").length, 0,
    "nothing stored as sent when it never was",
  );
});

test("a contact who has never messaged in has no open window", async () => {
  const wamids = await sendText(B, "12000000011", "unsolicited");
  assert.deepEqual(wamids, []);
  assert.equal(graph.requests.length, 0);
});

test("a send just inside the window still goes through", async () => {
  const wa = "12000000012";
  openWindow(wa, 23 * 60 + 55); // 5 minutes left
  const wamids = await sendText(B, wa, "just in time");
  assert.equal(wamids.length, 1);
  assert.deepEqual(graph.sentTexts, ["just in time"]);
});

test("a 429 is retried and then succeeds", async () => {
  const wa = "12000000020";
  openWindow(wa);
  graph.script_({ status: 429, retryAfter: 0 });   // then success

  const wamids = await sendText(B, wa, "eventually delivered");

  assert.equal(wamids.length, 1);
  assert.equal(graph.requests.length, 2, "one failed attempt, one success");
  assert.deepEqual(graph.sentTexts, ["eventually delivered", "eventually delivered"]);
});

test("a 500 is retried", async () => {
  const wa = "12000000021";
  openWindow(wa);
  graph.script_({ status: 500 });
  const wamids = await sendText(B, wa, "server hiccup");
  assert.equal(wamids.length, 1);
  assert.equal(graph.requests.length, 2);
});

test("a 4xx is never retried - it would fail identically", async () => {
  const wa = "12000000022";
  openWindow(wa);
  graph.script_({ status: 400, error: { message: "bad param", type: "OAuthException", code: 100 } });

  await assert.rejects(() => sendText(B, wa, "malformed"), /Graph API 400/);
  assert.equal(graph.requests.length, 1, "a bad request must not be repeated");
});

test("retries give up rather than looping forever", async () => {
  const wa = "12000000023";
  openWindow(wa);
  graph.script_({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });

  await assert.rejects(() => sendText(B, wa, "always down"), /Graph API 503/);
  assert.equal(graph.requests.length, 3, "capped at MAX_SEND_ATTEMPTS");
});

test("Retry-After is honoured over our own backoff", async () => {
  const wa = "12000000024";
  openWindow(wa);
  graph.script_({ status: 429, retryAfter: 1 });

  const started = Date.now();
  await sendText(B, wa, "paced by Meta");
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 900, `expected ~1s wait from Retry-After, waited ${elapsed}ms`);
});
