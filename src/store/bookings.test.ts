import { test } from "node:test";
import assert from "node:assert/strict";
import { availableSlots, createBooking, isPastInZone, wallClockNow } from "./bookings.ts";
import { createService } from "./services.ts";
import {
  createBusiness, getBusiness, setBusinessTimezone, setSchedule, DEFAULT_BUSINESS_ID,
} from "./businesses.ts";

// Kiritimati is UTC+14 and Pago Pago UTC-11: at any instant their clocks are
// 25 hours apart, so the same wall-clock slot is past in one and future in
// the other - whatever timezone the machine running this test is in.
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Pacific/Pago_Pago";

test("wall-clock time has the same shape as a slot", () => {
  assert.match(wallClockNow("Asia/Beirut"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test("'in the past' is judged where the business is, not where the server is", () => {
  const now = Date.now();
  const thisHourAhead = wallClockNow(AHEAD, now).slice(0, 13) + ":00";

  assert.equal(isPastInZone(thisHourAhead, AHEAD, now), true,
    "the current hour has started, so it is past for a business there");
  assert.equal(isPastInZone(thisHourAhead, BEHIND, now), false,
    "the same wall-clock time is still about a day away 25 hours behind");
});

test("a business's weekday rules follow the calendar date, not the server's zone", () => {
  const biz = createBusiness({ name: "Sunday Only Shop", timezone: BEHIND });
  setSchedule(biz.id, { "0": { open: "09:00", close: "12:00" } });

  // 2030-01-06 is a Sunday; the day after is a Monday.
  assert.deepEqual(availableSlots(biz.id, "2030-01-06"), [
    "2030-01-06T09:00", "2030-01-06T09:30", "2030-01-06T10:00", "2030-01-06T10:30", "2030-01-06T11:00",
  ]);
  assert.deepEqual(availableSlots(biz.id, "2030-01-07"), []);
});

test("a date that does not exist is refused, not rolled over", () => {
  // new Date("2030-02-30") silently becomes March 2nd; a booking must not.
  const biz = createBusiness({ name: "Every Day Studio" });
  setSchedule(biz.id, Object.fromEntries(
    ["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, { open: "08:00", close: "18:00" }]),
  ));
  const serviceId = createService(biz.id, { name: "Visit", durationMin: 60, priceCents: null, currency: "CAD" }).id;
  const at = (start: string) => createBooking(biz.id, { waId: "1555", customerName: "X", serviceId, start, source: "agent" });
  assert.deepEqual(at("2030-02-30T10:00"), { ok: false, reason: "malformed" });
  assert.equal(at("2030-03-01T10:00").ok, true);
});

test("a timezone change takes effect, and a bad one is refused", () => {
  const biz = createBusiness({ name: "Moving Company" });
  setBusinessTimezone(biz.id, "Europe/Paris");
  assert.equal(getBusiness(biz.id)?.timezone, "Europe/Paris");
  assert.throws(() => setBusinessTimezone(biz.id, "Mars/Olympus_Mons"), /Unknown timezone/);
});

test("the default business is seeded in Beirut, where it actually is", () => {
  assert.equal(getBusiness(DEFAULT_BUSINESS_ID)?.timezone, "Asia/Beirut");
});
