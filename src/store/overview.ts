/**
 * The Overview page's numbers for one business over a date range.
 *
 * Days are the BUSINESS's days: a message at 23:30 in Beirut belongs to that
 * Beirut date, whatever the server's clock says. SQLite has no timezone
 * support, so each day's boundaries are computed as instants here and rows
 * are bucketed in JavaScript - a few thousand rows per business per quarter.
 */

import { db, type BusinessId } from "./db.ts";
import { getBusiness } from "./businesses.ts";
import { wallClockNow } from "./bookings.ts";

export const MAX_RANGE_DAYS = 366;

const pad = (n: number) => String(n).padStart(2, "0");

export function addDays(day: string, n: number): string {
  const d = new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The instant a business-local calendar day begins (handles DST shifts). */
export function startOfDay(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offsetAt = (t: number) => Date.parse(`${wallClockNow(timeZone, t)}:00Z`) - t;
  let t = guess - offsetAt(guess);
  // A second pass settles days where the offset changes between the guess and midnight.
  t = guess - offsetAt(t);
  return t;
}

export interface DayStats {
  date: string;
  conversations: number;
  inbound: number;
  ai: number;
  human: number;
  bookings: number;
  /** Median minutes-to-reply for customer messages that day; null with none answered. */
  responseMedianMs: number | null;
}

export interface Totals {
  conversationsStarted: number;
  inbound: number;
  aiReplies: number;
  humanReplies: number;
  systemMessages: number;
  /** Share of replies written by the agent rather than a person; null with no replies. */
  aiShare: number | null;
  bookingsMade: number;
  bookingsByAgent: number;
  handoffs: number;
  takeovers: number;
  responseMedianMs: number | null;
  responseP90Ms: number | null;
  /** Customer messages still unanswered (no reply within 24 hours, or none yet). */
  unanswered: number;
}

export interface Overview {
  range: { from: string; to: string; timezone: string; days: number };
  totals: Totals;
  previous: Totals;
  bookingsByStatus: Record<"booked" | "confirmed" | "completed" | "no_show" | "cancelled", number>;
  daily: DayStats[];
}

const REPLY_WINDOW_MS = 24 * 3_600_000;

const messagesStmt = db.prepare(`
  SELECT wa_id, direction, sender, ts FROM messages
  WHERE business_id = ? AND ts >= ? AND ts < ?
  ORDER BY wa_id, rowid
`);
const contactsStmt = db.prepare(`SELECT first_seen FROM contacts WHERE business_id = ? AND first_seen >= ? AND first_seen < ?`);
const bookingsMadeStmt = db.prepare(`SELECT created_at, source FROM bookings WHERE business_id = ? AND created_at >= ? AND created_at < ?`);
const bookingStatusStmt = db.prepare(`
  SELECT status, COUNT(*) AS n FROM bookings WHERE business_id = ? AND start_at >= ? AND start_at < ? GROUP BY status
`);
const eventsStmt = db.prepare(`SELECT name, COUNT(*) AS n FROM events WHERE business_id = ? AND ts >= ? AND ts < ? AND name IN ('handoff_requested', 'taken_over') GROUP BY name`);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/** The first customer message of each unanswered run, and how long until the next reply. */
function responseTimes(rows: { wa_id: string; direction: string; sender: string | null; ts: number }[], from: number, to: number) {
  const out: { at: number; ms: number | null }[] = [];
  let convo = "";
  let waitingSince: number | null = null;
  const close = () => {
    if (waitingSince !== null && waitingSince >= from && waitingSince < to) out.push({ at: waitingSince, ms: null });
    waitingSince = null;
  };
  for (const r of rows) {
    if (r.wa_id !== convo) { close(); convo = r.wa_id; }
    if (r.direction === "in") {
      if (waitingSince === null) waitingSince = r.ts;
    } else if (r.sender === "ai" || r.sender === "human") {
      // Automatic notices (a button's confirmation, the media notice) are
      // not someone answering the customer.
      if (waitingSince !== null) {
        const ms = Math.max(0, r.ts - waitingSince);
        if (waitingSince >= from && waitingSince < to) out.push({ at: waitingSince, ms: ms <= REPLY_WINDOW_MS ? ms : null });
        waitingSince = null;
      }
    }
  }
  close();
  return out;
}

function computeTotals(bid: BusinessId, from: number, to: number) {
  // Replies can land after the range ends; look a day past it for them.
  const rows = messagesStmt.all(bid, from, to + REPLY_WINDOW_MS) as { wa_id: string; direction: string; sender: string | null; ts: number }[];
  const inRange = rows.filter((r) => r.ts >= from && r.ts < to);
  const count = (pred: (r: (typeof rows)[number]) => boolean) => inRange.filter(pred).length;
  const inbound = count((r) => r.direction === "in");
  const ai = count((r) => r.direction === "out" && (r.sender ?? "ai") === "ai");
  const human = count((r) => r.direction === "out" && r.sender === "human");
  const system = count((r) => r.direction === "out" && r.sender === "system");

  const times = responseTimes(rows, from, to);
  const answered = times.flatMap((x) => (x.ms === null ? [] : [x.ms])).sort((a, b) => a - b);

  const made = bookingsMadeStmt.all(bid, from, to) as { created_at: number; source: string }[];
  const events = Object.fromEntries((eventsStmt.all(bid, from, to) as { name: string; n: number }[]).map((e) => [e.name, Number(e.n)]));

  const totals: Totals = {
    conversationsStarted: (contactsStmt.all(bid, from, to) as unknown[]).length,
    inbound,
    aiReplies: ai,
    humanReplies: human,
    systemMessages: system,
    aiShare: ai + human > 0 ? ai / (ai + human) : null,
    bookingsMade: made.length,
    bookingsByAgent: made.filter((m) => m.source === "agent").length,
    handoffs: events["handoff_requested"] ?? 0,
    takeovers: events["taken_over"] ?? 0,
    responseMedianMs: percentile(answered, 0.5),
    responseP90Ms: percentile(answered, 0.9),
    unanswered: times.filter((x) => x.ms === null).length,
  };
  return { totals, rows: inRange, times, made };
}

/**
 * `from` and `to` are business-local YYYY-MM-DD dates, both inclusive.
 * Callers validate them; this clamps nothing but the range length.
 */
export function overview(bid: BusinessId, fromDay: string, toDay: string): Overview {
  const tz = getBusiness(bid)?.timezone ?? "UTC";
  const days: string[] = [];
  for (let d = fromDay; d <= toDay && days.length < MAX_RANGE_DAYS; d = addDays(d, 1)) days.push(d);
  const bounds = [...days.map((d) => startOfDay(d, tz)), startOfDay(addDays(days[days.length - 1] ?? fromDay, 1), tz)];
  const from = bounds[0]!;
  const to = bounds[bounds.length - 1]!;

  // The same number of days just before, for "vs previous period".
  const prevFrom = startOfDay(addDays(fromDay, -days.length), tz);
  const current = computeTotals(bid, from, to);
  const previous = computeTotals(bid, prevFrom, from).totals;

  /** Index of the business-local day an instant falls in (binary search over the boundaries). */
  const dayIndex = (t: number) => {
    let lo = 0, hi = days.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bounds[mid]! <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  const daily: DayStats[] = days.map((date) => ({ date, conversations: 0, inbound: 0, ai: 0, human: 0, bookings: 0, responseMedianMs: null }));
  for (const r of current.rows) {
    const d = daily[dayIndex(r.ts)]!;
    if (r.direction === "in") d.inbound++;
    else if ((r.sender ?? "ai") === "ai") d.ai++;
    else if (r.sender === "human") d.human++;
  }
  for (const m of current.made) daily[dayIndex(m.created_at)]!.bookings++;
  for (const c of contactsStmt.all(bid, from, to) as { first_seen: number }[]) daily[dayIndex(c.first_seen)]!.conversations++;
  const perDay = new Map<number, number[]>();
  for (const x of current.times) {
    if (x.ms === null) continue;
    const i = dayIndex(x.at);
    perDay.set(i, [...(perDay.get(i) ?? []), x.ms]);
  }
  for (const [i, list] of perDay) daily[i]!.responseMedianMs = percentile(list.sort((a, b) => a - b), 0.5);

  const byStatus = { booked: 0, confirmed: 0, completed: 0, no_show: 0, cancelled: 0 };
  for (const r of bookingStatusStmt.all(bid, `${fromDay}T00:00`, `${addDays(toDay, 1)}T00:00`) as { status: keyof typeof byStatus; n: number }[]) {
    byStatus[r.status] = Number(r.n);
  }

  return {
    range: { from: fromDay, to: days[days.length - 1] ?? toDay, timezone: tz, days: days.length },
    totals: current.totals,
    previous,
    bookingsByStatus: byStatus,
    daily,
  };
}
