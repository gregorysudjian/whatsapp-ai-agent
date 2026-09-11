/**
 * Who is asking, and what they may touch.
 *
 * The order in app.ts is: security headers -> session -> origin check ->
 * requireAuth -> requireBusinessAccess | requireSuperAdmin -> route. Every
 * client-data route lives under /api/b/:bid, behind requireBusinessAccess,
 * so scope is decided once, here, and never by a handler reading the body.
 */

import type { NextFunction, Request, Response } from "express";
import { resolveSession } from "./sessions.ts";
import { canAccessBusiness, type User } from "../store/users.ts";
import type { BusinessId } from "../store/db.ts";

export const SESSION_COOKIE = "wa_session";

interface Auth {
  user: User;
  token: string;
}

// A WeakMap rather than a property bolted onto Request: typed without a
// global declaration merge, and nothing survives the request.
const auths = new WeakMap<Request, Auth>();
const scopes = new WeakMap<Request, BusinessId>();

export function getAuth(req: Request): Auth {
  const auth = auths.get(req);
  if (!auth) throw new Error("getAuth called on a route without requireAuth");
  return auth;
}

/** The business this request is scoped to. Only valid behind requireBusinessAccess. */
export function businessOf(req: Request): BusinessId {
  const bid = scopes.get(req);
  if (bid === undefined) throw new Error("businessOf called on a route without requireBusinessAccess");
  return bid;
}

export function clientIp(req: Request): string | null {
  return req.ip ?? req.socket.remoteAddress ?? null;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    // Strict: the cookie is never sent on a request started by another site,
    // which is most of what CSRF needs. The Origin check below is the rest.
    sameSite: "strict" as const,
    secure: process.env["COOKIE_SECURE"] === "1",
    path: "/",
  };
}

/** Attaches the logged-in user, if any. Never rejects on its own. */
export function session(req: Request, _res: Response, next: NextFunction): void {
  const token = readCookie(req, SESSION_COOKIE);
  const user = resolveSession(token);
  if (user && token) auths.set(req, { user, token });
  next();
}

/**
 * Paths a user who must change their password may still reach: enough to
 * change it and to log out, nothing that shows customer data.
 */
const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(["/api/auth/me", "/api/auth/password", "/api/auth/logout"]);

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = auths.get(req);
  if (!auth) {
    res.status(401).json({ error: "not_authenticated" });
    return;
  }
  if (auth.user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.has(req.originalUrl.split("?")[0]!)) {
    res.status(403).json({ error: "password_change_required" });
    return;
  }
  next();
}

/**
 * Owners reach their own business only; super admins reach any. Another
 * business answers 404, the same as one that does not exist, so ids cannot
 * be probed to learn how many clients there are.
 */
export function requireBusinessAccess(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const raw = req.params["bid"];
  const bid = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;

  if (!Number.isInteger(bid) || !canAccessBusiness(auth.user, bid)) {
    res.status(404).json({ error: "no_such_business" });
    return;
  }
  scopes.set(req, bid);
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (auth.user.role !== "super_admin") {
    // 404, not 403: an owner has no business knowing the admin API exists.
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

/**
 * CSRF, second layer. A state-changing request that a browser marks as
 * cross-site, or that carries an Origin other than ours, is refused. A
 * request with no Origin at all is allowed: browsers send one on every
 * cross-origin POST, so its absence means a same-origin or non-browser client,
 * and the SameSite=Strict cookie already stops a cross-site one carrying a
 * session.
 */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  if (req.get("sec-fetch-site") === "cross-site") {
    res.status(403).json({ error: "cross_site_request" });
    return;
  }
  const origin = req.get("origin");
  if (origin && !allowedOrigins(req).has(origin)) {
    res.status(403).json({ error: "bad_origin" });
    return;
  }
  next();
}

function allowedOrigins(req: Request): Set<string> {
  const host = req.get("host");
  const set = new Set<string>();
  if (host) {
    set.add(`http://${host}`);
    set.add(`https://${host}`);
  }
  for (const o of (process.env["ALLOWED_ORIGINS"] ?? "http://localhost:5173").split(",")) {
    if (o.trim()) set.add(o.trim());
  }
  return set;
}

/**
 * Headers for every response. The CSP allows only this server - no CDN, no
 * third-party font or script - which is both an XSS backstop and a Law 25
 * nicety: nothing about a dashboard visit leaks to another host.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; " +
      "base-uri 'self'; form-action 'self'",
  );
  next();
}

// --- login throttling -------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL = 5;
const PER_IP = 30;
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** True when this email or address has failed too often lately. */
export function loginLocked(email: string, ip: string | null, now = Date.now()): boolean {
  return recent(`e:${email}`, now).length >= PER_EMAIL || (ip !== null && recent(`i:${ip}`, now).length >= PER_IP);
}

export function recordLoginFailure(email: string, ip: string | null, now = Date.now()): void {
  for (const key of [`e:${email}`, ...(ip ? [`i:${ip}`] : [])]) {
    failures.set(key, [...recent(key, now), now]);
  }
}

export function clearLoginFailures(email: string): void {
  failures.delete(`e:${email}`);
}

/** Tests only. */
export function resetLoginThrottle(): void {
  failures.clear();
}
