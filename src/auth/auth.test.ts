/**
 * Login, sessions and request-level protections, over real HTTP.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { call, makeUser, cookieFor } from "../testing/auth.ts";
import { resetLoginThrottle } from "./middleware.ts";
import { resolveSession, createSession, IDLE_MS, ABSOLUTE_MS } from "./sessions.ts";
import { setUserActive } from "../store/users.ts";
import { db } from "../store/db.ts";
import { DEFAULT_BUSINESS_ID } from "../store/businesses.ts";

let server: Server;
let base: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => resetLoginThrottle());

const login = (email: string, password: string, origin?: string | null) =>
  call(base, "/api/auth/login", { method: "POST", body: { email, password }, ...(origin !== undefined ? { origin } : {}) });

function sessionCookie(headers: Headers): string | undefined {
  return headers.getSetCookie().find((c) => c.startsWith("wa_session="));
}

// --- login ------------------------------------------------------------------

test("a correct login sets a hardened session cookie and returns the user", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const res = await login(owner.user.email, owner.password);

  assert.equal(res.status, 200);
  const cookie = sessionCookie(res.headers)!;
  assert.ok(cookie, "a session cookie must be set");
  assert.match(cookie, /HttpOnly/i, "JavaScript must not be able to read the session");
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal((res.json["user"] as { email: string }).email, owner.user.email);
  assert.deepEqual((res.json["businesses"] as { id: number }[]).map((b) => b.id), [DEFAULT_BUSINESS_ID]);
  assert.ok(!JSON.stringify(res.json).includes("scrypt$"), "no hash in any response");
});

test("email is case-insensitive at login", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  assert.equal((await login(owner.user.email.toUpperCase(), owner.password)).status, 200);
});

test("wrong password and unknown email are indistinguishable", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const wrong = await login(owner.user.email, "not-the-password-at-all");
  const unknown = await login("nobody-here@example.test", "not-the-password-at-all");

  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.json, unknown.json, "a different answer would reveal which emails have accounts");
  assert.equal(sessionCookie(wrong.headers), undefined);
});

test("five failures lock the account's login, even with the right password", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  for (let i = 0; i < 5; i++) await login(owner.user.email, `wrong-password-${i}`);
  const res = await login(owner.user.email, owner.password);
  assert.equal(res.status, 401, "locked");
  assert.equal(res.json["error"], "invalid_credentials", "and saying so would confirm the account exists");
});

test("a deactivated user cannot log in, and their open sessions stop working", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  setUserActive(owner.user.id, false);
  try {
    assert.equal((await login(owner.user.email, owner.password)).status, 401);
    assert.equal((await call(base, "/api/auth/me", { cookie: owner.cookie })).status, 401);
  } finally {
    setUserActive(owner.user.id, true);
  }
});

// --- sessions ---------------------------------------------------------------

test("only a hash of the session token is stored", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const token = owner.cookie.split("=")[1]!;
  const rows = db.prepare(`SELECT token_hash FROM sessions WHERE user_id = ?`).all(owner.user.id) as { token_hash: string }[];
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.token_hash !== token), "the raw token must never be in the database");
  assert.ok(rows.some((r) => r.token_hash === crypto.createHash("sha256").update(token).digest("hex")));
});

test("logout ends the session on the server, not just in the browser", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  assert.equal((await call(base, "/api/auth/me", { cookie: owner.cookie })).status, 200);
  await call(base, "/api/auth/logout", { method: "POST", cookie: owner.cookie });
  assert.equal((await call(base, "/api/auth/me", { cookie: owner.cookie })).status, 401,
    "a copied cookie must be dead after logout");
});

test("a session dies after 12 idle hours, and after 7 days regardless", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const token = createSession(owner.user.id);
  const now = Date.now();

  assert.ok(resolveSession(token, now + IDLE_MS - 60_000), "just inside the idle window");
  assert.equal(resolveSession(token, now + IDLE_MS + 60_000 + IDLE_MS), undefined, "idle too long");

  const busy = createSession(owner.user.id);
  // Keep touching it every few hours; the absolute limit still ends it.
  let t = now;
  while (t < now + ABSOLUTE_MS - IDLE_MS) {
    t += IDLE_MS / 2;
    assert.ok(resolveSession(busy, t), `still valid at +${Math.round((t - now) / 3_600_000)}h`);
  }
  assert.equal(resolveSession(busy, now + ABSOLUTE_MS + 1000), undefined, "absolute expiry");
});

test("changing the password logs out every other device", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const laptop = owner.cookie;
  const phone = cookieFor(owner.user.id);

  const res = await call(base, "/api/auth/password", {
    method: "POST", cookie: laptop,
    body: { currentPassword: owner.password, newPassword: "a-brand-new-passphrase-1" },
  });
  assert.equal(res.status, 200);
  assert.equal((await call(base, "/api/auth/me", { cookie: laptop })).status, 200, "the device that changed it stays in");
  assert.equal((await call(base, "/api/auth/me", { cookie: phone })).status, 401, "every other device is out");
});

test("the current password is required to set a new one", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const res = await call(base, "/api/auth/password", {
    method: "POST", cookie: owner.cookie,
    body: { currentPassword: "guessing-wrong-here", newPassword: "a-brand-new-passphrase-2" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json["error"], "wrong_current_password");
});

test("a forced password change blocks customer data until it is done", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID, { mustChangePassword: true });
  assert.equal((await call(base, "/api/auth/me", { cookie: owner.cookie })).status, 200, "can see who they are");
  const blocked = await call(base, `/api/b/${DEFAULT_BUSINESS_ID}/summary`, { cookie: owner.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json["error"], "password_change_required");

  await call(base, "/api/auth/password", {
    method: "POST", cookie: owner.cookie,
    body: { currentPassword: owner.password, newPassword: "now-a-proper-passphrase" },
  });
  assert.equal((await call(base, `/api/b/${DEFAULT_BUSINESS_ID}/summary`, { cookie: owner.cookie })).status, 200);
});

// --- request-level protections ---------------------------------------------

test("a write from a foreign origin is refused", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const res = await call(base, "/api/auth/logout", { method: "POST", cookie: owner.cookie, origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(res.json["error"], "bad_origin");
  assert.equal((await call(base, "/api/auth/me", { cookie: owner.cookie })).status, 200, "and it did nothing");
});

test("a write the browser marks cross-site is refused", async () => {
  const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
  const res = await call(base, "/api/auth/logout", {
    method: "POST", cookie: owner.cookie, origin: null, headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

test("every response carries the security headers", async () => {
  const res = await call(base, "/health");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("a malformed login body is a 400 naming the field, not a crash", async () => {
  const res = await call(base, "/api/auth/login", { method: "POST", body: { email: 42 } });
  assert.equal(res.status, 400);
  assert.ok((res.json["issues"] as { path: string }[]).some((i) => i.path === "email"));
});
