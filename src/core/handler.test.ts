/**
 * End to end: a signed webhook arrives, Claude answers, WhatsApp is called.
 *
 * Everything except the two external services is the real code path - real
 * routing, real HMAC verification, real store, real send logic over a socket.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { textMessagePayload, statusPayload, deliver, sign } from "../testing/webhook.ts";
import { setClientForTesting, FALLBACK_REPLY, type MessagesClient } from "../agent/claude.ts";
import { listMessages } from "../store/queries.ts";
import { DEFAULT_BUSINESS_ID as B } from "../store/businesses.ts";

const graph = new MockGraph();
let server: Server;
let baseUrl: string;

function claudeSaying(text: string): MessagesClient {
  return {
    messages: {
      stream: () => ({
        finalMessage: async () => ({
          id: "msg", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text, citations: [] }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: {
            input_tokens: 50, output_tokens: 10,
            cache_creation_input_tokens: null, cache_read_input_tokens: 40,
            server_tool_use: null, service_tier: null,
          },
        }),
      }),
    },
  } as unknown as MessagesClient;
}

/** The webhook acks before replying, so the send lands after the response. */
async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const waitForSends = (count: number) =>
  waitFor(`${count} send(s)`, () => graph.sentTexts.length >= count);

/**
 * The mock records a request before our client has parsed the response and
 * stored the wamid, so waiting on the send alone races the write. Anything
 * that reads the stored reply must wait for the row.
 */
const waitForStoredOutbound = (waId: string, count = 1) =>
  waitFor(
    `${count} stored outbound for ${waId}`,
    () => listMessages(B, waId).filter((m) => m.direction === "out").length >= count,
  );

before(async () => {
  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setClientForTesting(undefined);
  await graph.close();
  await new Promise((r) => server.close(r));
});

beforeEach(() => { graph.reset(); });

test("a signed message is acked fast, then answered", async () => {
  setClientForTesting(claudeSaying("We're open until 6pm today."));
  const wa = "14000000001";

  const started = Date.now();
  const res = await deliver(baseUrl, textMessagePayload("are you open?", { from: wa }));
  const ackMs = Date.now() - started;

  assert.equal(res.status, 200);
  assert.ok(ackMs < 1000, `ack took ${ackMs}ms - Meta retries anything slow`);

  await waitForStoredOutbound(wa);
  assert.deepEqual(graph.sentTexts, ["We're open until 6pm today."]);

  // Transcript stored in the order the agent observed it.
  const stored = listMessages(B, wa);
  assert.deepEqual(stored.map((m) => m.direction), ["in", "out"]);
  assert.equal(stored[0]?.text, "are you open?");
  assert.equal(stored[1]?.text, "We're open until 6pm today.");
});

test("an unsigned webhook is rejected and nothing is stored", async () => {
  setClientForTesting(claudeSaying("should never be sent"));
  const payload = textMessagePayload("sneaky", { from: "14000000002" });

  const res = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  assert.equal(res.status, 403);
  assert.equal(graph.sentTexts.length, 0);
  assert.equal(listMessages(B, "14000000002").length, 0);
});

test("a tampered body fails the signature even with a valid-looking header", async () => {
  const payload = textMessagePayload("original", { from: "14000000003" });
  const { headers } = sign(payload);

  const res = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(textMessagePayload("tampered", { from: "14000000003" })),
  });

  assert.equal(res.status, 403);
  assert.equal(graph.sentTexts.length, 0);
});

test("Meta's retry of the same message is ignored, not answered twice", async () => {
  setClientForTesting(claudeSaying("answered once"));
  const wa = "14000000004";
  const payload = textMessagePayload("hello?", { from: wa, id: "wamid.RETRY1" });

  await deliver(baseUrl, payload);
  await waitForStoredOutbound(wa);

  await deliver(baseUrl, payload);          // identical redelivery
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(graph.sentTexts.length, 1, "a retry must not produce a second reply");
  assert.equal(listMessages(B, wa).length, 2, "one inbound, one outbound");
});

test("concurrent messages from one contact do not interleave", async () => {
  setClientForTesting(claudeSaying("ok"));
  const wa = "14000000005";

  await Promise.all([
    deliver(baseUrl, textMessagePayload("first", { from: wa, id: "wamid.SEQ1" })),
    deliver(baseUrl, textMessagePayload("second", { from: wa, id: "wamid.SEQ2" })),
  ]);
  await waitForStoredOutbound(wa, 2);

  const messages = listMessages(B, wa);

  // Arrival order between two concurrent requests is not deterministic, and
  // Meta does not guarantee it either. The invariant that matters is that the
  // pairs do not interleave: each question is followed by its own answer.
  assert.deepEqual(
    messages.map((m) => m.direction), ["in", "out", "in", "out"],
    "without serialisation both questions land before either answer",
  );
  assert.deepEqual(
    messages.filter((m) => m.direction === "in").map((m) => m.text).sort(),
    ["first", "second"],
  );
});

test("a model failure still sends the customer a sentence", async () => {
  setClientForTesting({
    messages: {
      stream: () => ({
        finalMessage: async () => { throw new Anthropic.AuthenticationError(401, { type: "error" }, "no key", new Headers()); },
      }),
    },
  } as unknown as MessagesClient);

  await deliver(baseUrl, textMessagePayload("hi", { from: "14000000006" }));
  await waitForSends(1);
  assert.deepEqual(graph.sentTexts, [FALLBACK_REPLY]);
});

test("a delivery receipt updates the stored message, sending nothing", async () => {
  setClientForTesting(claudeSaying("reply text"));
  const wa = "14000000007";

  await deliver(baseUrl, textMessagePayload("hey", { from: wa }));
  await waitForStoredOutbound(wa);

  const outbound = listMessages(B, wa).find((m) => m.direction === "out")!;
  graph.reset();

  await deliver(baseUrl, statusPayload({
    id: outbound.id, status: "read", timestamp: "0", recipient_id: wa,
  }));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(graph.sentTexts.length, 0, "a receipt is not a message");
  assert.equal(listMessages(B, wa).find((m) => m.id === outbound.id)?.status, "read");
});

test("a contact without a profile - v26 receipts, username users - does not drop the message", async () => {
  setClientForTesting(claudeSaying("reply text"));
  const wa = "14000000008";
  const payload = textMessagePayload("hi", { from: wa });
  payload.entry![0]!.changes![0]!.value.contacts = [{ user_id: "US.1234567890" }, { wa_id: wa }];

  await deliver(baseUrl, payload);
  await waitForStoredOutbound(wa);

  assert.ok(listMessages(B, wa).some((m) => m.direction === "in" && m.text === "hi"));
});
