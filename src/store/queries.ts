/**
 * Read side of the store - everything the dashboard renders. Kept apart from
 * db.ts so the write path stays easy to audit.
 *
 * Every query takes a businessId and filters on it, joins included. The easy
 * one to miss is a correlated subquery: matching a customer by phone number
 * alone would surface one client's message in another client's inbox when
 * the same person texts both.
 */

import { agentEnabled, db, WINDOW_MS, type BusinessId } from "./db.ts";

export interface ConversationRow {
  waId: string;
  name: string | null;
  lastInboundTs: number | null;
  lastMessageTs: number | null;
  inboundCount: number;
  outboundCount: number;
  lastText: string;
  lastDirection: "in" | "out" | null;
  lastSender: "customer" | "ai" | "human" | "system" | null;
  /** ms left in Meta's free-form window; 0 once it has closed. */
  windowRemainingMs: number;
  needsHuman: boolean;
  /** Kept for older callers; true exactly when control is "human". */
  paused: boolean;
  handoffReason: string | null;
  control: "ai" | "human";
  /** Email of whoever took the conversation over, if a person has it. */
  takenOverBy: string | null;
  takenOverAt: number | null;
  /** The customer spoke last: someone (the agent or a person) owes them a reply. */
  awaitingReply: boolean;
}

export type ConversationFilter = "all" | "needs_human" | "human" | "ai";

const conversationsStmt = db.prepare(`
  SELECT
    c.wa_id, c.name, c.last_inbound_ts, c.last_message_ts,
    c.inbound_count, c.outbound_count,
    c.needs_human, c.control, c.handoff_reason, c.taken_over_at,
    u.email     AS taken_over_email,
    m.text      AS last_text,
    m.direction AS last_direction,
    m.sender    AS last_sender
  FROM contacts c
  LEFT JOIN users u ON u.id = c.taken_over_by
  LEFT JOIN messages m ON m.id = (
    SELECT id FROM messages
    WHERE business_id = c.business_id AND wa_id = c.wa_id
    ORDER BY rowid DESC LIMIT 1
  )
  WHERE c.business_id = ?1
    AND (?2 = 'all'
      OR (?2 = 'needs_human' AND c.needs_human = 1)
      OR (?2 = 'human' AND c.control = 'human')
      OR (?2 = 'ai' AND c.control = 'ai'))
    AND (?3 = '' OR c.name LIKE ?4 ESCAPE '!' OR c.wa_id LIKE ?4 ESCAPE '!')
  -- Conversations waiting on a person float to the top: that is the queue
  -- someone actually has to work through.
  ORDER BY c.needs_human DESC, COALESCE(c.last_message_ts, 0) DESC
  LIMIT ?5
`);

