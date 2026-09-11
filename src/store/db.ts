/**
 * SQLite store, built on node:sqlite (bundled with Node 22.5+) so the agent
 * gains history without a native dependency to compile on every host.
 *
 * Tenancy: every function that touches client data takes a businessId as its
 * first argument, and the schema rejects any write without one (NOT NULL, no
 * default, foreign key enforced). Isolation therefore holds in two places at
 * once - the type checker refuses an unscoped call, and the database refuses
 * an unscoped row.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { publish } from "../core/events.ts";
import { migrate, SCHEMA_VERSION } from "./schema.ts";
import type { InboundMessage, MessageStatus } from "../whatsapp/types.ts";

export type BusinessId = number;

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL keeps the dashboard's reads from blocking the webhook's writes, which is
// the whole point of acking Meta fast.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// Before a schema change, a copy of the database as it was: an upgrade that
// goes wrong can then be undone by putting the file back.
{
  const version = Number((db.prepare("PRAGMA user_version").get() as Record<string, unknown>)["user_version"]);
  if (version > 0 && version < SCHEMA_VERSION) {
    const dir = path.join(path.dirname(config.dbPath), "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `agent-before-schema-${SCHEMA_VERSION}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    log.info("pre_migration_backup", { from: version, to: SCHEMA_VERSION, file });
  }
}

const applied = migrate(db);
log.info("store_ready", {
  path: config.dbPath,
  schema: SCHEMA_VERSION,
  ...(applied.length ? { migrated: applied } : {}),
});

// --- kill switch ----------------------------------------------------------

const getSetting = db.prepare(`SELECT value FROM settings WHERE business_id = ? AND key = ?`);
const putSetting = db.prepare(`
  INSERT INTO settings (business_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(business_id, key) DO UPDATE SET value = excluded.value
`);

const AGENT_ENABLED = "agent_enabled";

/** Per-business key/value flags (the kill switch, one-time seed markers). */
export function readFlag(businessId: BusinessId, key: string): string | undefined {
  const row = getSetting.get(businessId, key) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : String(row["value"]);
}

export function writeFlag(businessId: BusinessId, key: string, value: string): void {
  putSetting.run(businessId, key, value);
}

/**
 * Per-client stop. Messages are still received, stored and shown on the
 * dashboard when this is off - only the reply is withheld - so turning the
 * agent off never loses a customer's question.
 */
export function agentEnabled(businessId: BusinessId): boolean {
  const row = getSetting.get(businessId, AGENT_ENABLED) as Record<string, unknown> | undefined;
  return row === undefined ? true : row["value"] !== "0";
}

export function setAgentEnabled(businessId: BusinessId, enabled: boolean): void {
  putSetting.run(businessId, AGENT_ENABLED, enabled ? "1" : "0");
  recordEvent(businessId, "warn", enabled ? "agent_enabled" : "agent_disabled");
}

// --- handoff --------------------------------------------------------------

/*
 * Who has a conversation: 'ai' (the agent answers) or 'human' (a person does,
 * and the agent stays silent). needs_human means the agent asked for a person
 * and nobody has picked it up yet - it is the inbox's to-do list.
 */
const controlStmt = db.prepare(
  `SELECT control FROM contacts WHERE business_id = ? AND wa_id = ?`,
);
const escalateStmt = db.prepare(`
  UPDATE contacts SET control = 'human', needs_human = 1, handoff_reason = ?, taken_over_by = NULL, taken_over_at = NULL
  WHERE business_id = ? AND wa_id = ?
`);
const takeOverStmt = db.prepare(`
  UPDATE contacts SET control = 'human', needs_human = 0, taken_over_by = ?, taken_over_at = ?
  WHERE business_id = ? AND wa_id = ?
`);
const handBackStmt = db.prepare(`
  UPDATE contacts SET control = 'ai', needs_human = 0, handoff_reason = NULL, taken_over_by = NULL, taken_over_at = NULL
  WHERE business_id = ? AND wa_id = ?
`);

