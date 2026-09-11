import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness } from "../store/businesses.ts";
import { listAudit } from "../store/audit.ts";

let server: Server;
let base: string;
let owner: TestUser;
let bid: number;

before(async () => {
  bid = createBusiness({ name: "API Settings Co" }).id;
  owner = await makeUser("owner", bid);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

const get = (path: string) => call(base, `/api/b/${bid}${path}`, { cookie: owner.cookie });
const send = (method: string, path: string, body: unknown) => call(base, `/api/b/${bid}${path}`, { method, cookie: owner.cookie, body });

test("an owner reads their settings, hours and services in one call", async () => {
  const res = await get("/settings");
  assert.equal(res.status, 200);
  assert.equal((res.json["business"] as { name: string }).name, "API Settings Co");
  assert.ok(res.json["settings"] && res.json["schedule"] && Array.isArray(res.json["services"]));
});

test("saving settings updates the prompt the agent sees, and is audited", async () => {
  const current = (await get("/settings")).json as { settings: Record<string, unknown> };
  const res = await send("PUT", "/settings", {
    business: { name: "API Settings Co", timezone: "America/Toronto", defaultLanguage: "fr" },
    settings: { ...current.settings, about: "Physiotherapy clinic", languages: ["fr", "en"] },
  });
  assert.equal(res.status, 200);

  const preview = (await get("/settings/preview")).json as { prompt: string; context: string };
  assert.match(preview.prompt, /Physiotherapy clinic/);
  assert.match(preview.prompt, /Otherwise reply in French/);
  assert.match(preview.context, /America\/Toronto/);

  assert.ok(listAudit(bid).some((a) => a.action === "settings_updated" && a.userId === owner.user.id));
});

test("an invalid save is refused with a readable reason, and nothing changes", async () => {
  const before = (await get("/settings")).json as { settings: { about: string } };
  const res = await send("PUT", "/settings", { settings: { ...before.settings, tone: "sarcastic" } });
  assert.equal(res.status, 400);
  assert.match(String(res.json["message"]), /tone/);
  const afterSave = (await get("/settings")).json as { settings: { about: string } };
  assert.equal(afterSave.settings.about, before.settings.about);
});

test("hours are saved and bad hours refused", async () => {
  assert.equal((await send("PUT", "/schedule", { "2": { open: "09:00", close: "12:00" } })).status, 200);
  const bad = await send("PUT", "/schedule", { "2": { open: "12:00", close: "09:00" } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.json["message"]), /closes before it opens/);
});

test("services: add, edit, retire - and a missing id is a 404, not a crash", async () => {
  const created = await send("POST", "/services", { name: "Assessment", durationMin: 45, priceCents: 9000, currency: "CAD" });
  assert.equal(created.status, 201);
  const id = (created.json["service"] as { id: number }).id;

  const edited = await send("PUT", `/services/${id}`, { name: "Assessment", durationMin: 60, priceCents: 9500, currency: "CAD" });
  assert.equal((edited.json["service"] as { durationMin: number }).durationMin, 60);

  assert.equal((await send("DELETE", `/services/${id}`, {})).status, 200);
  assert.equal((await send("DELETE", "/services/999999", {})).status, 404);
  assert.equal((await send("PUT", "/services/999999", { name: "X", durationMin: 10, priceCents: null, currency: "CAD" })).status, 404);

  const bad = await send("POST", "/services", { name: "X", durationMin: -5, priceCents: null, currency: "CAD" });
  assert.equal(bad.status, 400);
});
