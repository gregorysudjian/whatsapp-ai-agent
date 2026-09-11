/**
 * Bookings: made by the agent for a customer, or by the owner on the
 * dashboard.
 *
 * Backed by a real table rather than hardcoded responses, so the tools can
 * genuinely fail - a double booking, a past slot, a closed day - and the agent
 * has to handle that rather than always getting a happy answer.
 *
 * Times are wall-clock "YYYY-MM-DDTHH:MM" in the BUSINESS's timezone, never
 * the server's. A server in Canada booking for a business in Beirut must
 * treat "08:00" as 8am in Beirut: comparing it against the server's own clock
 * would put every "is this in the past?" answer seven hours out. Strings of
 * that shape also compare correctly as plain strings, which the overlap check
 * relies on.
 *
 * One booking at a time per business: two non-cancelled bookings may touch
 * (10:00-11:00 and 11:00-12:00) but never overlap, whoever made them.
 */

import { db, type BusinessId } from "./db.ts";
import { getBusiness, getSchedule, type DayHours } from "./businesses.ts";
import { getService } from "./services.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** The agent offers and books on this grid; owners may pick any minute. */
export const GRID_MIN = 30;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The current wall-clock time in `timeZone`, as "YYYY-MM-DDTHH:MM" - the same
 * shape as a booking time, so the two compare correctly as plain strings.
 */
