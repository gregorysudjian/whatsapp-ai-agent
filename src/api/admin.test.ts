/**
 * The super admin's panel: clients, credentials, owner accounts, usage and
 * the audit trail. (That owners can't reach any of it is authz.test.ts.)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness, getWhatsappCredentials } from "../store/businesses.ts";
import { db } from "../store/db.ts";
import { getCredentialsForLogin, getUser } from "../store/users.ts";
import { verifyPassword } from "../auth/passwords.ts";
import { usageForMonth } from "../store/usage.ts";

let admin: TestUser;
let server: Server;
let base: string;

const TOKEN = "EAAT-admin-test-access-token-0123456789";
const SECRET = "admin-test-app-secret-0123456789";
const VERIFY = "admin-test-verify-0123";

before(async () => {
  admin = await makeUser("super_admin");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise((r) => server.close(r)); });

const api = (path: string, opts: Parameters<typeof call>[2] = {}) => call(base, `/api/admin${path}`, { cookie: admin.cookie, ...opts });

test("create a client, edit it, deactivate it", async () => {
  const created = await api("/businesses", { method: "POST", body: { name: "Admin Test Clinic", timezone: "America/Halifax", defaultLanguage: "fr" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const b = created.json["business"] as Record<string, unknown>;
  assert.equal(b["timezone"], "America/Halifax");
  assert.match(String(b["webhookPath"]), /^\/webhook\/b\/[A-Za-z0-9_-]{12}$/);
  assert.equal(b["hasCredentials"], false);

  const id = Number(b["id"]);
  const edited = await api(`/businesses/${id}`, { method: "PATCH", body: { name: "Admin Test Clinic 2", status: "inactive" } });
  assert.equal((edited.json["business"] as Record<string, unknown>)["name"], "Admin Test Clinic 2");
  assert.equal((edited.json["business"] as Record<string, unknown>)["status"], "inactive");

  assert.equal((await api("/businesses", { method: "POST", body: { name: "X" } })).status, 400, "too short a name");
  assert.equal((await api("/businesses", { method: "POST", body: { name: "Mars Base", timezone: "Mars/Olympus" } })).status, 400);
  assert.equal((await api(`/businesses/999999`, { method: "PATCH", body: { name: "Ghost" } })).status, 404);
});

test("credentials go in encrypted and never come back out", async () => {
  const b = createBusiness({ name: "Admin Creds Co" });
  const res = await api(`/businesses/${b.id}/credentials`, {
    method: "PUT",
    body: { phoneNumberId: "777777777777701", accessToken: TOKEN, appSecret: SECRET, verifyToken: VERIFY },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(getWhatsappCredentials(b.id)?.accessToken, TOKEN, "stored and decryptable");

  const raw = db.prepare(`SELECT * FROM businesses WHERE id = ?`).get(b.id) as Record<string, unknown>;
  assert.ok(!JSON.stringify(raw).includes(TOKEN), "encrypted at rest");

  // Every admin read, and the write's own answer, carry only the redacted form.
  const responses = [res, await api("/businesses"), await api(`/businesses/${b.id}`), await api("/audit"), await api("/usage")];
  for (const r of responses) {
    const text = JSON.stringify(r.json);
    for (const s of [TOKEN, SECRET, VERIFY]) assert.ok(!text.includes(s), `a secret leaked: ${s.slice(0, 12)}…`);
  }
  const creds = (res.json["business"] as Record<string, Record<string, string>>)["credentials"]!;
  assert.equal(creds["phoneNumberId"], "777777777777701");
  assert.notEqual(creds["accessToken"], TOKEN);

  const clash = createBusiness({ name: "Admin Creds Rival" });
  const taken = await api(`/businesses/${clash.id}/credentials`, {
    method: "PUT", body: { phoneNumberId: "777777777777701", accessToken: TOKEN, appSecret: SECRET, verifyToken: VERIFY },
  });
  assert.equal(taken.status, 400, "one number, one client");
  assert.equal((await api(`/businesses/${b.id}/credentials`, { method: "PUT", body: { phoneNumberId: "abc", accessToken: "x", appSecret: "y", verifyToken: "z" } })).status, 400);
});

test("an owner account gets a temporary password shown once, then must change it", async () => {
  const b = createBusiness({ name: "Admin Owners Co", defaultLanguage: "fr" });
  const res = await api(`/businesses/${b.id}/owners`, { method: "POST", body: { email: "New.Owner@Example.test" } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const temp = String(res.json["temporaryPassword"]);
  assert.ok(temp.length >= 12);
  const login = getCredentialsForLogin("new.owner@example.test")!;
  assert.ok(await verifyPassword(temp, login.passwordHash));
  assert.equal(login.user.mustChangePassword, true);
  assert.equal(login.user.locale, "fr", "starts in the business's language");
  assert.equal(login.user.businessId, b.id);

  const list = await api(`/businesses/${b.id}`);
  assert.ok(!JSON.stringify(list.json).includes(temp), "the password is never shown again");

  assert.equal((await api(`/businesses/${b.id}/owners`, { method: "POST", body: { email: "new.owner@example.test" } })).status, 400, "no duplicate emails");
  assert.equal((await api(`/businesses/${b.id}/owners`, { method: "POST", body: { email: "not-an-email" } })).status, 400);

  const reset = await api(`/users/${login.user.id}/reset-password`, { method: "POST", body: {} });
  const temp2 = String(reset.json["temporaryPassword"]);
  assert.notEqual(temp2, temp);
  assert.ok(await verifyPassword(temp2, getCredentialsForLogin("new.owner@example.test")!.passwordHash));

  const off = await api(`/users/${login.user.id}`, { method: "PATCH", body: { active: false } });
  assert.equal(off.status, 200);
  assert.equal(getUser(login.user.id)?.active, false);

  assert.equal((await api(`/users/${admin.user.id}`, { method: "PATCH", body: { active: false } })).status, 404,
    "super admins are not managed from the panel - and cannot lock themselves out");
});

test("usage is counted per client for the month, in the client's own timezone", async () => {
  const b = createBusiness({ name: "Admin Usage Co", timezone: "Asia/Tokyo" });
  const other = createBusiness({ name: "Admin Usage Other" });
  const insert = db.prepare(`
    INSERT INTO messages (id, business_id, wa_id, direction, type, text, ts, sender, input_tokens, output_tokens, cache_read_tokens)
    VALUES (?, ?, '81', ?, ?, 'x', ?, ?, ?, ?, ?)
  `);
  let n = 0;
  const at = (iso: string) => Date.parse(iso);
  const row = (bid: number, dir: string, type: string, iso: string, sender: string, tokens: [number, number, number] | null = null) =>
    insert.run(`usage-${bid}-${++n}`, bid, dir, type, at(iso), sender, tokens?.[0] ?? null, tokens?.[1] ?? null, tokens?.[2] ?? null);

  // Tokyo's September starts on Aug 31 at 15:00 UTC.
  row(b.id, "in", "text", "2030-08-31T14:59:00Z", "customer"); // August in Tokyo
  row(b.id, "in", "text", "2030-08-31T15:00:00Z", "customer"); // September
  row(b.id, "out", "text", "2030-08-31T15:00:10Z", "ai", [1_000_000, 100_000, 2_000_000]);
  row(b.id, "out", "text", "2030-09-10T10:00:00Z", "human");
  row(b.id, "out", "template", "2030-09-11T10:00:00Z", "system");
  row(other.id, "in", "text", "2030-09-05T10:00:00Z", "customer");

  const [u] = usageForMonth("2030-09", [b.id]);
  assert.deepEqual(
    { inbound: u!.inbound, ai: u!.aiReplies, human: u!.humanReplies, templates: u!.templateSends, i: u!.inputTokens, o: u!.outputTokens, c: u!.cachedTokens },
    { inbound: 1, ai: 1, human: 1, templates: 1, i: 1_000_000, o: 100_000, c: 2_000_000 },
  );
  // $5/M in + $25/M out + $0.50/M cached = 5 + 2.5 + 1
  assert.equal(u!.estimatedCostUsd, 8.5);

  const res = await api("/usage?month=2030-09");
  const rows = res.json["rows"] as Record<string, unknown>[];
  assert.equal(rows.find((r) => r["businessId"] === b.id)!["inbound"], 1);
  assert.equal(rows.find((r) => r["businessId"] === other.id)!["inbound"], 1);
  assert.equal((await api("/usage?month=2030-13")).status, 400);

  const csv = await fetch(`${base}/api/admin/usage.csv?month=2030-09`, { headers: { cookie: admin.cookie } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Admin Usage Co,active,1,1,1,1,1000000,100000,2000000,8\.50/);
});

test("the audit log filters by client and action", async () => {
  const all = await api("/audit");
  const entries = all.json["entries"] as Record<string, unknown>[];
  assert.ok(entries.some((e) => e["action"] === "credentials_updated"));
  assert.ok((all.json["actions"] as string[]).includes("owner_created"));

  const only = await api("/audit?action=owner_created");
  assert.ok((only.json["entries"] as Record<string, unknown>[]).every((e) => e["action"] === "owner_created"));
  assert.equal((await api("/audit?action=DROP%20TABLE")).status, 400);
});
