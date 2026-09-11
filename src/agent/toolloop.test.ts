/**
 * The tool loop itself: model asks for a tool, we run it, model answers.
 * Driven with a scripted fake so the sequence is deterministic.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { generateReply, setClientForTesting, FALLBACK_REPLY, type MessagesClient } from "./claude.ts";
import { recordInbound, isPaused, clearHandoff } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";
import { DEFAULT_BUSINESS_ID as B } from "../store/businesses.ts";

const usage = {
  input_tokens: 10, output_tokens: 5,
  cache_creation_input_tokens: null, cache_read_input_tokens: 2,
  server_tool_use: null, service_tier: null,
};

const base = {
  id: "m", type: "message", role: "assistant", model: "claude-opus-5",
  stop_sequence: null, usage,
};

const says = (text: string) => ({
  ...base, content: [{ type: "text", text, citations: [] }], stop_reason: "end_turn",
}) as unknown as Anthropic.Message;

const wantsTool = (name: string, input: unknown, id = "tu_1") => ({
  ...base,
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
}) as unknown as Anthropic.Message;

/** Replays a script of responses and records what it was sent each time. */
function scripted(responses: Anthropic.Message[]) {
  const sent: Anthropic.MessageCreateParams[] = [];
  let i = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        sent.push(params);
        const response = responses[Math.min(i++, responses.length - 1)]!;
        return { finalMessage: async () => response };
      },
    },
  } as unknown as MessagesClient;
  return { client, sent };
}

let seq = 0;
function seed(waId: string, text: string): void {
  const id = `tl-${++seq}`;
  const msg: InboundMessage = {
    id, from: waId, senderName: "Test", timestamp: new Date(), text,
    raw: { id, from: waId, timestamp: "0", type: "text", text: { body: text } },
  };
  recordInbound(B, msg);
}

after(() => setClientForTesting(undefined));

test("a tool call is executed and its result fed back", async () => {
  const wa = "18000000001";
  seed(wa, "when are you open?");

  const { client, sent } = scripted([
    wantsTool("get_business_info", {}),
    says("We're open Monday to Friday, 8am to 3pm."),
  ]);
  setClientForTesting(client);

  const result = await generateReply(B, wa, "Test");

  assert.equal(result.ok, true);
  assert.match(result.text, /Monday to Friday/);
  assert.equal(sent.length, 2, "one call to ask for the tool, one to answer");

  // The second request must carry the assistant turn and the tool result.
  const second = sent[1]!.messages;
  const assistantTurn = second[second.length - 2];
  const resultTurn = second[second.length - 1];
  assert.equal(assistantTurn?.role, "assistant");
  assert.equal(resultTurn?.role, "user");

  const blocks = resultTurn?.content as Anthropic.ToolResultBlockParam[];
  assert.equal(blocks[0]?.type, "tool_result");
  assert.equal(blocks[0]?.tool_use_id, "tu_1");
  // The result carries THIS business's facts, not a global constant.
  assert.match(String(blocks[0]?.content), /Ninja Co/);
});

test("usage is summed across every call in the turn, not just the last", async () => {
  const wa = "18000000002";
  seed(wa, "what are your hours?");
  const { client } = scripted([
    wantsTool("get_business_info", {}),
    says("All done."),
  ]);
  setClientForTesting(client);

  const result = await generateReply(B, wa, "Test");
  assert.equal(result.usage?.inputTokens, 20, "two calls at 10 input tokens each");
  assert.equal(result.usage?.outputTokens, 10);
});

test("parallel tool calls all return in a single user message", async () => {
  const wa = "18000000003";
  seed(wa, "two things at once");

  const parallel = {
    ...base,
    content: [
      { type: "tool_use", id: "tu_a", name: "get_business_info", input: {} },
      { type: "tool_use", id: "tu_b", name: "check_availability", input: { date: "2099-01-01" } },
    ],
    stop_reason: "tool_use",
  } as unknown as Anthropic.Message;

  const { client, sent } = scripted([parallel, says("Here you go.")]);
  setClientForTesting(client);
  await generateReply(B, wa, "Test");

  const second = sent[1]!.messages;
  const resultTurn = second[second.length - 1];
  const blocks = resultTurn?.content as Anthropic.ToolResultBlockParam[];
  assert.equal(blocks.length, 2, "splitting results teaches the model to stop calling in parallel");
  assert.deepEqual(blocks.map((b) => b.tool_use_id), ["tu_a", "tu_b"]);
});

test("escalation is reported back to the caller", async () => {
  const wa = "18000000004";
  seed(wa, "I want a human");
  const { client } = scripted([
    wantsTool("escalate_to_human", { reason: "customer asked" }),
    says("Someone will follow up with you shortly."),
  ]);
  setClientForTesting(client);

  const result = await generateReply(B, wa, "Test");
  assert.equal(result.handoff, true);
  assert.equal(isPaused(B, wa), true);
  clearHandoff(B, wa);
});

test("a model that only ever asks for tools is cut off, not looped forever", async () => {
  const wa = "18000000005";
  seed(wa, "loop please");
  // Always returns tool_use - the script never advances to an answer.
  const { client, sent } = scripted([wantsTool("get_business_info", {})]);
  setClientForTesting(client);

  const result = await generateReply(B, wa, "Test");

  assert.equal(result.ok, false);
  assert.equal(result.text, FALLBACK_REPLY);
  assert.equal(sent.length, 5, "capped at MAX_TOOL_ITERATIONS - a runaway loop is real money");
});
