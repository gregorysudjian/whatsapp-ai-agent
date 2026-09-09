/**
 * SQLite store, built on node:sqlite (bundled with Node 22.5+) so the agent
 * gains history without a native dependency to compile on every host.
 *
 * Two consumers: the dashboard reads it, and phase 3's conversation memory
 * will write to the same `messages` table rather than inventing a second one.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { publish } from "../core/events.ts";
import type { InboundMessage, MessageStatus } from "../whatsapp/types.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL keeps the dashboard's reads from blocking the webhook's writes, which is
// the whole point of acking Meta fast.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    wa_id       TEXT NOT NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
    type        TEXT NOT NULL,
    text        TEXT NOT NULL DEFAULT '',
    sender_name TEXT,
    ts          INTEGER NOT NULL,
    status      TEXT,
    error       TEXT,
    raw         TEXT
  );

  CREATE INDEX IF NOT EXISTS messages_by_convo ON messages (wa_id, ts DESC);
  CREATE INDEX IF NOT EXISTS messages_by_ts    ON messages (ts DESC);

  CREATE TABLE IF NOT EXISTS contacts (
    wa_id           TEXT PRIMARY KEY,
    name            TEXT,
    first_seen      INTEGER NOT NULL,
    last_inbound_ts INTEGER,
    last_message_ts INTEGER,
    inbound_count   INTEGER NOT NULL DEFAULT 0,
    outbound_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    level  TEXT NOT NULL,
    name   TEXT NOT NULL,
    detail TEXT
  );

  CREATE INDEX IF NOT EXISTS events_by_ts ON events (ts DESC);
`);

/**
 * Additive migrations. Guarded by PRAGMA rather than try/catch so a real
 * failure still surfaces, and safe to run against a database that already
 * holds live conversation history.
 */
function addColumns(table: string, columns: Record<string, string>): string[] {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r["name"])),
  );
  const added: string[] = [];
  for (const [name, decl] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    added.push(name);
  }
  return added;
}

const migrated = addColumns("messages", {
  input_tokens: "INTEGER",
  output_tokens: "INTEGER",
  cache_read_tokens: "INTEGER",
  latency_ms: "INTEGER",
});

log.info("store_ready", { path: config.dbPath, ...(migrated.length ? { migrated } : {}) });

/** Meta's free-form reply window. Outside it, only approved templates send. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

// Every column bound explicitly: an inline NULL in the VALUES list shifts the
// positional parameters after it, which silently files data in the wrong column.
const insertMessage = db.prepare(`
  INSERT INTO messages (id, wa_id, direction, type, text, sender_name, ts, status, error, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);

const touchContact = db.prepare(`
  INSERT INTO contacts (wa_id, name, first_seen, last_inbound_ts, last_message_ts, inbound_count, outbound_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(wa_id) DO UPDATE SET
    name            = COALESCE(excluded.name, contacts.name),
    last_inbound_ts = MAX(COALESCE(contacts.last_inbound_ts, 0), COALESCE(excluded.last_inbound_ts, 0)),
    last_message_ts = MAX(COALESCE(contacts.last_message_ts, 0), COALESCE(excluded.last_message_ts, 0)),
    inbound_count   = contacts.inbound_count  + excluded.inbound_count,
    outbound_count  = contacts.outbound_count + excluded.outbound_count
`);

export function recordInbound(msg: InboundMessage): void {
  const ts = msg.timestamp.getTime();
  insertMessage.run(
    msg.id, msg.from, "in", msg.raw.type, msg.text,
    msg.senderName ?? null, ts, null, null, JSON.stringify(msg.raw),
  );
  touchContact.run(msg.from, msg.senderName ?? null, ts, ts, ts, 1, 0);
  publish({ kind: "message", direction: "in", waId: msg.from, id: msg.id });
}

/**
 * `id` is the wamid Graph returns on send - without it, delivery receipts
 * arriving later have no row to attach to.
 */
export function recordOutbound(id: string, waId: string, text: string): void {
  const ts = Date.now();
  insertMessage.run(id, waId, "out", "text", text, null, ts, null, null, null);
  touchContact.run(waId, null, ts, null, ts, 0, 1);
  publish({ kind: "message", direction: "out", waId, id });
}

const seenStmt = db.prepare(`SELECT 1 AS hit FROM messages WHERE id = ?`);

/** Has this message id already been stored? Survives restarts, unlike a Map. */
export function hasMessage(messageId: string): boolean {
  return seenStmt.get(messageId) !== undefined;
}

const applyStatus = db.prepare(`
  UPDATE messages SET status = ?, error = ? WHERE id = ?
`);

export function recordStatus(status: MessageStatus): void {
  applyStatus.run(
    status.status,
    status.errors ? JSON.stringify(status.errors) : null,
    status.id,
  );
  publish({ kind: "status", waId: status.recipient_id, id: status.id, status: status.status });
}

const usageStmt = db.prepare(`
  UPDATE messages
  SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, latency_ms = ?
  WHERE id = ?
`);

export interface RecordedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
}

/**
 * Attach model cost to the reply it produced. Kept on the message rather than
 * a separate table so "what did this conversation cost" is one query, and so
 * cost is visible per answer instead of as a monthly surprise.
 */
export function recordUsage(messageId: string, usage: RecordedUsage): void {
  usageStmt.run(
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
    usage.latencyMs, messageId,
  );
}

const insertEvent = db.prepare(
  `INSERT INTO events (ts, level, name, detail) VALUES (?, ?, ?, ?)`,
);

export function recordEvent(
  level: "debug" | "info" | "warn" | "error",
  name: string,
  detail?: Record<string, unknown>,
): void {
  insertEvent.run(Date.now(), level, name, detail ? JSON.stringify(detail) : null);
  publish({ kind: "event", level, name });
}
