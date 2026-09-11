/**
 * Bookings the agent makes.
 *
 * Backed by a real table rather than hardcoded responses, so the tools can
 * genuinely fail - a double booking, a past slot, a closed day - and the agent
 * has to handle that rather than always getting a happy answer.
 *
 * Hours come from each business's own schedule. Slots are one hour, on the
 * hour, and must fit entirely inside opening hours: a 15:00 close means the
 * last slot starts at 14:00.
 *
 * Slots are wall-clock times in the BUSINESS's timezone, never the server's.
 * A server in Canada booking for a business in Beirut must treat "08:00" as
 * 8am in Beirut: comparing it against the server's own clock would put every
 * "is this in the past?" answer seven hours out.
 */

import { db, type BusinessId } from "./db.ts";
import { getBusiness, getSchedule, type DayHours } from "./businesses.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:00$/;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The current wall-clock time in `timeZone`, as "YYYY-MM-DDTHH:MM" - the same
 * shape as a slot, so the two compare correctly as plain strings.
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

/** Has this slot's start already passed where the business is? */
export function isPastInZone(slot: string, timeZone: string, at: number = Date.now()): boolean {
  return slot <= wallClockNow(timeZone, at);
}

function zoneOf(businessId: BusinessId): string {
  return getBusiness(businessId)?.timezone ?? "America/Toronto";
}

/** Opening hours on a YYYY-MM-DD date, or null when closed that day. */
function hoursOn(businessId: BusinessId, date: string): DayHours | null {
  // The weekday of a calendar date does not depend on any timezone; computing
  // it in UTC keeps the server's own zone out of the answer entirely.
  const weekday = String(new Date(`${date}T12:00:00Z`).getUTCDay()) as keyof ReturnType<typeof getSchedule>;
  return getSchedule(businessId)[weekday] ?? null;
}

/** Does a one-hour slot starting at `hour` fit wholly inside `hours`? */
function fits(hours: DayHours, hour: number): boolean {
  return `${pad(hour)}:00` >= hours.open && `${pad(hour + 1)}:00` <= hours.close;
}

const bookedStmt = db.prepare(
  `SELECT slot FROM bookings WHERE business_id = ? AND slot LIKE ?`,
);

/** `date` is YYYY-MM-DD. Returns the slots still free that day, if any. */
export function availableSlots(businessId: BusinessId, date: string): string[] {
  if (!DATE.test(date)) return [];
  const hours = hoursOn(businessId, date);
  if (!hours) return [];

  const taken = new Set(
    bookedStmt.all(businessId, `${date}%`).map((r) => String(r["slot"])),
  );
  const zone = zoneOf(businessId);

  const slots: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    if (!fits(hours, hour)) continue;
    const slot = `${date}T${pad(hour)}:00`;
    if (taken.has(slot)) continue;
    if (isPastInZone(slot, zone)) continue; // no booking the past
    slots.push(slot);
  }
  return slots;
}

const insertBooking = db.prepare(`
  INSERT INTO bookings (business_id, wa_id, name, slot, party_size, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export type BookingResult =
  | { ok: true; slot: string }
  | { ok: false; reason: "past" | "taken" | "closed" | "malformed" };

export function createBooking(
  businessId: BusinessId,
  waId: string,
  name: string | null,
  slot: string,
  partySize: number,
): BookingResult {
  if (!SLOT.test(slot)) return { ok: false, reason: "malformed" };

  // A well-formed string can still name a date that does not exist.
  if (Number.isNaN(new Date(`${slot}:00Z`).getTime()) ||
      new Date(`${slot}:00Z`).toISOString().slice(0, 16) !== slot) {
    return { ok: false, reason: "malformed" };
  }
  if (isPastInZone(slot, zoneOf(businessId))) return { ok: false, reason: "past" };

  const hours = hoursOn(businessId, slot.slice(0, 10));
  if (!hours || !fits(hours, Number(slot.slice(11, 13)))) return { ok: false, reason: "closed" };

  try {
    insertBooking.run(businessId, waId, name, slot, partySize, Date.now());
    return { ok: true, slot };
  } catch {
    // UNIQUE(business_id, slot) - someone else took it. Relying on the
    // constraint rather than a check-then-insert, which races.
    return { ok: false, reason: "taken" };
  }
}
