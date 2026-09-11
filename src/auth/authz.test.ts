/**
 * The route-table authorization test.
 *
 * Rather than a hand-written list of routes (which goes stale the day a route
 * is added), this walks the routers themselves and checks every route it
 * finds, including ones added after this file was written:
 *
 *   - anonymous                      -> 401
 *   - owner of business A, route of B -> 404 no_such_business
 *   - owner of A, route of A          -> gets past authorization
 *   - owner, any /api/admin route     -> 404
 *
 * It also fails if a /api/b or /api/admin route is ever defined directly on
 * the app instead of on the guarded router - the one way to bypass the guard.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Router } from "express";
import { createApp } from "../app.ts";
import { businessRouter } from "../api/business.ts";
import { adminRouter } from "../api/admin.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness } from "../store/businesses.ts";

interface RouteInfo { method: string; path: string }

/** Every (method, path) on a router, read from Express's own route table. */
export function routesOf(router: Router): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on && method !== "_all") out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

/** Fill :params with plausible values so the request reaches the route. */
const concrete = (path: string) =>
  path.replace(/:waId/g, "15550009999").replace(/:id/g, "1").replace(/:[A-Za-z]+/g, "x");

let server: Server;
let base: string;
let app: ReturnType<typeof createApp>;
let ownerA: TestUser;
let admin: TestUser;
// Both businesses are created here, not borrowed: this file calls every route
// for real - DELETEs included - and must not change data other test files use.
let A: number;
let B: number;

before(async () => {
  A = createBusiness({ name: "Authz Business A" }).id;
  B = createBusiness({ name: "Authz Other Business" }).id;
  ownerA = await makeUser("owner", A);
  admin = await makeUser("super_admin");
  app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

test("the business router has routes to check (this test is not vacuous)", () => {
  assert.ok(routesOf(businessRouter).length > 0);
});

test("no client-data or admin route is defined outside its guarded router", () => {
  const top = (app as unknown as { router: { stack: { route?: { path: string } }[] } }).router.stack;
  const rogue = top.filter((l) => l.route && /^\/api\/(b|admin)(\/|$)/.test(l.route.path)).map((l) => l.route!.path);
  assert.deepEqual(rogue, [], "these bypass requireBusinessAccess / requireSuperAdmin");
});

test("every business route refuses an anonymous request", async () => {
  for (const r of routesOf(businessRouter)) {
    const res = await call(base, `/api/b/${A}${concrete(r.path)}`, { method: r.method, body: {} });
    assert.equal(res.status, 401, `${r.method} ${r.path} answered ${res.status} to an anonymous caller`);
  }
});

test("every business route hides business B from the owner of A", async () => {
  for (const r of routesOf(businessRouter)) {
    const res = await call(base, `/api/b/${B}${concrete(r.path)}`, { method: r.method, cookie: ownerA.cookie, body: {} });
    assert.equal(res.status, 404, `${r.method} ${r.path} let A's owner reach B (status ${res.status})`);
    assert.equal(res.json["error"], "no_such_business");
  }
});

test("every business route lets the owner of A into A", async () => {
  for (const r of routesOf(businessRouter)) {
    const res = await call(base, `/api/b/${A}${concrete(r.path)}`, { method: r.method, cookie: ownerA.cookie, body: {} });
    assert.ok(![401, 403].includes(res.status) && res.json["error"] !== "no_such_business",
      `${r.method} ${r.path} refused the rightful owner (status ${res.status})`);
  }
});

test("a super admin reaches any business", async () => {
  for (const r of routesOf(businessRouter)) {
    const res = await call(base, `/api/b/${B}${concrete(r.path)}`, { method: r.method, cookie: admin.cookie, body: {} });
    assert.ok(res.json["error"] !== "no_such_business", `${r.method} ${r.path} refused the super admin`);
  }
});

test("business ids that are not numbers, or do not exist, look like any other refusal", async () => {
  for (const bad of ["abc", "1.5", "-1", "999999", "1%20OR%201=1"]) {
    const res = await call(base, `/api/b/${bad}/summary`, { cookie: admin.cookie });
    assert.equal(res.status, 404, `bid=${bad}`);
  }
});

test("every admin route is invisible to owners", async () => {
  const routes = routesOf(adminRouter);
  assert.ok(routes.length > 0);
  for (const r of routes) {
    const res = await call(base, `/api/admin${concrete(r.path)}`, { method: r.method, cookie: ownerA.cookie, body: {} });
    assert.equal(res.status, 404, `${r.method} ${r.path} answered ${res.status} to an owner`);
  }
});

test("admin responses never contain a credential", async () => {
  const res = await call(base, "/api/admin/businesses", { cookie: admin.cookie });
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.json);
  // .env.test's seeded secrets for the default business.
  for (const secret of ["test-access-token-not-a-real-one", "test-app-secret-not-real"]) {
    assert.ok(!text.includes(secret), `${secret} leaked through the admin API`);
  }
  assert.doesNotMatch(text, /scrypt\$|password_hash|_enc"/);
});
