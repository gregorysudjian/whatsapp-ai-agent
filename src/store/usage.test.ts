import { test } from "node:test";
import assert from "node:assert/strict";
import { recordInbound, recordOutbound, recordUsage } from "./db.ts";
import { listMessages, stats } from "./queries.ts";
import type { InboundMessage } from "../whatsapp/types.ts";

const inbound = (id: string, waId: string, text: string): InboundMessage => ({
  id, from: waId, senderName: "T", timestamp: new Date(), text,
  raw: { id, from: waId, timestamp: "0", type: "text", text: { body: text } },
});

test("usage is attached to the reply it paid for", () => {
  const wa = "15000000001";
  recordInbound(inbound("u1", wa, "question"));
  recordOutbound("u2", wa, "answer");
  recordUsage("u2", { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, latencyMs: 1500 });

  const messages = listMessages(wa);
  const reply = messages.find((m) => m.id === "u2")!;
  assert.equal(reply.inputTokens, 1200);
  assert.equal(reply.outputTokens, 300);
  assert.equal(reply.cacheReadTokens, 900);
  assert.equal(reply.latencyMs, 1500);

  // The inbound message was never a model call - it must stay null, not zero.
  assert.equal(messages.find((m) => m.id === "u1")?.inputTokens, null);
});

test("cost is estimated from the published rates", () => {
  const before = stats();
  const wa = "15000000002";
  recordOutbound("u3", wa, "another answer");
  // 1M input + 1M output = $5 + $25.
  recordUsage("u3", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, latencyMs: 10 });

  const after = stats();
  assert.equal(
    Number((after.estimatedCostUsd - before.estimatedCostUsd).toFixed(2)), 30,
    "1M in + 1M out should read as $30 at Opus 5 list prices",
  );
  assert.ok(after.outputTokens >= 1_000_000);
});

test("messages with no usage do not drag the latency average to zero", () => {
  const wa = "15000000003";
  recordInbound(inbound("u4", wa, "no model call here"));
  assert.ok(stats().avgLatencyMs > 0, "rows without usage must be excluded, not counted as 0ms");
});
