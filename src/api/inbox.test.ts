/**
 * The inbox: a person takes a conversation from the agent, replies by hand,
 * and hands it back. Driven end to end - signed webhooks in, the mock Graph
 * out - because "the AI stays quiet while a person has the conversation" is
 * only true if the real webhook path honours it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { deliver, targetFor, textMessagePayload, type Target } from "../testing/webhook.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { setClientForTesting, type MessagesClient } from "../agent/claude.ts";
import { createBusiness, setWhatsappCredentials } from "../store/businesses.ts";
import { isPaused, pauseForHuman, recordInbound } from "../store/db.ts";
import { listMessages } from "../store/queries.ts";
import { listAudit } from "../store/audit.ts";

const graph = new MockGraph();
let server: Server;
let base: string;
let A: number;
let B: number;
let U: number; // not connected to WhatsApp
let targetA: Target;
let owner: TestUser;
let ownerB: TestUser;

let modelCalls = 0;
/** When set, the model "thinks" until this promise resolves. */
let gate: Promise<void> | undefined;

const fakeModel = {
  messages: {
    stream: () => {
      modelCalls++;
      return {
        finalMessage: async () => {
          if (gate) await gate;
          return {
            id: "m", type: "message", role: "assistant", model: "claude-opus-5",
            content: [{ type: "text", text: "agent reply", citations: [] }],
            stop_reason: "end_turn", stop_sequence: null,
            usage: {
              input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null,
              cache_read_input_tokens: 0, server_tool_use: null, service_tier: null,
            },
          };
        },
      };
    },
  },
} as unknown as MessagesClient;

const settle = () => new Promise((r) => setTimeout(r, 250));

before(async () => {
  A = createBusiness({ name: "Inbox Clinic" }).id;
  B = createBusiness({ name: "Inbox Neighbour" }).id;
  U = createBusiness({ name: "Inbox Unconnected" }).id;
  setWhatsappCredentials(A, {
    phoneNumberId: "444444444444401", accessToken: "inbox-a-access-token-000000",
    appSecret: "inbox-a-secret-000000", verifyToken: "inbox-a-verify",
  });
  setWhatsappCredentials(B, {
    phoneNumberId: "444444444444402", accessToken: "inbox-b-access-token-000000",
    appSecret: "inbox-b-secret-000000", verifyToken: "inbox-b-verify",
  });
  targetA = targetFor(A);
  owner = await makeUser("owner", A);
  ownerB = await makeUser("owner", B);

  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  setClientForTesting(fakeModel);
});

