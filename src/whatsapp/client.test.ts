import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockGraph } from "../testing/mock-graph.ts";
import { sendText, markReadAndTyping, splitMessage } from "./client.ts";
import { listMessages } from "../store/queries.ts";
import { recordInbound } from "../store/db.ts";
import type { InboundMessage } from "./types.ts";

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
  recordInbound(msg);
}

const graph = new MockGraph();

before(async () => { await graph.listen(4599); });
after(async () => { await graph.close(); });
beforeEach(() => { graph.reset(); });

test("sendText reaches Graph and stores the returned wamid", async () => {
  const wa = "12000000001";
  openWindow(wa);
  await sendText(wa, "hello from the agent");

  assert.deepEqual(graph.sentTexts, ["hello from the agent"]);

  // The wamid Graph assigned must be persisted, or later delivery receipts
  // have no row to attach to.
  const stored = listMessages(wa).filter((m) => m.direction === "out");
  assert.equal(stored.length, 1);
  assert.match(stored[0]!.id, /^wamid\.MOCK_/);
});

test("a reply over 4096 chars is split into several sends", async () => {
  const wa = "12000000002";
  openWindow(wa);
  const long = ("word ".repeat(2000)).trim(); // ~10k chars
  await sendText(wa, long);

  assert.ok(graph.sentTexts.length > 1, `expected multiple sends, got ${graph.sentTexts.length}`);
  for (const chunk of graph.sentTexts) {
    assert.ok(chunk.length <= 4096, `chunk of ${chunk.length} exceeds WhatsApp's limit`);
  }
  const stored = listMessages(wa).filter((m) => m.direction === "out");
  assert.equal(stored.length, graph.sentTexts.length, "each chunk stored");
  assert.equal(new Set(stored.map((m) => m.id)).size, stored.length, "wamids must be distinct");
});

test("a Graph error surfaces as a thrown error, not a silent drop", async () => {
  graph.script_({ status: 400, error: { message: "Invalid recipient", type: "OAuthException", code: 131026 } });
  openWindow("12000000003");
  await assert.rejects(() => sendText("12000000003", "will fail"), /Graph API 400/);
});

test("markReadAndTyping never throws - it is cosmetic", async () => {
  graph.script_({ status: 500 });
  await markReadAndTyping("wamid.whatever");   // must swallow
  assert.equal(graph.requests.length, 1);
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

  const wamids = await sendText(wa, "too late");

  assert.deepEqual(wamids, [], "no wamid, because nothing was sent");
  assert.equal(graph.requests.length, 0, "Graph must not be called at all");
  assert.equal(
    listMessages(wa).filter((m) => m.direction === "out").length, 0,
    "nothing stored as sent when it never was",
  );
});

test("a contact who has never messaged in has no open window", async () => {
  const wamids = await sendText("12000000011", "unsolicited");
  assert.deepEqual(wamids, []);
  assert.equal(graph.requests.length, 0);
});

test("a send just inside the window still goes through", async () => {
  const wa = "12000000012";
  openWindow(wa, 23 * 60 + 55); // 5 minutes left
  const wamids = await sendText(wa, "just in time");
  assert.equal(wamids.length, 1);
  assert.deepEqual(graph.sentTexts, ["just in time"]);
});
