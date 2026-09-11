import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  generateReply, classifyError, setClientForTesting, FALLBACK_REPLY,
  type MessagesClient,
} from "./claude.ts";
import { recordInbound } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";
import { DEFAULT_BUSINESS_ID as B } from "../store/businesses.ts";

// --- fake client ----------------------------------------------------------

type Outcome = Anthropic.Message | Error;

interface Capture { params: Anthropic.MessageCreateParams | undefined; calls: number }

function fakeClient(outcomes: Outcome[]): { client: MessagesClient; capture: Capture } {
  const capture: Capture = { params: undefined, calls: 0 };
  const queue = [...outcomes];
  // Repeat the final outcome once exhausted. Returning undefined instead
  // would make a call throw a TypeError that the fallback path swallows -
  // a test could then pass without the call ever having succeeded.
  let last = outcomes[outcomes.length - 1];

  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        capture.params = params;
        capture.calls++;
        const outcome = queue.length > 0 ? queue.shift()! : last;
        last = outcome;
        return {
          finalMessage: async () => {
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
        };
      },
    },
  } as unknown as MessagesClient;

  return { client, capture };
}

const message = (over: Partial<Anthropic.Message> = {}): Anthropic.Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
  content: [{ type: "text", text: "We're open until 6pm.", citations: [] }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: {
    input_tokens: 100, output_tokens: 12,
    cache_creation_input_tokens: null, cache_read_input_tokens: 80,
    server_tool_use: null, service_tier: null,
  },
  ...over,
} as Anthropic.Message);

// Each subclass narrows `status` to a literal, so one generic factory cannot
// build them all - construct each explicitly.
const H = () => new Headers();
const E = { type: "error" as const };
const rateLimited = () => new Anthropic.RateLimitError(429, E, "mock 429", H());
const unauthorized = () => new Anthropic.AuthenticationError(401, E, "mock 401", H());
const notFound = () => new Anthropic.NotFoundError(404, E, "mock 404", H());
const apiError = (status: number) => new Anthropic.APIError(status, E, `mock ${status}`, H());

const WA = "13000000001";
let n = 0;
function seedInbound(waId: string, text: string): void {
  const msg: InboundMessage = {
    id: `seed${++n}`, from: waId, senderName: "T", timestamp: new Date(), text,
    raw: { id: `seed${n}`, from: waId, timestamp: "0", type: "text", text: { body: text } },
  };
  recordInbound(B, msg);
}

beforeEach(() => { seedInbound(WA, "are you open?"); });
after(() => { setClientForTesting(undefined); });

// --- happy path -----------------------------------------------------------

test("returns the model's text and reports usage", async () => {
  const { client, capture } = fakeClient([message()]);
  setClientForTesting(client);

  const result = await generateReply(B, WA);

  assert.equal(result.ok, true);
  assert.equal(result.text, "We're open until 6pm.");
  assert.equal(result.usage?.inputTokens, 100);
  assert.equal(result.usage?.cacheReadTokens, 80);
  assert.equal(capture.calls, 1);
});

test("request shape matches what Opus 5 accepts", async () => {
  const { client, capture } = fakeClient([message()]);
  setClientForTesting(client);
  await generateReply(B, WA);

  const p = capture.params!;
  assert.equal(p.model, "claude-opus-5");
  assert.equal(p.max_tokens, 8192);
  assert.deepEqual(p.thinking, { type: "adaptive" });
  // medium rather than low: tool selection benefits from a step up.
  assert.equal((p as { output_config?: { effort?: string } }).output_config?.effort, "medium");
  assert.ok(Array.isArray(p.tools) && p.tools.length > 0, "tools must be offered");
  assert.equal(
    (p.thinking as { budget_tokens?: number }).budget_tokens, undefined,
    "budget_tokens is rejected with a 400 on Opus 5",
  );
  assert.ok(Array.isArray(p.system), "system must be blocks so it can carry cache_control");
  assert.deepEqual(
    (p.system as Anthropic.TextBlockParam[])[0]?.cache_control, { type: "ephemeral" },
  );
});

test("the cached system prompt is byte-stable across calls", async () => {
  const { client, capture } = fakeClient([message()]);
  setClientForTesting(client);

  await generateReply(B, WA);
  const first = (capture.params!.system as Anthropic.TextBlockParam[])[0]?.text;
  await generateReply(B, WA);
  const second = (capture.params!.system as Anthropic.TextBlockParam[])[0]?.text;

  assert.equal(first, second, "any per-call variation silently invalidates the cache");
});

// --- failure paths --------------------------------------------------------

test("a refusal yields the fallback, never empty text", async () => {
  const { client } = fakeClient([message({
    content: [], stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "no" },
  } as Partial<Anthropic.Message>)]);
  setClientForTesting(client);

  const result = await generateReply(B, WA);
  assert.equal(result.ok, false);
  assert.equal(result.text, FALLBACK_REPLY);
});

test("a thinking-only response yields the fallback", async () => {
  const { client } = fakeClient([message({
    content: [{ type: "thinking", thinking: "", signature: "" }], stop_reason: "max_tokens",
  } as Partial<Anthropic.Message>)]);
  setClientForTesting(client);

  assert.equal((await generateReply(B, WA)).text, FALLBACK_REPLY);
});

test("a rate limit is retried, then succeeds", async () => {
  const { client, capture } = fakeClient([rateLimited(), message()]);
  setClientForTesting(client);

  const result = await generateReply(B, WA);
  assert.equal(result.ok, true, "second attempt should succeed");
  assert.equal(capture.calls, 2);
});

test("an exhausted rate limit sends the fallback, not silence", async () => {
  const { client, capture } = fakeClient([rateLimited(), rateLimited()]);
  setClientForTesting(client);

  const result = await generateReply(B, WA);
  assert.equal(result.ok, false);
  assert.equal(result.text, FALLBACK_REPLY);
  assert.equal(capture.calls, 2, "must stop at MAX_ATTEMPTS, not loop");
});

test("an auth error is not retried - retrying a bad key just burns time", async () => {
  const { client, capture } = fakeClient([unauthorized()]);
  setClientForTesting(client);

  assert.equal((await generateReply(B, WA)).ok, false);
  assert.equal(capture.calls, 1);
});

test("a first-ever conversation with no history does not crash", async () => {
  const { client } = fakeClient([message()]);
  setClientForTesting(client);

  const result = await generateReply(B, "19999999998");
  assert.equal(result.ok, false);
  assert.equal(result.text, FALLBACK_REPLY);
});

// --- error classification -------------------------------------------------

test("classification survives the shared APIError base class", () => {
  assert.equal(classifyError(unauthorized())["kind"], "auth");
  assert.equal(classifyError(rateLimited())["kind"], "rate_limit");
  assert.equal(classifyError(notFound())["kind"], "not_found");
  assert.equal(classifyError(apiError(503))["kind"], "server");
  assert.equal(classifyError(apiError(400))["kind"], "api_error");

  // Every class above extends APIError; a broad check placed first would
  // collapse them all into one bucket.
  const conn = new Anthropic.APIConnectionError({ message: "socket hang up" });
  assert.equal(classifyError(conn)["kind"], "connection");
});

test("a missing credential is named, not filed as unknown", () => {
  // The SDK throws a plain Error when nothing resolves, so this is inferred
  // from config rather than matched on message text.
  const result = classifyError(new Error("Could not resolve authentication method."));
  assert.equal(result["kind"], "no_credential");
  assert.match(String(result["hint"]), /ANTHROPIC_AUTH_TOKEN/);
});