/** A LIKE pattern matching `q` literally: "50%" finds the characters, not a wildcard. */
export function likeContains(q: string): string {
  return `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

export function listConversations(
  businessId: BusinessId,
  limit = 100,
  opts: { filter?: ConversationFilter; q?: string } = {},
): ConversationRow[] {
  const now = Date.now();
  const q = (opts.q ?? "").trim().slice(0, 100);
  return conversationsStmt.all(businessId, opts.filter ?? "all", q, likeContains(q), limit).map((r) => {
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
      lastSender: r["last_sender"] == null ? null : senderOf({ sender: r["last_sender"], direction: r["last_direction"] }),
      windowRemainingMs:
        lastInbound === null ? 0 : Math.max(0, lastInbound + WINDOW_MS - now),
      needsHuman: Number(r["needs_human"] ?? 0) === 1,
      paused: r["control"] === "human",
      handoffReason: str(r["handoff_reason"]),
      control: r["control"] === "human" ? "human" : "ai",
      takenOverBy: str(r["taken_over_email"]),
      takenOverAt: num(r["taken_over_at"]),
      awaitingReply: str(r["last_direction"]) === "in",
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
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  latencyMs: number | null;
  /** Who wrote it: the customer, the agent, a person on the dashboard, or the system. */
  sender: "customer" | "ai" | "human" | "system";
  /** Email of the dashboard user, for sender "human". */
  sentBy: string | null;
}

const MESSAGE_COLUMNS = `
  m.id, m.wa_id, m.direction, m.type, m.text, m.sender_name, m.ts, m.status, m.error,
  m.input_tokens, m.output_tokens, m.cache_read_tokens, m.latency_ms,
  m.sender, u.email AS sent_by_email`;

/**
 * Ordered by rowid (insertion order), never by ts.
 *
 * Inbound rows carry Meta's timestamp - when the customer hit send, at second
 * resolution - while outbound rows carry our clock at the moment we replied.
 * A retried webhook can therefore arrive with a ts older than replies already
 * stored, and sorting on it interleaves the transcript wrongly. Insertion
 * order is what the agent actually observed, which is what history must be.
 */
// The latest `limit` messages, returned oldest first: a long thread shows its
// recent end, which is the part anyone replying needs.
const messagesStmt = db.prepare(`
  SELECT * FROM (
    SELECT ${MESSAGE_COLUMNS}, m.rowid AS seq
    FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id
    WHERE m.business_id = ? AND m.wa_id = ? ORDER BY m.rowid DESC LIMIT ?
  ) ORDER BY seq ASC
`);

export function listMessages(businessId: BusinessId, waId: string, limit = 500): MessageRow[] {
  return messagesStmt.all(businessId, waId, limit).map(toMessage);
}

const recentStmt = db.prepare(`
  SELECT ${MESSAGE_COLUMNS}
  FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id
  WHERE m.business_id = ? ORDER BY m.rowid DESC LIMIT ?
`);

export function listRecentMessages(businessId: BusinessId, limit = 50): MessageRow[] {
  return recentStmt.all(businessId, limit).map(toMessage);
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
    inputTokens: num(r["input_tokens"]),
    outputTokens: num(r["output_tokens"]),
    cacheReadTokens: num(r["cache_read_tokens"]),
    latencyMs: num(r["latency_ms"]),
    sender: senderOf(r),
    sentBy: str(r["sent_by_email"]),
  };
}

function senderOf(r: Record<string, unknown>): MessageRow["sender"] {
  const s = str(r["sender"]);
  if (s === "customer" || s === "ai" || s === "human" || s === "system") return s;
  return str(r["direction"]) === "out" ? "ai" : "customer";
}

export interface EventRow {
  id: number;
  ts: number;
  level: string;
  name: string;
  detail: string | null;
}

const eventsStmt = db.prepare(
  `SELECT id, ts, level, name, detail FROM events WHERE business_id = ? ORDER BY ts DESC LIMIT ?`,
);

export function listEvents(businessId: BusinessId, limit = 100): EventRow[] {
  return eventsStmt.all(businessId, limit).map((r) => ({
    id: num(r["id"]) ?? 0,
    ts: num(r["ts"]) ?? 0,
    level: str(r["level"]) ?? "info",
    name: str(r["name"]) ?? "",
    detail: str(r["detail"]),
  }));
}

const scalar = (sql: string) => db.prepare(sql);
const totalIn = scalar(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND direction='in'`);
const totalOut = scalar(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND direction='out'`);
const failedOut = scalar(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND status='failed'`);
const contactCount = scalar(`SELECT COUNT(*) AS n FROM contacts WHERE business_id = ?`);
const since = scalar(`SELECT COUNT(*) AS n FROM messages WHERE business_id = ? AND ts > ?`);
const eventCount = scalar(`SELECT COUNT(*) AS n FROM events WHERE business_id = ? AND name = ?`);
const tokenTotals = scalar(`
  SELECT COALESCE(SUM(input_tokens),0) AS input,
         COALESCE(SUM(output_tokens),0) AS output,
         COALESCE(SUM(cache_read_tokens),0) AS cached,
         COALESCE(AVG(latency_ms),0) AS latency
  FROM messages WHERE business_id = ? AND input_tokens IS NOT NULL
`);
const needsHumanCount = scalar(`SELECT COUNT(*) AS n FROM contacts WHERE business_id = ? AND needs_human = 1`);
const openWindows = scalar(
  `SELECT COUNT(*) AS n FROM contacts WHERE business_id = ? AND COALESCE(last_inbound_ts,0) > ?`,
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
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  avgLatencyMs: number;
  agentEnabled: boolean;
  needsHuman: number;
  /** USD, from the published Opus 5 rates. Indicative, not an invoice. */
  estimatedCostUsd: number;
}

/** Opus 5 list prices, per million tokens. */
const USD_PER_MTOK_IN = 5;
const USD_PER_MTOK_OUT = 25;
const USD_PER_MTOK_CACHED = 0.5; // cache reads bill at ~0.1x input

