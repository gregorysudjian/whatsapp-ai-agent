import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { config } from "../config.ts";
import { recordInbound, pauseForHuman, isPaused, setAgentEnabled } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";
import { DEFAULT_BUSINESS_ID as B } from "../store/businesses.ts";

let server: Server;
let baseUrl: string;
const token = config.dashboard.token;

const seed = (waId: string): void => {
  const id = `dash-${waId}`;
  const msg: InboundMessage = {
    id, from: waId, senderName: "Dash", timestamp: new Date(), text: "hello",
    raw: { id, from: waId, timestamp: "0", type: "text", text: { body: "hello" } },
  };
  recordInbound(B, msg);
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setAgentEnabled(B, true);
  await new Promise((r) => server.close(r));
});

test("every dashboard route requires the token", async () => {
  for (const path of ["/dashboard", "/api/stats", "/api/conversations", "/api/events"]) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 401, `${path} must be gated`);
  }
});

test("the write routes are gated too", async () => {
  const toggle = await fetch(`${baseUrl}/api/agent/toggle`, { method: "POST" });
  assert.equal(toggle.status, 401, "an unauthenticated kill switch would be worse than none");

  const clear = await fetch(`${baseUrl}/api/conversations/123/clear-handoff`, { method: "POST" });
  assert.equal(clear.status, 401);
});

test("a wrong token is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/stats?token=not-the-token`);
  assert.equal(res.status, 401);
});

test("the toggle flips the agent and reports the new state", async () => {
  const off = await fetch(`${baseUrl}/api/agent/toggle?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.deepEqual(await off.json(), { agentEnabled: false });

  const stats = await (
    await fetch(`${baseUrl}/api/stats?token=${token}`)
  ).json() as { agentEnabled: boolean };
  assert.equal(stats.agentEnabled, false, "the dashboard must reflect it immediately");

  const on = await fetch(`${baseUrl}/api/agent/toggle?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(await on.json(), { agentEnabled: true });
});

test("a conversation needing a human is flagged and sorted to the top", async () => {
  seed("19100000001");
  seed("19100000002");
  pauseForHuman(B, "19100000002", "customer asked for a person");

  const conversations = await (
    await fetch(`${baseUrl}/api/conversations?token=${token}`)
  ).json() as Array<{ waId: string; needsHuman: boolean; handoffReason: string | null }>;

  assert.equal(conversations[0]?.waId, "19100000002", "the queue someone must work is first");
  assert.equal(conversations[0]?.needsHuman, true);
  assert.equal(conversations[0]?.handoffReason, "customer asked for a person");
});

test("clearing the handoff from the dashboard resumes the agent there", async () => {
  const res = await fetch(
    `${baseUrl}/api/conversations/19100000002/clear-handoff?token=${token}`,
    { method: "POST" },
  );
  assert.equal(res.status, 200);
  assert.equal(isPaused(B, "19100000002"), false);
});
