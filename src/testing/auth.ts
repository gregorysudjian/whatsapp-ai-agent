/**
 * Test helpers for the dashboard API: make users, mint sessions directly in
 * the database (so no login bypass ever has to exist in the app), and call
 * routes the way the browser would.
 */

import crypto from "node:crypto";
import { createUser, type Role, type User } from "../store/users.ts";
import { createSession } from "../auth/sessions.ts";
import { SESSION_COOKIE } from "../auth/middleware.ts";
import type { BusinessId } from "../store/db.ts";

const runId = crypto.randomBytes(3).toString("hex");
let counter = 0;

export interface TestUser {
  user: User;
  password: string;
  cookie: string;
}

/** A fresh user with a unique email (test files share one database). */
export async function makeUser(
  role: Role,
  businessId: BusinessId | null = null,
  opts: { mustChangePassword?: boolean } = {},
): Promise<TestUser> {
  const password = `Test-password-${runId}-${++counter}`;
  const user = await createUser({
    email: `${role}-${runId}-${counter}@example.test`,
    password,
    role,
    businessId,
    mustChangePassword: opts.mustChangePassword ?? false,
  });
  return { user, password, cookie: cookieFor(user.id) };
}

export function cookieFor(userId: number): string {
  return `${SESSION_COOKIE}=${createSession(userId, "127.0.0.1", "test")}`;
}

export interface CallOptions {
  method?: string;
  cookie?: string;
  body?: unknown;
  /** Defaults to the server's own origin for writes, as a browser would send. */
  origin?: string | null;
  headers?: Record<string, string>;
}

export async function call(
  baseUrl: string,
  path: string,
  opts: CallOptions = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const method = opts.method ?? "GET";
  // fetch rejects a body on GET/HEAD; route-walking tests pass one for every
  // method, so drop it here rather than at each call site.
  const bodyAllowed = method !== "GET" && method !== "HEAD";
  const payload = bodyAllowed ? opts.body : undefined;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (payload !== undefined) headers["content-type"] = "application/json";
  const origin = opts.origin === undefined && method !== "GET" ? baseUrl : opts.origin;
  if (origin) headers["origin"] = origin;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}
