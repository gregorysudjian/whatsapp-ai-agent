import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { textMessagePayload, deliver } from "../testing/webhook.ts";
import { setClientForTesting, type MessagesClient } from "../agent/claude.ts";
import { agentEnabled, setAgentEnabled, pauseForHuman, clearHandoff, isPaused } from "../store/db.ts";
import { listMessages } from "../store/queries.ts";

const graph = new MockGraph();
let server: Server;
let baseUrl: string;
let modelCalls = 0;

const countingClient = {
  messages: {
    stream: () => {
      modelCalls++;
      return {
        finalMessage: async () => ({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: "a reply", citations: [] }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: {
            input_tokens: 1, output_tokens: 1,
            cache_creation_input_tokens: null, cache_read_input_tokens: 0,
            server_tool_use: null, service_tier: null,
          },
        }),
      };
    },
  },
} as unknown as MessagesClient;

test("setup", async () => {
  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  setClientForTesting(countingClient);
});

after(async () => {
  setAgentEnabled(true);
  setClientForTesting(undefined);
  await graph.close();
  await new Promise((r) => server.close(r));
});

const settle = () => new Promise((r) => setTimeout(r, 250));

test("the agent is on by default", () => {
  assert.equal(agentEnabled(), true);
});

test("with the agent off, messages are stored but not answered", async () => {
  const wa = "16000000001";
  setAgentEnabled(false);
  graph.reset();
  modelCalls = 0;

  await deliver(baseUrl, textMessagePayload("anyone there?", { from: wa }));
  await settle();

  assert.equal(graph.sentTexts.length, 0, "no reply while disabled");
  assert.equal(modelCalls, 0, "the model must not be called - that is the point");
  assert.equal(listMessages(wa).length, 1, "the question is still captured");
  assert.equal(listMessages(wa)[0]?.text, "anyone there?");
});

test("turning it back on resumes replies", async () => {
  const wa = "16000000002";
  setAgentEnabled(true);
  graph.reset();

  await deliver(baseUrl, textMessagePayload("hello again", { from: wa }));
  await settle();

  assert.deepEqual(graph.sentTexts, ["a reply"]);
});

test("a paused conversation is silent while others continue", async () => {
  const paused = "16000000003";
  const normal = "16000000004";
  graph.reset();

  // The contact must exist before it can be paused.
  await deliver(baseUrl, textMessagePayload("first message", { from: paused }));
  await settle();
  graph.reset();

  pauseForHuman(paused, "customer asked for a human");
  assert.equal(isPaused(paused), true);

  await deliver(baseUrl, textMessagePayload("still there?", { from: paused }));
  await deliver(baseUrl, textMessagePayload("unrelated question", { from: normal }));
  await settle();

  assert.equal(graph.sentTexts.length, 1, "only the un-paused contact is answered");
  assert.equal(listMessages(paused).filter((m) => m.direction === "in").length, 2,
    "the paused contact's messages are still captured for the human");
});

test("clearing the handoff resumes that conversation", async () => {
  const wa = "16000000003";
  clearHandoff(wa);
  assert.equal(isPaused(wa), false);
  graph.reset();

  await deliver(baseUrl, textMessagePayload("are you back?", { from: wa }));
  await settle();
  assert.equal(graph.sentTexts.length, 1);
});