/** True while a person has this conversation; the webhook then skips the AI. */
export function isPaused(businessId: BusinessId, waId: string): boolean {
  const row = controlStmt.get(businessId, waId) as Record<string, unknown> | undefined;
  return row?.["control"] === "human";
}

export function contactExists(businessId: BusinessId, waId: string): boolean {
  return controlStmt.get(businessId, waId) !== undefined;
}

/** The agent asks for a person: it goes silent, and the chat joins the to-do list. */
export function pauseForHuman(businessId: BusinessId, waId: string, reason: string): void {
  escalateStmt.run(reason, businessId, waId);
  recordEvent(businessId, "warn", "handoff_requested", { waId, reason });
}

/** A person takes the conversation from the dashboard. False if it does not exist here. */
export function takeOver(businessId: BusinessId, waId: string, userId: number): boolean {
  const changed = Number(takeOverStmt.run(userId, Date.now(), businessId, waId).changes) === 1;
  if (changed) recordEvent(businessId, "info", "taken_over", { waId, userId });
  return changed;
}

/** Back to the agent. False if the conversation does not exist here. */
export function handBack(businessId: BusinessId, waId: string): boolean {
  const changed = Number(handBackStmt.run(businessId, waId).changes) === 1;
  if (changed) recordEvent(businessId, "info", "handed_back", { waId });
  return changed;
}

const tookOverSinceStmt = db.prepare(`
  SELECT 1 AS hit FROM contacts
  WHERE business_id = ? AND wa_id = ? AND control = 'human' AND taken_over_by IS NOT NULL AND taken_over_at >= ?
`);

/**
 * Did a person take this conversation over at or after `since`? The handler
 * asks just before sending: a reply the model was still writing when someone
 * clicked "Take over" must not land on top of theirs.
 */
export function humanTookOverSince(businessId: BusinessId, waId: string, since: number): boolean {
  return tookOverSinceStmt.get(businessId, waId, since) !== undefined;
}

/** Kept for existing callers: clearing a handoff is handing back. */
export function clearHandoff(businessId: BusinessId, waId: string): void {
  handBack(businessId, waId);
}

// --- messages -------------------------------------------------------------

/** Meta's free-form reply window. Outside it, only approved templates send. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

// Every column bound explicitly: an inline NULL in the VALUES list shifts the
// positional parameters after it, which silently files data in the wrong column.
const insertMessage = db.prepare(`
  INSERT INTO messages (id, business_id, wa_id, direction, type, text, sender_name, ts, status, error, raw, sender, sent_by_user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);

const touchContact = db.prepare(`
  INSERT INTO contacts (business_id, wa_id, name, first_seen, last_inbound_ts, last_message_ts, inbound_count, outbound_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(business_id, wa_id) DO UPDATE SET
    name            = COALESCE(excluded.name, contacts.name),
    last_inbound_ts = MAX(COALESCE(contacts.last_inbound_ts, 0), COALESCE(excluded.last_inbound_ts, 0)),
    last_message_ts = MAX(COALESCE(contacts.last_message_ts, 0), COALESCE(excluded.last_message_ts, 0)),
    inbound_count   = contacts.inbound_count  + excluded.inbound_count,
    outbound_count  = contacts.outbound_count + excluded.outbound_count
`);

export function recordInbound(businessId: BusinessId, msg: InboundMessage): void {
  const ts = msg.timestamp.getTime();
  insertMessage.run(
    msg.id, businessId, msg.from, "in", msg.raw.type, msg.text,
    msg.senderName ?? null, ts, null, null, JSON.stringify(msg.raw), "customer", null,
  );
  touchContact.run(businessId, msg.from, msg.senderName ?? null, ts, ts, ts, 1, 0);
  publish({ businessId, kind: "message", direction: "in", waId: msg.from, id: msg.id });
}

/**
 * `id` is the wamid Graph returns on send - without it, delivery receipts
 * arriving later have no row to attach to.
 */
