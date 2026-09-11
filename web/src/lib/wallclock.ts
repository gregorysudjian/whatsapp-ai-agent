/**
 * Booking times are wall-clock strings in the BUSINESS's timezone
 * ("2030-01-31T10:00"). The browser may be anywhere, so these helpers never
 * let its own timezone touch them: every Date here is built in UTC and
 * formatted in UTC, which makes it a plain calendar/clock value.
 */

export type Wall = string; // "YYYY-MM-DDTHH:MM"
export type Day = string; // "YYYY-MM-DD"

const pad = (n: number) => String(n).padStart(2, "0");

const utc = (day: Day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

export function dayOf(w: Wall): Day {
  return w.slice(0, 10);
}

/** Minutes since midnight. "24:00" (the end of a day) is 1440. */
export function minutesOf(w: Wall): number {
  return Number(w.slice(11, 13)) * 60 + Number(w.slice(14, 16));
}

/** "HH:MM" (a schedule time) -> minutes since midnight. */
export function clockMinutes(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

export function addDays(day: Day, n: number): Day {
  const d = new Date(utc(day) + n * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 0 = Sunday ... 6 = Saturday, matching the schedule's keys. */
export function weekdayOf(day: Day): number {
  return new Date(utc(day)).getUTCDay();
}

/** The Monday on or before `day`. */
export function weekStart(day: Day): Day {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** Format a wall-clock value without any timezone conversion. */
export function fmtWall(locale: string, w: Wall | Day, opts: Intl.DateTimeFormatOptions): string {
  const ms = w.length === 10 ? utc(w) : utc(dayOf(w)) + Math.min(minutesOf(w), 1439) * 60_000;
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(ms);
}

export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
