/**
 * Server-side sessions.
 *
 * The browser holds a random 32-byte token; the database holds only its
 * SHA-256. A copy of the database therefore yields no working sessions, and
 * logging someone out is a row delete, effective immediately - neither of
 * which is true of a self-contained signed token.
 *
 * Two clocks: a session dies after 12 hours idle (sliding) and after 7 days
 * no matter what (absolute), so a forgotten laptop stays logged in for an
 * afternoon, not forever.
 */

import crypto from "node:crypto";
import { db } from "../store/db.ts";
import { getUser, type User } from "../store/users.ts";

export const IDLE_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** Avoid a write on every request: last_seen only moves once a minute. */
const TOUCH_EVERY_MS = 60 * 1000;

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const insertStmt = db.prepare(`
  INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getStmt = db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`);
const touchStmt = db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`);
const deleteStmt = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`);
const deleteUserStmt = db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`);
const deleteAllUserStmt = db.prepare(`DELETE FROM sessions WHERE user_id = ?`);
const purgeStmt = db.prepare(`DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?`);

export function createSession(userId: number, ip?: string | null, userAgent?: string | null): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  insertStmt.run(hash(token), userId, now, now, now + ABSOLUTE_MS, ip ?? null, userAgent?.slice(0, 300) ?? null);
  return token;
}

/**
 * The user behind a token, or undefined if it is unknown, expired or disabled.
 * `touch: false` checks without counting as activity - a live stream left open
 * in a forgotten tab must not keep its session awake forever.
 */
export function resolveSession(token: string | undefined, now = Date.now(), touch = true): User | undefined {
  if (!token || token.length > 100) return undefined;
  const key = hash(token);
  const row = getStmt.get(key) as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const lastSeen = Number(row["last_seen_at"]);
  if (now > Number(row["expires_at"]) || now - lastSeen > IDLE_MS) {
    deleteStmt.run(key);
    return undefined;
  }

  const user = getUser(Number(row["user_id"]));
  if (!user || !user.active) {
    deleteStmt.run(key);
    return undefined;
  }

  if (touch && now - lastSeen > TOUCH_EVERY_MS) touchStmt.run(now, key);
  return user;
}

export function destroySession(token: string | undefined): void {
  if (token) deleteStmt.run(hash(token));
}

/** After a password change: every other device is logged out. */
export function destroyOtherSessions(userId: number, keepToken: string): void {
  deleteUserStmt.run(userId, hash(keepToken));
}

export function destroyAllSessions(userId: number): void {
  deleteAllUserStmt.run(userId);
}

export function purgeExpiredSessions(now = Date.now()): void {
  purgeStmt.run(now, now - IDLE_MS);
}