/** Indicative model cost in USD for a token count, at the list prices above. */
export function estimateCostUsd(inputTokens: number, outputTokens: number, cachedTokens: number): number {
  return Number((
    (inputTokens / 1e6) * USD_PER_MTOK_IN +
    (outputTokens / 1e6) * USD_PER_MTOK_OUT +
    (cachedTokens / 1e6) * USD_PER_MTOK_CACHED
  ).toFixed(4));
}

export function stats(businessId: BusinessId): Stats {
  const dayAgo = Date.now() - WINDOW_MS;
  const tokens = tokenTotals.get(businessId) as Record<string, unknown> | undefined;
  const inputTokens = num(tokens?.["input"]) ?? 0;
  const outputTokens = num(tokens?.["output"]) ?? 0;
  const cachedTokens = num(tokens?.["cached"]) ?? 0;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    avgLatencyMs: Math.round(num(tokens?.["latency"]) ?? 0),
    agentEnabled: agentEnabled(businessId),
    needsHuman: one(needsHumanCount, businessId),
    estimatedCostUsd: Number(
      (
        (inputTokens / 1e6) * USD_PER_MTOK_IN +
        (outputTokens / 1e6) * USD_PER_MTOK_OUT +
        (cachedTokens / 1e6) * USD_PER_MTOK_CACHED
      ).toFixed(4),
    ),
    inbound: one(totalIn, businessId),
    outbound: one(totalOut, businessId),
    failed: one(failedOut, businessId),
    contacts: one(contactCount, businessId),
    last24h: one(since, businessId, dayAgo),
    openWindows: one(openWindows, businessId, dayAgo),
    rejectedSignatures: one(eventCount, businessId, "invalid_signature"),
    graphErrors: one(eventCount, businessId, "graph_api_error"),
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

// --- contacts -----------------------------------------------------------------

export interface ContactRow {
  waId: string;
  name: string | null;
  firstSeen: number;
  lastMessageTs: number | null;
  inbound: number;
  outbound: number;
  /** Bookings not cancelled, past and future. */
  bookings: number;
  control: "ai" | "human";
  needsHuman: boolean;
}

export type ContactSort = "recent" | "name" | "first_seen" | "messages";

const CONTACT_ORDER: Record<ContactSort, string> = {
  recent: "COALESCE(c.last_message_ts, 0) DESC",
  name: "COALESCE(c.name, c.wa_id) COLLATE NOCASE ASC",
  first_seen: "c.first_seen DESC",
  messages: "(c.inbound_count + c.outbound_count) DESC",
};

// One prepared statement per sort order: ORDER BY cannot be a bound parameter,
// and the order comes from this fixed map, never from the request.
const contactsStmts = Object.fromEntries(
  (Object.keys(CONTACT_ORDER) as ContactSort[]).map((sort) => [sort, db.prepare(`
    SELECT c.wa_id, c.name, c.first_seen, c.last_message_ts, c.inbound_count, c.outbound_count,
           c.control, c.needs_human,
           (SELECT COUNT(*) FROM bookings b
             WHERE b.business_id = c.business_id AND b.wa_id = c.wa_id AND b.status != 'cancelled') AS bookings
    FROM contacts c
    WHERE c.business_id = ?1
      AND (?2 = '' OR c.name LIKE ?3 ESCAPE '!' OR c.wa_id LIKE ?3 ESCAPE '!')
    ORDER BY ${CONTACT_ORDER[sort]}, c.wa_id
    LIMIT ?4
  `)]),
) as Record<ContactSort, ReturnType<typeof db.prepare>>;

export function listContacts(businessId: BusinessId, opts: { q?: string; sort?: ContactSort; limit?: number } = {}): ContactRow[] {
  const q = (opts.q ?? "").trim().slice(0, 100);
  return contactsStmts[opts.sort ?? "recent"]
    .all(businessId, q, likeContains(q), Math.min(opts.limit ?? 1000, 100_000))
    .map((r) => ({
      waId: String(r["wa_id"]),
      name: str(r["name"]),
      firstSeen: num(r["first_seen"]) ?? 0,
      lastMessageTs: num(r["last_message_ts"]),
      inbound: num(r["inbound_count"]) ?? 0,
      outbound: num(r["outbound_count"]) ?? 0,
      bookings: num(r["bookings"]) ?? 0,
      control: r["control"] === "human" ? "human" : "ai",
      needsHuman: Number(r["needs_human"] ?? 0) === 1,
    }));
}