export function wallClockNow(timeZone: string, at: number = Date.now()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

/** Has this time already passed where the business is? */
export function isPastInZone(start: string, timeZone: string, at: number = Date.now()): boolean {
  return start <= wallClockNow(timeZone, at);
}

function zoneOf(businessId: BusinessId): string {
  return getBusiness(businessId)?.timezone ?? "America/Toronto";
}

/** "HH:MM" -> minutes since midnight. */
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** A real calendar date and time, not merely the right shape ("2030-02-30T10:00" is not). */
function validStart(start: string): boolean {
  if (!START.test(start)) return false;
  const d = new Date(`${start}:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 16) === start;
}

/** start + duration, or null when it would run past midnight. */
export function endOf(start: string, durationMin: number): string | null {
  const end = minutes(start.slice(11)) + durationMin;
  if (end > 24 * 60) return null;
  // 24:00 is written as the end of the day, which still sorts after 23:59.
  return `${start.slice(0, 10)}T${end === 24 * 60 ? "24:00" : hhmm(end)}`;
}

/** Opening hours on a YYYY-MM-DD date, or null when closed that day. */
function hoursOn(businessId: BusinessId, date: string): DayHours | null {
  // The weekday of a calendar date does not depend on any timezone; computing
  // it in UTC keeps the server's own zone out of the answer entirely.
  const weekday = String(new Date(`${date}T12:00:00Z`).getUTCDay()) as keyof ReturnType<typeof getSchedule>;
  return getSchedule(businessId)[weekday] ?? null;
}

/** Does [start, end) sit wholly inside the day's opening hours? */
function withinHours(hours: DayHours, start: string, end: string): boolean {
  return start.slice(11) >= hours.open && end.slice(11) <= hours.close;
}

// --- the row ------------------------------------------------------------------

export type BookingStatus = "booked" | "confirmed" | "cancelled" | "completed" | "no_show";
export const BOOKING_STATUSES: readonly BookingStatus[] = ["booked", "confirmed", "cancelled", "completed", "no_show"];
export type BookingSource = "agent" | "owner";

export interface Booking {
  id: number;
  waId: string | null;
  customerName: string | null;
  serviceId: number | null;
  serviceName: string | null;
  start: string;
  end: string;
  durationMin: number;
  partySize: number;
  status: BookingStatus;
  source: BookingSource;
  notes: string;
  reminderSentAt: number | null;
  confirmedAt: number | null;
  cancelledAt: number | null;
  calendarEventId: string | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT = `
  SELECT b.*, s.name AS service_name
  FROM bookings b LEFT JOIN services s ON s.id = b.service_id AND s.business_id = b.business_id`;

function toBooking(r: Record<string, unknown>): Booking {
  const n = (k: string) => (r[k] == null ? null : Number(r[k]));
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    id: Number(r["id"]),
    waId: s("wa_id"),
    customerName: s("customer_name"),
    serviceId: n("service_id"),
    serviceName: s("service_name"),
    start: String(r["start_at"]),
    end: String(r["end_at"]),
    durationMin: Number(r["duration_min"]),
    partySize: Number(r["party_size"]),
    status: String(r["status"]) as BookingStatus,
    source: String(r["source"]) as BookingSource,
    notes: String(r["notes"] ?? ""),
    reminderSentAt: n("reminder_sent_at"),
    confirmedAt: n("confirmed_at"),
    cancelledAt: n("cancelled_at"),
    calendarEventId: s("calendar_event_id"),
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
}

const getStmt = db.prepare(`${SELECT} WHERE b.business_id = ? AND b.id = ?`);

export function getBooking(businessId: BusinessId, id: number): Booking | undefined {
  if (!Number.isSafeInteger(id)) return undefined;
  const row = getStmt.get(businessId, id) as Record<string, unknown> | undefined;
  return row ? toBooking(row) : undefined;
}

export interface BookingQuery {
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  /** YYYY-MM-DD, inclusive. */
  to?: string;
  status?: BookingStatus | "active";
  waId?: string;
  limit?: number;
}

const listStmt = db.prepare(`${SELECT}
  WHERE b.business_id = ?1
    AND (?2 IS NULL OR b.start_at >= ?2)
    AND (?3 IS NULL OR b.start_at < ?3)
    AND (?4 IS NULL OR (?4 = 'active' AND b.status NOT IN ('cancelled')) OR b.status = ?4)
    AND (?5 IS NULL OR b.wa_id = ?5)
  ORDER BY b.start_at ASC, b.id ASC
  LIMIT ?6`);

export function listBookings(businessId: BusinessId, q: BookingQuery = {}): Booking[] {
  const from = q.from && DATE.test(q.from) ? q.from : null;
  // "to" is a whole day: everything starting before the next midnight.
  const to = q.to && DATE.test(q.to) ? `${q.to}T99` : null;
  return listStmt
    .all(businessId, from, to, q.status ?? null, q.waId ?? null, Math.min(q.limit ?? 500, 2000))
    .map((r) => toBooking(r as Record<string, unknown>));
}

// --- availability ----------------------------------------------------------------

const busyStmt = db.prepare(`
  SELECT id, start_at, end_at FROM bookings
  WHERE business_id = ? AND status != 'cancelled' AND start_at < ? AND end_at > ?
`);

/** Non-cancelled bookings overlapping [start, end), ignoring `exceptId` (the one being moved). */
function overlaps(businessId: BusinessId, start: string, end: string, exceptId?: number): boolean {
  return (busyStmt.all(businessId, end, start) as Record<string, unknown>[])
    .some((r) => Number(r["id"]) !== exceptId);
}

export interface SlotQuery {
  /** The service to fit; its duration is used. An inactive or unknown one has no slots. */
  serviceId?: number;
  /** Used when no service is given. Default 60. */
  durationMin?: number;
  /** A booking being moved: its own current time does not count as busy. */
  exceptId?: number;
}

/**
 * Free start times on `date`: on the 30-minute grid, wholly inside opening
 * hours for the whole duration, not overlapping anything, not in the past.
 */
export function availableSlots(businessId: BusinessId, date: string, q: SlotQuery = {}): string[] {
  if (!DATE.test(date) || !validStart(`${date}T00:00`)) return [];
  const hours = hoursOn(businessId, date);
  if (!hours) return [];
  let duration = q.durationMin ?? 60;
  if (q.serviceId !== undefined) {
    const svc = getService(businessId, q.serviceId);
    if (!svc || !svc.active) return [];
    duration = svc.durationMin;
  }
  const exceptId = q.exceptId;

  const busy = (busyStmt.all(businessId, `${date}T99`, `${date}T00:00`) as Record<string, unknown>[])
    .filter((r) => Number(r["id"]) !== exceptId)
    .map((r) => [String(r["start_at"]), String(r["end_at"])] as const);
  const zone = zoneOf(businessId);

  const slots: string[] = [];
  const open = Math.ceil(minutes(hours.open) / GRID_MIN) * GRID_MIN;
  for (let m = open; m + duration <= minutes(hours.close); m += GRID_MIN) {
    const start = `${date}T${hhmm(m)}`;
    const end = endOf(start, duration);
    if (!end) break;
    if (busy.some(([s, e]) => s < end && e > start)) continue;
    if (isPastInZone(start, zone)) continue; // no booking the past
    slots.push(start);
  }
  return slots;
}

// --- writes --------------------------------------------------------------------

type BookingListener = (businessId: BusinessId, booking: Booking) => void;
const listeners = new Set<BookingListener>();

/**
 * Told after every booking is created or changed, whoever changed it (agent,
 * owner, a customer's button). Calendar sync hangs off this, so no write
 * path can forget to sync. A listener's failure never undoes the booking.
 */
export function onBookingChange(fn: BookingListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(businessId: BusinessId, result: BookingResult): BookingResult {
  if (result.ok) {
    for (const fn of listeners) {
      try { fn(businessId, result.booking); } catch { /* a listener's problem, not the booking's */ }
    }
  }
  return result;
}

const eventIdStmt = db.prepare(`UPDATE bookings SET calendar_event_id = ? WHERE business_id = ? AND id = ?`);

/** Record (or clear) the calendar event mirroring a booking. Deliberately not a change: no listeners. */
export function setCalendarEventId(businessId: BusinessId, id: number, eventId: string | null): void {
  eventIdStmt.run(eventId, businessId, id);
}

export type BookingFailure =
  | "past" | "taken" | "closed" | "malformed" | "off_grid" | "no_service" | "not_found" | "cancelled";

export type BookingResult = { ok: true; booking: Booking } | { ok: false; reason: BookingFailure };

/**
 * Check-then-write inside BEGIN IMMEDIATE: the write lock is taken before
 * the overlap check, so another connection (the CLI, a second process)
 * cannot slip a booking in between the check and the insert.
 */
function inWriteTx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface NewBooking {
  waId: string | null;
  customerName: string | null;
  serviceId: number;
  start: string;
  source: BookingSource;
  notes?: string;
  partySize?: number;
}

const insertStmt = db.prepare(`
  INSERT INTO bookings (business_id, wa_id, customer_name, service_id, start_at, end_at, duration_min,
                        party_size, status, source, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?)
`);

/**
 * The rules differ by who books. The agent must stay on the grid and inside
 * opening hours - it is offering what the business advertises. An owner may
 * book any minute, even outside hours (they know about the Saturday
 * exception); nobody may book the past or on top of another booking.
 */
function checkSlot(businessId: BusinessId, start: string, durationMin: number, source: BookingSource, exceptId?: number):
  { ok: true; end: string } | { ok: false; reason: BookingFailure } {
  if (!validStart(start)) return { ok: false, reason: "malformed" };
  const end = endOf(start, durationMin);
  if (!end) return { ok: false, reason: "closed" };
  if (isPastInZone(start, zoneOf(businessId))) return { ok: false, reason: "past" };
  if (source === "agent") {
    if (minutes(start.slice(11)) % GRID_MIN !== 0) return { ok: false, reason: "off_grid" };
    const hours = hoursOn(businessId, start.slice(0, 10));
    if (!hours || !withinHours(hours, start, end)) return { ok: false, reason: "closed" };
  }
  if (overlaps(businessId, start, end, exceptId)) return { ok: false, reason: "taken" };
  return { ok: true, end };
}

export function createBooking(businessId: BusinessId, input: NewBooking): BookingResult {
  const service = getService(businessId, input.serviceId);
  if (!service || !service.active) return { ok: false, reason: "no_service" };

  return changed(businessId, inWriteTx((): BookingResult => {
    const slot = checkSlot(businessId, input.start, service.durationMin, input.source);
    if (!slot.ok) return slot;
    const now = Date.now();
    const id = Number(insertStmt.run(
      businessId, input.waId, input.customerName?.trim().slice(0, 120) || null, service.id,
      input.start, slot.end, service.durationMin, Math.max(1, Math.min(input.partySize ?? 1, 100)),
      input.source, (input.notes ?? "").trim().slice(0, 1000), now, now,
    ).lastInsertRowid);
    return { ok: true, booking: getBooking(businessId, id)! };
  }));
}

export interface BookingPatch {
  start?: string;
  serviceId?: number;
  status?: BookingStatus;
  notes?: string;
  customerName?: string | null;
  partySize?: number;
}

const updateStmt = db.prepare(`
  UPDATE bookings SET start_at = ?, end_at = ?, duration_min = ?, service_id = ?, status = ?, notes = ?,
    customer_name = ?, party_size = ?, confirmed_at = ?, cancelled_at = ?, reminder_sent_at = ?, updated_at = ?
  WHERE business_id = ? AND id = ?
`);

/**
 * One path for every change, so the overlap rule cannot be skipped by
 * whichever caller forgot it: moving a booking, changing its service (and so
 * its length), or reviving a cancelled one all re-check.
 */
export function updateBooking(businessId: BusinessId, id: number, patch: BookingPatch, source: BookingSource): BookingResult {
  return changed(businessId, inWriteTx((): BookingResult => {
    const current = getBooking(businessId, id);
    if (!current) return { ok: false, reason: "not_found" };

    let durationMin = current.durationMin;
    let serviceId = current.serviceId;
    if (patch.serviceId !== undefined && patch.serviceId !== current.serviceId) {
      const svc = getService(businessId, patch.serviceId);
      if (!svc || !svc.active) return { ok: false, reason: "no_service" };
      durationMin = svc.durationMin;
      serviceId = svc.id;
    }
    const start = patch.start ?? current.start;
    const status = patch.status ?? current.status;
    const moved = start !== current.start || durationMin !== current.durationMin;
    const revived = current.status === "cancelled" && status !== "cancelled";

    let end = current.end;
    if (moved || revived) {
      if (status !== "cancelled") {
        // A revived booking in the past may keep its time (the owner is
        // recording what happened); a moved one must go to the future.
        if (moved) {
          const check = checkSlot(businessId, start, durationMin, source, id);
          if (!check.ok) return check;
          end = check.end;
        } else if (overlaps(businessId, current.start, current.end, id)) {
          return { ok: false, reason: "taken" };
        }
      } else {
        const e = validStart(start) ? endOf(start, durationMin) : null;
        if (!e) return { ok: false, reason: "malformed" };
        end = e;
      }
    }

    const now = Date.now();
    updateStmt.run(
      start, end, durationMin, serviceId, status,
      patch.notes !== undefined ? patch.notes.trim().slice(0, 1000) : current.notes,
      patch.customerName !== undefined ? (patch.customerName?.trim().slice(0, 120) || null) : current.customerName,
      patch.partySize !== undefined ? Math.max(1, Math.min(patch.partySize, 100)) : current.partySize,
      status === "confirmed" ? (current.confirmedAt ?? now) : current.confirmedAt,
      status === "cancelled" ? (current.cancelledAt ?? now) : null,
      // A moved booking needs a fresh reminder for its new time.
      moved ? null : current.reminderSentAt,
      now, businessId, id,
    );
    return { ok: true, booking: getBooking(businessId, id)! };
  }));
}

// --- what a customer may do to their own bookings ----------------------------------

/** Upcoming, not cancelled - what "my bookings" means to a customer. */
export function upcomingForCustomer(businessId: BusinessId, waId: string): Booking[] {
  const now = wallClockNow(zoneOf(businessId));
  return listBookings(businessId, { waId, status: "active" }).filter((b) => b.start > now && b.status !== "completed" && b.status !== "no_show");
}

/**
 * A customer's booking, or why not. Someone else's booking answers exactly
 * like one that does not exist: a customer guessing ids learns nothing.
 */
function customersOwn(businessId: BusinessId, waId: string, id: number): { ok: true; booking: Booking } | { ok: false; reason: BookingFailure } {
  const b = getBooking(businessId, id);
  if (!b || b.waId !== waId) return { ok: false, reason: "not_found" };
  if (b.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (isPastInZone(b.start, zoneOf(businessId))) return { ok: false, reason: "past" };
  return { ok: true, booking: b };
}

export function cancelForCustomer(businessId: BusinessId, waId: string, id: number): BookingResult {
  const own = customersOwn(businessId, waId, id);
  if (!own.ok) return own;
  return updateBooking(businessId, id, { status: "cancelled" }, "agent");
}

export function rescheduleForCustomer(businessId: BusinessId, waId: string, id: number, start: string): BookingResult {
  const own = customersOwn(businessId, waId, id);
  if (!own.ok) return own;
  // A confirmed booking moved to a new time is no longer confirmed for it.
  return updateBooking(businessId, id, { start, status: "booked" }, "agent");
}

// --- reminders ----------------------------------------------------------------------

const dueStmt = db.prepare(`${SELECT}
  WHERE b.business_id = ? AND b.status IN ('booked', 'confirmed') AND b.reminder_sent_at IS NULL
    AND b.wa_id IS NOT NULL AND b.start_at > ? AND b.start_at <= ?
  ORDER BY b.start_at`);

/** Bookings starting in (fromWall, toWall] that have not been reminded and have a WhatsApp number. */
export function dueForReminder(businessId: BusinessId, fromWall: string, toWall: string): Booking[] {
  return dueStmt.all(businessId, fromWall, toWall).map((r) => toBooking(r as Record<string, unknown>));
}

const claimStmt = db.prepare(
  `UPDATE bookings SET reminder_sent_at = ? WHERE business_id = ? AND id = ? AND reminder_sent_at IS NULL`,
);

/**
 * Take the right to send this booking's reminder. Exactly one caller ever
 * gets true - two overlapping scheduler runs, or a restart mid-run, cannot
 * send the same reminder twice.
 */
export function claimReminder(businessId: BusinessId, id: number, now: number = Date.now()): boolean {
  return Number(claimStmt.run(now, businessId, id).changes) === 1;
}
