/**
 * Read side of the store - everything the dashboard renders. Kept apart from
 * db.ts so the write path stays easy to audit.
 */

import { db, WINDOW_MS } from "./db.ts";

export interface ConversationRow {
  waId: string;
  name: string | null;
  lastInboundTs: number | null;
  lastMessageTs: number | null;
  inboundCount: number;
  outboundCount: number;
  lastText: string;
  lastDirection: "in" | "out" | null;
  /** ms left in Meta's free-form window; 0 once it has closed. */
  windowRemainingMs: number;
}

const conversationsStmt = db.prepare(`
  SELECT
    c.wa_id, c.name, c.last_inbound_ts, c.last_message_ts,
    c.inbound_count, c.outbound_count,
    m.text      AS last_text,
    m.direction AS last_direction
  FROM contacts c
  LEFT JOIN messages m ON m.id = (
    SELECT id FROM messages WHERE wa_id = c.wa_id ORDER BY rowid DESC LIMIT 1
  )
  ORDER BY COALESCE(c.last_message_ts, 0) DESC
  LIMIT ?
`);

export function listConversations(limit = 100): ConversationRow[] {
  const now = Date.now();
  return conversationsStmt.all(limit).map((r) => {
    const lastInbound = num(r["last_inbound_ts"]);
    return {
      waId: String(r["wa_id"]),
      name: str(r["name"]),
      lastInboundTs: lastInbound,
      lastMessageTs: num(r["last_message_ts"]),
      inboundCount: num(r["inbound_count"]) ?? 0,
      outboundCount: num(r["outbound_count"]) ?? 0,
      lastText: str(r["last_text"]) ?? "",
      lastDirection: (str(r["last_direction"]) as "in" | "out" | null) ?? null,
      windowRemainingMs:
        lastInbound === null ? 0 : Math.max(0, lastInbound + WINDOW_MS - now),
    };
  });
}

export interface MessageRow {
  id: string;
  waId: string;
  direction: "in" | "out";
  type: string;
  text: string;
  senderName: string | null;
  ts: number;
  status: string | null;
  error: string | null;
}

/**
 * Ordered by rowid (insertion order), never by ts.
 *
 * Inbound rows carry Meta's timestamp - when the customer hit send, at second
 * resolution - while outbound rows carry our clock at the moment we replied.
 * A retried webhook can therefore arrive with a ts older than replies already
 * stored, and sorting on it interleaves the transcript wrongly. Insertion
 * order is what the agent actually observed, which is what history must be.
 */
const messagesStmt = db.prepare(`
  SELECT id, wa_id, direction, type, text, sender_name, ts, status, error
  FROM messages WHERE wa_id = ? ORDER BY rowid ASC LIMIT ?
`);

export function listMessages(waId: string, limit = 500): MessageRow[] {
  return messagesStmt.all(waId, limit).map(toMessage);
}

const recentStmt = db.prepare(`
  SELECT id, wa_id, direction, type, text, sender_name, ts, status, error
  FROM messages ORDER BY rowid DESC LIMIT ?
`);

export function listRecentMessages(limit = 50): MessageRow[] {
  return recentStmt.all(limit).map(toMessage);
}

function toMessage(r: Record<string, unknown>): MessageRow {
  return {
    id: String(r["id"]),
    waId: String(r["wa_id"]),
    direction: str(r["direction"]) === "out" ? "out" : "in",
    type: str(r["type"]) ?? "text",
    text: str(r["text"]) ?? "",
    senderName: str(r["sender_name"]),
    ts: num(r["ts"]) ?? 0,
    status: str(r["status"]),
    error: str(r["error"]),
  };
}

export interface EventRow {
  id: number;
  ts: number;
  level: string;
  name: string;
  detail: string | null;
}

const eventsStmt = db.prepare(
  `SELECT id, ts, level, name, detail FROM events ORDER BY ts DESC LIMIT ?`,
);

export function listEvents(limit = 100): EventRow[] {
  return eventsStmt.all(limit).map((r) => ({
    id: num(r["id"]) ?? 0,
    ts: num(r["ts"]) ?? 0,
    level: str(r["level"]) ?? "info",
    name: str(r["name"]) ?? "",
    detail: str(r["detail"]),
  }));
}

const scalar = (sql: string) => db.prepare(sql);
const totalIn = scalar(`SELECT COUNT(*) AS n FROM messages WHERE direction='in'`);
const totalOut = scalar(`SELECT COUNT(*) AS n FROM messages WHERE direction='out'`);
const failedOut = scalar(`SELECT COUNT(*) AS n FROM messages WHERE status='failed'`);
const contactCount = scalar(`SELECT COUNT(*) AS n FROM contacts`);
const since = scalar(`SELECT COUNT(*) AS n FROM messages WHERE ts > ?`);
const eventCount = scalar(`SELECT COUNT(*) AS n FROM events WHERE name = ?`);
const openWindows = scalar(
  `SELECT COUNT(*) AS n FROM contacts WHERE COALESCE(last_inbound_ts,0) > ?`,
);

export interface Stats {
  inbound: number;
  outbound: number;
  failed: number;
  contacts: number;
  last24h: number;
  openWindows: number;
  rejectedSignatures: number;
  graphErrors: number;
  uptimeSec: number;
}

export function stats(): Stats {
  const dayAgo = Date.now() - WINDOW_MS;
  return {
    inbound: one(totalIn),
    outbound: one(totalOut),
    failed: one(failedOut),
    contacts: one(contactCount),
    last24h: one(since, dayAgo),
    openWindows: one(openWindows, dayAgo),
    rejectedSignatures: one(eventCount, "invalid_signature"),
    graphErrors: one(eventCount, "graph_api_error"),
    uptimeSec: Math.round(process.uptime()),
  };
}

function one(stmt: ReturnType<typeof db.prepare>, ...args: unknown[]): number {
  const row = stmt.get(...(args as never[])) as Record<string, unknown> | undefined;
  return num(row?.["n"]) ?? 0;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
