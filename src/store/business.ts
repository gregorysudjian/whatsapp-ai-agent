/**
 * Business data the tools act on.
 *
 * Backed by real tables rather than hardcoded responses, so the tools can
 * genuinely fail - a double booking, an unknown order - and the agent has to
 * handle that rather than always getting a happy answer.
 */

import { db } from "./db.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id        TEXT PRIMARY KEY,
    phone     TEXT NOT NULL,
    status    TEXT NOT NULL,
    item      TEXT NOT NULL,
    placed_at INTEGER NOT NULL,
    eta       TEXT
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id      TEXT NOT NULL,
    name       TEXT,
    slot       TEXT NOT NULL UNIQUE,
    party_size INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS bookings_by_slot ON bookings (slot);
`);

export interface Order {
  id: string;
  phone: string;
  status: string;
  item: string;
  placedAt: number;
  eta: string | null;
}

const orderStmt = db.prepare(`SELECT * FROM orders WHERE id = ?`);

/**
 * Order id alone is not enough - anyone could guess one. The phone number
 * must match the number the message came from.
 */
export function lookupOrder(orderId: string, phone: string): Order | "not_found" | "wrong_phone" {
  const row = orderStmt.get(orderId.trim().toUpperCase()) as Record<string, unknown> | undefined;
  if (row === undefined) return "not_found";
  if (String(row["phone"]) !== phone) return "wrong_phone";

  return {
    id: String(row["id"]),
    phone: String(row["phone"]),
    status: String(row["status"]),
    item: String(row["item"]),
    placedAt: Number(row["placed_at"]),
    eta: row["eta"] === null ? null : String(row["eta"]),
  };
}

/** Bookable hours, local time, on the hour. */
const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;

const bookedStmt = db.prepare(`SELECT slot FROM bookings WHERE slot LIKE ?`);

/** `date` is YYYY-MM-DD. Returns ISO-ish slot strings still free. */
export function availableSlots(date: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

  const taken = new Set(
    bookedStmt.all(`${date}%`).map((r) => String(r["slot"])),
  );

  const slots: string[] = [];
  for (let hour = OPEN_HOUR; hour < CLOSE_HOUR; hour++) {
    const slot = `${date}T${String(hour).padStart(2, "0")}:00`;
    if (taken.has(slot)) continue;
    if (new Date(slot).getTime() <= Date.now()) continue; // no booking the past
    slots.push(slot);
  }
  return slots;
}

const insertBooking = db.prepare(`
  INSERT INTO bookings (wa_id, name, slot, party_size, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

export type BookingResult =
  | { ok: true; slot: string }
  | { ok: false; reason: "past" | "taken" | "closed" | "malformed" };

export function createBooking(
  waId: string,
  name: string | null,
  slot: string,
  partySize: number,
): BookingResult {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(slot)) return { ok: false, reason: "malformed" };

  const when = new Date(slot);
  if (Number.isNaN(when.getTime())) return { ok: false, reason: "malformed" };
  if (when.getTime() <= Date.now()) return { ok: false, reason: "past" };

  const hour = Number(slot.slice(11, 13));
  if (hour < OPEN_HOUR || hour >= CLOSE_HOUR) return { ok: false, reason: "closed" };

  try {
    insertBooking.run(waId, name, slot, partySize, Date.now());
    return { ok: true, slot };
  } catch {
    // UNIQUE(slot) - someone else took it. Relying on the constraint rather
    // than a check-then-insert, which races.
    return { ok: false, reason: "taken" };
  }
}

const insertOrder = db.prepare(`
  INSERT INTO orders (id, phone, status, item, placed_at, eta) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    phone = excluded.phone, status = excluded.status, item = excluded.item
`);

/**
 * Create one order. Explicit, never automatic - demo fixtures must not
 * appear in a real database by accident.
 */
export function seedOrder(
  id: string,
  phone: string,
  status = "shipped",
  item = "Blue widget x2",
  eta: string | null = "Tomorrow",
): string {
  insertOrder.run(id.toUpperCase(), phone, status, item, Date.now() - 3600000, eta);
  return id.toUpperCase();
}
