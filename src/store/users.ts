/**
 * People who log in to the dashboard.
 *
 * `User` carries no password hash - the hash is read by exactly one internal
 * function, for login - so no route can leak it by returning the wrong object.
 */

import { db, type BusinessId } from "./db.ts";
import { getBusiness, listBusinesses, ValidationError, type Business } from "./businesses.ts";
import { hashPassword, passwordProblem } from "../auth/passwords.ts";

export type Role = "super_admin" | "owner";
export type Locale = "en" | "fr";

export interface User {
  id: number;
  email: string;
  role: Role;
  businessId: BusinessId | null;
  name: string | null;
  locale: Locale;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

function toUser(r: Record<string, unknown>): User {
  return {
    id: Number(r["id"]),
    email: String(r["email"]),
    role: r["role"] === "super_admin" ? "super_admin" : "owner",
    businessId: r["business_id"] == null ? null : Number(r["business_id"]),
    name: r["name"] == null ? null : String(r["name"]),
    locale: r["locale"] === "fr" ? "fr" : "en",
    active: Number(r["active"]) === 1,
    mustChangePassword: Number(r["must_change_password"]) === 1,
    createdAt: Number(r["created_at"]),
    lastLoginAt: r["last_login_at"] == null ? null : Number(r["last_login_at"]),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(email: unknown): string {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL.test(value) || value.length > 254) throw new ValidationError("That email address doesn't look right.");
  return value;
}

const byIdStmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
const byEmailStmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
const allStmt = db.prepare(`SELECT * FROM users ORDER BY role DESC, email`);
const byBusinessStmt = db.prepare(`SELECT * FROM users WHERE business_id = ? ORDER BY email`);

export function getUser(id: number): User | undefined {
  const r = byIdStmt.get(id) as Record<string, unknown> | undefined;
  return r ? toUser(r) : undefined;
}

export function getUserByEmail(email: string): User | undefined {
  const r = byEmailStmt.get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return r ? toUser(r) : undefined;
}

/** The only reader of password_hash. */
export function getCredentialsForLogin(email: string): { user: User; passwordHash: string } | undefined {
  const r = byEmailStmt.get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return r ? { user: toUser(r), passwordHash: String(r["password_hash"]) } : undefined;
}

export function listUsers(businessId?: BusinessId): User[] {
  const rows = businessId === undefined ? allStmt.all() : byBusinessStmt.all(businessId);
  return rows.map((r) => toUser(r as Record<string, unknown>));
}

const insertStmt = db.prepare(`
  INSERT INTO users (email, password_hash, role, business_id, name, locale, must_change_password, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export interface NewUser {
  email: string;
  password: string;
  role: Role;
  businessId?: BusinessId | null;
  name?: string | null;
  locale?: Locale;
  mustChangePassword?: boolean;
}

export async function createUser(input: NewUser): Promise<User> {
  const email = normaliseEmail(input.email);
  if (getUserByEmail(email)) throw new ValidationError("An account with that email already exists.");

  const problem = passwordProblem(input.password, email);
  if (problem) throw new ValidationError(`Password rejected: ${problem}.`);

  let businessId: BusinessId | null = null;
  if (input.role === "owner") {
    if (input.businessId == null || !getBusiness(input.businessId)) {
      throw new ValidationError("An owner must belong to an existing business.");
    }
    businessId = input.businessId;
  } else if (input.businessId != null) {
    throw new ValidationError("A super admin is not tied to one business.");
  }

  const result = insertStmt.run(
    email, await hashPassword(input.password), input.role, businessId,
    input.name?.trim() || null, input.locale ?? "en",
    input.mustChangePassword ? 1 : 0, Date.now(),
  );
  return getUser(Number(result.lastInsertRowid))!;
}

const setPasswordStmt = db.prepare(
  `UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?`,
);

export async function setPassword(userId: number, password: string, mustChange = false): Promise<void> {
  const user = getUser(userId);
  if (!user) throw new ValidationError("No such user.");
  const problem = passwordProblem(password, user.email);
  if (problem) throw new ValidationError(`Password rejected: ${problem}.`);
  setPasswordStmt.run(await hashPassword(password), mustChange ? 1 : 0, userId);
}

const activeStmt = db.prepare(`UPDATE users SET active = ? WHERE id = ?`);
export function setUserActive(userId: number, active: boolean): void {
  activeStmt.run(active ? 1 : 0, userId);
}

const localeStmt = db.prepare(`UPDATE users SET locale = ? WHERE id = ?`);
export function setUserLocale(userId: number, locale: Locale): void {
  localeStmt.run(locale, userId);
}

const loginStmt = db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`);
export function recordLogin(userId: number): void {
  loginStmt.run(Date.now(), userId);
}

/**
 * The businesses a user may open. The single place that answers this -
 * middleware, the business switcher and /me all ask here, so they cannot
 * disagree.
 */
export function accessibleBusinesses(user: User): Business[] {
  if (user.role === "super_admin") return listBusinesses();
  const own = user.businessId == null ? undefined : getBusiness(user.businessId);
  return own ? [own] : [];
}

export function canAccessBusiness(user: User, businessId: BusinessId): boolean {
  if (!user.active) return false;
  if (user.role === "super_admin") return getBusiness(businessId) !== undefined;
  return user.businessId === businessId;
}
