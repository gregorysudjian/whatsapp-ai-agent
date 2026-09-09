import { test } from "node:test";
import assert from "node:assert/strict";
import { recordInbound, recordOutbound } from "../store/db.ts";
import { buildHistory } from "./memory.ts";
import type { InboundMessage } from "../whatsapp/types.ts";

const inbound = (id: string, waId: string, text: string): InboundMessage => ({
  id, from: waId, senderName: "Test", timestamp: new Date(), text,
  raw: { id, from: waId, timestamp: "0", type: "text", text: { body: text } },
});

test("history alternates roles in insertion order", () => {
  const wa = "10000000001";
  recordInbound(inbound("m1", wa, "hello"));
  recordOutbound("m2", wa, "hi there");
  recordInbound(inbound("m3", wa, "are you open?"));

  assert.deepEqual(
    buildHistory(wa).map((m) => [m.role, m.content]),
    [["user", "hello"], ["assistant", "hi there"], ["user", "are you open?"]],
  );
});

test("leading assistant turns are dropped - the API rejects them", () => {
  const wa = "10000000002";
  recordOutbound("m4", wa, "outbound template first");
  recordInbound(inbound("m5", wa, "replying to the template"));

  const history = buildHistory(wa);
  assert.equal(history[0]?.role, "user");
  assert.equal(history.length, 1);
});

test("media-only turns are skipped - empty content is rejected", () => {
  const wa = "10000000003";
  recordInbound(inbound("m6", wa, "first"));
  recordInbound(inbound("m7", wa, "   "));
  assert.equal(buildHistory(wa).length, 1);
});

test("an unknown conversation yields empty history, not a crash", () => {
  assert.deepEqual(buildHistory("19999999999"), []);
});

test("ordering survives an inbound timestamp older than a stored reply", () => {
  // A retried webhook arrives late: Meta's timestamp predates our reply.
  const wa = "10000000004";
  recordInbound(inbound("m8", wa, "first question"));
  recordOutbound("m9", wa, "our answer");
  const late = inbound("m10", wa, "late-delivered question");
  late.timestamp = new Date(Date.now() - 60 * 60 * 1000);
  recordInbound(late);

  assert.deepEqual(
    buildHistory(wa).map((m) => m.role),
    ["user", "assistant", "user"],
    "insertion order must win over wall-clock timestamps",
  );
});