export type OutboundSender = "ai" | "human" | "system";

export function recordOutbound(
  businessId: BusinessId,
  id: string,
  waId: string,
  text: string,
  sender: OutboundSender = "ai",
  userId: number | null = null,
  type: "text" | "template" = "text",
): void {
  const ts = Date.now();
  insertMessage.run(id, businessId, waId, "out", type, text, null, ts, null, null, null, sender, userId);
  touchContact.run(businessId, waId, null, ts, null, ts, 0, 1);
  publish({ businessId, kind: "message", direction: "out", waId, id });
}

const windowStmt = db.prepare(
  `SELECT last_inbound_ts FROM contacts WHERE business_id = ? AND wa_id = ?`,
);

export interface WindowState {
  open: boolean;
  remainingMs: number;
  lastInboundTs: number | null;
}

/**
 * Meta only allows free-form messages within 24h of the contact's last
 * inbound message. Outside it, only pre-approved templates deliver - the API
 * rejects everything else, so an unguarded send just vanishes.
 */
export function windowState(businessId: BusinessId, waId: string): WindowState {
  const row = windowStmt.get(businessId, waId) as Record<string, unknown> | undefined;
  const raw = row?.["last_inbound_ts"];
  const last = typeof raw === "number" ? raw : typeof raw === "bigint" ? Number(raw) : null;

  if (last === null) return { open: false, remainingMs: 0, lastInboundTs: null };

  const remainingMs = Math.max(0, last + WINDOW_MS - Date.now());
  return { open: remainingMs > 0, remainingMs, lastInboundTs: last };
}

const seenStmt = db.prepare(`SELECT 1 AS hit FROM messages WHERE business_id = ? AND id = ?`);

/** Has this message id already been stored? Survives restarts, unlike a Map. */
export function hasMessage(businessId: BusinessId, messageId: string): boolean {
  return seenStmt.get(businessId, messageId) !== undefined;
}

/**
 * Scoped by business as well as id: a receipt arriving on one client's
 * webhook must not be able to touch another client's message.
 */
const applyStatus = db.prepare(`
  UPDATE messages SET status = ?, error = ? WHERE business_id = ? AND id = ?
`);

export function recordStatus(businessId: BusinessId, status: MessageStatus): void {
  applyStatus.run(
    status.status,
    status.errors ? JSON.stringify(status.errors) : null,
    businessId,
    status.id,
  );
  publish({ businessId, kind: "status", waId: status.recipient_id, id: status.id, status: status.status });
}

const usageStmt = db.prepare(`
  UPDATE messages
  SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, latency_ms = ?
  WHERE business_id = ? AND id = ?
`);

export interface RecordedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
}

/**
 * Attach model cost to the reply it produced. Kept on the message rather than
 * a separate table so "what did this conversation cost" is one query - and,
 * now, "what did this client cost" for billing.
 */
export function recordUsage(businessId: BusinessId, messageId: string, usage: RecordedUsage): void {
  usageStmt.run(
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens,
    usage.latencyMs, businessId, messageId,
  );
}

// --- events ---------------------------------------------------------------

const insertEvent = db.prepare(
  `INSERT INTO events (business_id, ts, level, name, detail) VALUES (?, ?, ?, ?, ?)`,
);

/**
 * `businessId` is null only for events that happen before any business is
 * known - a request to a webhook URL that matches no client, for instance.
 * Those never reach a client's dashboard.
 */
export function recordEvent(
  businessId: BusinessId | null,
  level: "debug" | "info" | "warn" | "error",
  name: string,
  detail?: Record<string, unknown>,
): void {
  insertEvent.run(businessId, Date.now(), level, name, detail ? JSON.stringify(detail) : null);
  if (businessId !== null) publish({ businessId, kind: "event", level, name });
}