after(async () => {
  setClientForTesting(undefined);
  await graph.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/** A customer message into business A, through the signed webhook. */
async function customerSays(from: string, text: string, opts: { name?: string; timestamp?: number } = {}) {
  const payload = textMessagePayload(text, { from, phoneNumberId: targetA.phoneNumberId, ...opts });
  const res = await deliver(base, payload, targetA);
  assert.equal(res.status, 200);
  await settle();
}

const api = (path: string, opts: Parameters<typeof call>[2] = {}) =>
  call(base, `/api/b/${A}${path}`, { cookie: owner.cookie, ...opts });

// --- the loop the feature exists for ------------------------------------------

test("take over silences the agent, a manual reply goes out as the person, hand back resumes it", async () => {
  const wa = "15557000001";
  graph.reset();
  await customerSays(wa, "hi, can I book?");
  assert.deepEqual(graph.sentTexts, ["agent reply"], "the agent answers while it has the conversation");

  const took = await api(`/conversations/${wa}/takeover`, { method: "POST" });
  assert.equal(took.status, 200);
  assert.equal((took.json["conversation"] as Record<string, unknown>)["control"], "human");
  assert.equal((took.json["conversation"] as Record<string, unknown>)["takenOverBy"], owner.user.email);

  graph.reset();
  const before = modelCalls;
  await customerSays(wa, "are you a real person?");
  assert.equal(graph.sentTexts.length, 0, "no AI reply while a person has it");
  assert.equal(modelCalls, before, "and no model call either - it costs nothing");

  const reply = await api(`/conversations/${wa}/reply`, { method: "POST", body: { text: "Yes - this is Sam at the clinic." } });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  assert.deepEqual(graph.sentTexts, ["Yes - this is Sam at the clinic."]);

  const thread = listMessages(A, wa);
  const last = thread.at(-1)!;
  assert.equal(last.sender, "human");
  assert.equal(last.sentBy, owner.user.email, "the thread says which person wrote it");
  assert.equal(thread[0]!.sender, "customer");
  assert.equal(thread[1]!.sender, "ai");

  const back = await api(`/conversations/${wa}/handback`, { method: "POST" });
  assert.equal(back.status, 200);
  assert.equal(isPaused(A, wa), false);

  graph.reset();
  await customerSays(wa, "thanks!");
  assert.deepEqual(graph.sentTexts, ["agent reply"], "the agent is back");
});

test("replying to a conversation the agent has takes it over first", async () => {
  const wa = "15557000002";
  await customerSays(wa, "hello");
  assert.equal(isPaused(A, wa), false);

  const reply = await api(`/conversations/${wa}/reply`, { method: "POST", body: { text: "Hi, jumping in." } });
  assert.equal(reply.status, 201);
  assert.equal(isPaused(A, wa), true, "otherwise the agent would talk over the person");

  graph.reset();
  await customerSays(wa, "ok");
  assert.equal(graph.sentTexts.length, 0);
});

test("a reply the agent was still writing is dropped when a person takes over", async () => {
  const wa = "15557000003";
  await customerSays(wa, "first");
  graph.reset();

  let release!: () => void;
  gate = new Promise((r) => { release = r; });
  try {
    const payload = textMessagePayload("second", { from: wa, phoneNumberId: targetA.phoneNumberId });
    await deliver(base, payload, targetA);
    await settle(); // the model is now "thinking"
    await api(`/conversations/${wa}/takeover`, { method: "POST" });
    release();
    await settle();
  } finally {
    gate = undefined;
  }
  assert.equal(graph.sentTexts.length, 0, "the stale AI reply must not land on top of the person");
});

test("the agent handing off by itself does not suppress its own hand-off message", async () => {
  // pauseForHuman sets control to human with no person attached; the
  // in-flight guard must only fire for a person taking over.
  const wa = "15557000004";
  await customerSays(wa, "hello");
  graph.reset();

  let release!: () => void;
  gate = new Promise((r) => { release = r; });
  try {
    const payload = textMessagePayload("I want a person", { from: wa, phoneNumberId: targetA.phoneNumberId });
    await deliver(base, payload, targetA);
    await settle();
    // What the handoff tool does mid-generation.
    pauseForHuman(A, wa, "customer asked for a human");
    release();
    await settle();
  } finally {
    gate = undefined;
  }
  assert.deepEqual(graph.sentTexts, ["agent reply"], "the agent's own 'a colleague will follow up' still goes");

  const convs = await api(`/conversations?filter=needs_human`);
  const row = (convs.json["conversations"] as Record<string, unknown>[]).find((c) => c["waId"] === wa);
  assert.ok(row, "an escalated conversation is in the needs-a-person filter");
  assert.equal(row["takenOverBy"], null);
});

// --- refusals -----------------------------------------------------------------

test("outside the 24h window a manual reply is refused, not silently dropped", async () => {
  const wa = "15557000005";
  const twoDaysAgo = Math.floor((Date.now() - 48 * 3600_000) / 1000);
  await customerSays(wa, "old message", { timestamp: twoDaysAgo });
  graph.reset();
  const res = await api(`/conversations/${wa}/reply`, { method: "POST", body: { text: "sorry for the wait" } });
  assert.equal(res.status, 409);
  assert.equal(res.json["error"], "window_closed");
  assert.equal(graph.sentTexts.length, 0);
});

test("a business with no WhatsApp connection gets not_connected", async () => {
  const wa = "15557000006";
  recordInbound(U, {
    id: `wamid.inbox-u-${Date.now()}`, from: wa, text: "hello", senderName: "X",
    timestamp: new Date(), raw: { type: "text" },
  } as Parameters<typeof recordInbound>[1]);
  const admin = await makeUser("super_admin");
  const res = await call(base, `/api/b/${U}/conversations/${wa}/reply`, {
    method: "POST", cookie: admin.cookie, body: { text: "hi" },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json["error"], "not_connected");
});

test("reply text is validated", async () => {
  const wa = "15557000002";
  for (const text of ["", "   ", "x".repeat(4097)]) {
    const res = await api(`/conversations/${wa}/reply`, { method: "POST", body: { text } });
    assert.equal(res.status, 400, `text of length ${text.length}`);
  }
  const extra = await api(`/conversations/${wa}/reply`, { method: "POST", body: { text: "hi", sender: "ai" } });
  assert.equal(extra.status, 400, "unknown fields are refused, not ignored");
});

test("unknown, malformed and other businesses' conversations all look the same", async () => {
  // B has a real conversation; A's owner must not be able to tell.
  recordInbound(B, {
    id: `wamid.inbox-b-${Date.now()}`, from: "15557000099", text: "private to B", senderName: "B's customer",
    timestamp: new Date(), raw: { type: "text" },
  } as Parameters<typeof recordInbound>[1]);
  for (const wa of ["15557000099", "15550000000", "abc", "1".repeat(30)]) {
    for (const [method, path] of [["GET", "messages"], ["POST", "takeover"], ["POST", "handback"]] as const) {
      const res = await api(`/conversations/${wa}/${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path} for ${wa}`);
      assert.equal(res.json["error"], "conversation_not_found");
    }
  }
  assert.equal(isPaused(B, "15557000099"), false, "and nothing happened to B's conversation");
});

// --- list, search, audit --------------------------------------------------------

test("the list filters by who has the conversation and searches name and number", async () => {
  await customerSays("15557000010", "hello", { name: "Zoé 100% Tremblay" });
  const all = await api(`/conversations`);
  const waIds = (all.json["conversations"] as Record<string, unknown>[]).map((c) => c["waId"]);
  assert.ok(waIds.includes("15557000001") && waIds.includes("15557000010"));
  assert.ok(!waIds.includes("15557000099"), "B's conversation is not in A's list");

  const human = await api(`/conversations?filter=human`);
  for (const c of human.json["conversations"] as Record<string, unknown>[]) assert.equal(c["control"], "human");
  const ai = await api(`/conversations?filter=ai`);
  for (const c of ai.json["conversations"] as Record<string, unknown>[]) assert.equal(c["control"], "ai");

  const byName = await api(`/conversations?q=${encodeURIComponent("zoé")}`);
  assert.deepEqual((byName.json["conversations"] as Record<string, unknown>[]).map((c) => c["waId"]), ["15557000010"]);
  const byNumber = await api(`/conversations?q=7000010`);
  assert.deepEqual((byNumber.json["conversations"] as Record<string, unknown>[]).map((c) => c["waId"]), ["15557000010"]);

  // "%" is a character to find, not a wildcard that matches everything.
  const percent = await api(`/conversations?q=${encodeURIComponent("100%")}`);
  assert.deepEqual((percent.json["conversations"] as Record<string, unknown>[]).map((c) => c["waId"]), ["15557000010"]);
  const underscore = await api(`/conversations?q=_`);
  assert.equal((underscore.json["conversations"] as unknown[]).length, 0);

  const bad = await api(`/conversations?filter=everything`);
  assert.equal(bad.status, 400);
});

test("take over, reply and hand back are audited, and the audit holds no message text", async () => {
  const actions = listAudit(A).filter((r) => r.userId === owner.user.id).map((r) => r.action);
  for (const a of ["conversation_taken_over", "conversation_replied", "conversation_handed_back"]) {
    assert.ok(actions.includes(a), `missing ${a}`);
  }
  const details = listAudit(A).map((r) => r.detail ?? "").join(" ");
  assert.ok(!details.includes("Sam at the clinic"), "reply text must not be copied into the audit log");
});

test("the kill switch is reachable from the dashboard and audited", async () => {
  const off = await api(`/agent`, { method: "PUT", body: { enabled: false } });
  assert.equal(off.json["agentEnabled"], false);
  const on = await api(`/agent`, { method: "PUT", body: { enabled: true } });
  assert.equal(on.json["agentEnabled"], true);
  const bad = await api(`/agent`, { method: "PUT", body: { enabled: "no" } });
  assert.equal(bad.status, 400);
  const actions = listAudit(A).map((r) => r.action);
  assert.ok(actions.includes("agent_disabled") && actions.includes("agent_enabled"));
});

// --- live updates ---------------------------------------------------------------

/** Open the stream and collect its data lines until `stop()`. */
async function openStream(bid: number, cookie: string) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/b/${bid}/stream`, { headers: { cookie }, signal: controller.signal });
  const events: Record<string, unknown>[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
        }
      }
    } catch { /* aborted */ }
  })();
  return { res, events, stop: async () => { controller.abort(); await pump; } };
}

test("the live stream carries this business's events and no one else's", async () => {
  const streamA = await openStream(A, owner.cookie);
  assert.equal(streamA.res.status, 200);
  assert.match(streamA.res.headers.get("content-type") ?? "", /text\/event-stream/);

  recordInbound(B, {
    id: `wamid.inbox-b2-${Date.now()}`, from: "15557000098", text: "B only", senderName: null,
    timestamp: new Date(), raw: { type: "text" },
  } as unknown as Parameters<typeof recordInbound>[1]);
  await customerSays("15557000011", "A's customer");
  await streamA.stop();

  assert.ok(streamA.events.some((e) => e["waId"] === "15557000011"), "A's own message arrives live");
  assert.ok(streamA.events.every((e) => e["businessId"] === A), "nothing from another business");
  assert.ok(!streamA.events.some((e) => e["waId"] === "15557000098"));
});

test("the stream refuses another business's owner", async () => {
  const res = await call(base, `/api/b/${A}/stream`, { cookie: ownerB.cookie });
  assert.equal(res.status, 404);
});
