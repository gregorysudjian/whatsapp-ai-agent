/**
 * Who saw or changed what, and when.
 *
 * Separate from `events` on purpose: events are the agent's operational noise
 * (a retried send, a duplicate webhook); the audit log is about people acting
 * on customer data - logins, replies, exports, settings and credential
 * changes. It is the record a Law 25 confidentiality incident register needs
 * to be reconstructable from.
 *
 * Never put message bodies, passwords or tokens in `detail`.
 */

import { db, type BusinessId } from "./db.ts";

export interface AuditEntry {
  userId: number | null;
  businessId: BusinessId | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO audit_log (ts, user_id, business_id, action, target, detail, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function audit(entry: AuditEntry): void {
  insertStmt.run(
    Date.now(),
    entry.userId,
    entry.businessId,
    entry.action,
    entry.target ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.ip ?? null,
  );
}

export interface AuditRow {
  id: number;
  ts: number;
  userId: number | null;
  userEmail: string | null;
  businessId: number | null;
  action: string;
  target: string | null;
  detail: string | null;
}

const byBusinessStmt = db.prepare(`
  SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
  WHERE a.business_id = ? ORDER BY a.id DESC LIMIT ?
`);
const allStmt = db.prepare(`
  SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
  ORDER BY a.id DESC LIMIT ?
`);

export function listAudit(businessId: BusinessId | "all", limit = 200): AuditRow[] {
  const rows = businessId === "all" ? allStmt.all(limit) : byBusinessStmt.all(businessId, limit);
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: Number(r["id"]),
      ts: Number(r["ts"]),
      userId: r["user_id"] == null ? null : Number(r["user_id"]),
      userEmail: r["user_email"] == null ? null : String(r["user_email"]),
      businessId: r["business_id"] == null ? null : Number(r["business_id"]),
      action: String(r["action"]),
      target: r["target"] == null ? null : String(r["target"]),
      detail: r["detail"] == null ? null : String(r["detail"]),
    };
  });
}

const searchStmt = db.prepare(`
  SELECT a.*, u.email AS user_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
  WHERE (?1 IS NULL OR a.business_id = ?1) AND (?2 IS NULL OR a.action = ?2) AND (?3 IS NULL OR a.id < ?3)
  ORDER BY a.id DESC LIMIT ?4
`);
const actionsStmt = db.prepare(`SELECT DISTINCT action FROM audit_log ORDER BY action`);

/** For the admin audit viewer: filter by client and action, page backwards with `before` (an id). */
export function searchAudit(q: { businessId?: number | null; action?: string | null; before?: number | null; limit?: number }): AuditRow[] {
  return searchStmt
    .all(q.businessId ?? null, q.action ?? null, q.before ?? null, Math.min(q.limit ?? 100, 500))
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: Number(r["id"]),
        ts: Number(r["ts"]),
        userId: r["user_id"] == null ? null : Number(r["user_id"]),
        userEmail: r["user_email"] == null ? null : String(r["user_email"]),
        businessId: r["business_id"] == null ? null : Number(r["business_id"]),
        action: String(r["action"]),
        target: r["target"] == null ? null : String(r["target"]),
        detail: r["detail"] == null ? null : String(r["detail"]),
      };
    });
}

export function auditActions(): string[] {
  return actionsStmt.all().map((r) => String((r as Record<string, unknown>)["action"]));
}
