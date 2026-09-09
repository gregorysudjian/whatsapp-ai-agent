import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockGraph } from "../testing/mock-graph.ts";
import { sendText, markReadAndTyping, splitMessage } from "./client.ts";
import { listMessages } from "../store/queries.ts";

const graph = new MockGraph();

before(async () => { await graph.listen(4599); });
after(async () => { await graph.close(); });
beforeEach(() => { graph.reset(); });

test("sendText reaches Graph and stores the returned wamid", async () => {
  const wa = "12000000001";
  await sendText(wa, "hello from the agent");

  assert.deepEqual(graph.sentTexts, ["hello from the agent"]);

  // The wamid Graph assigned must be persisted, or later delivery receipts
  // have no row to attach to.
  const stored = listMessages(wa);
  assert.equal(stored.length, 1);
  assert.match(stored[0]!.id, /^wamid\.MOCK\d+$/);
  assert.equal(stored[0]!.direction, "out");
});

test("a reply over 4096 chars is split into several sends", async () => {
  const wa = "12000000002";
  const long = ("word ".repeat(2000)).trim(); // ~10k chars
  await sendText(wa, long);

  assert.ok(graph.sentTexts.length > 1, `expected multiple sends, got ${graph.sentTexts.length}`);
  for (const chunk of graph.sentTexts) {
    assert.ok(chunk.length <= 4096, `chunk of ${chunk.length} exceeds WhatsApp's limit`);
  }
  assert.equal(listMessages(wa).length, graph.sentTexts.length, "each chunk stored");
});

test("a Graph error surfaces as a thrown error, not a silent drop", async () => {
  graph.script_({ status: 400, error: { message: "Invalid recipient", type: "OAuthException", code: 131026 } });
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
