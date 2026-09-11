/**
 * What a business offers, how long it takes, and what it costs.
 *
 * A table rather than JSON so each service has a stable id: bookings point at
 * it (from D6), and renaming or retiring a service must not orphan the
 * bookings already made. Removing one therefore deactivates it - it vanishes
 * from the agent and the dashboard's active list, and past bookings keep it.
 */

import { z } from "zod";
import { db, type BusinessId } from "./db.ts";
import { ValidationError } from "./errors.ts";

export interface Service {
  id: number;
  businessId: BusinessId;
  name: string;
  description: string;
  durationMin: number;
  /** Null when the business has not set a price; the agent then says so. */
  priceCents: number | null;
  currency: string;
  active: boolean;
  sort: number;
}

export const ServiceInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  durationMin: z.number().int().min(5).max(24 * 60),
  priceCents: z.number().int().min(0).max(100_000_000).nullable(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "a 3-letter currency code, like CAD or USD"),
  sort: z.number().int().min(0).max(10_000).default(0),
}).strict();

export type ServiceInputT = z.input<typeof ServiceInput>;

function toService(r: Record<string, unknown>): Service {
  return {
    id: Number(r["id"]),
    businessId: Number(r["business_id"]),
    name: String(r["name"]),
    description: String(r["description"] ?? ""),
    durationMin: Number(r["duration_min"]),
    priceCents: r["price_cents"] == null ? null : Number(r["price_cents"]),
    currency: String(r["currency"]),
    active: Number(r["active"]) === 1,
    sort: Number(r["sort"]),
  };
}

const listActive = db.prepare(`SELECT * FROM services WHERE business_id = ? AND active = 1 ORDER BY sort, id`);
const listAll = db.prepare(`SELECT * FROM services WHERE business_id = ? ORDER BY active DESC, sort, id`);
const getOne = db.prepare(`SELECT * FROM services WHERE business_id = ? AND id = ?`);

export function listServices(bid: BusinessId, includeInactive = false): Service[] {
  return (includeInactive ? listAll : listActive).all(bid).map((r) => toService(r as Record<string, unknown>));
}

/** Scoped by business: an id from another business is simply "not found". */
export function getService(bid: BusinessId, id: number): Service | undefined {
  const r = getOne.get(bid, id) as Record<string, unknown> | undefined;
  return r ? toService(r) : undefined;
}

function validate(input: unknown) {
  const parsed = ServiceInput.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`${first?.path.join(".") || "service"}: ${first?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const insertStmt = db.prepare(`
  INSERT INTO services (business_id, name, description, duration_min, price_cents, currency, active, sort, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
`);

export function createService(bid: BusinessId, input: unknown): Service {
  const s = validate(input);
  const now = Date.now();
  const result = insertStmt.run(bid, s.name, s.description, s.durationMin, s.priceCents, s.currency, s.sort, now, now);
  return getService(bid, Number(result.lastInsertRowid))!;
}

const updateStmt = db.prepare(`
  UPDATE services SET name = ?, description = ?, duration_min = ?, price_cents = ?, currency = ?, sort = ?, updated_at = ?
  WHERE business_id = ? AND id = ?
`);

export function updateService(bid: BusinessId, id: number, input: unknown): Service | undefined {
  const s = validate(input);
  const result = updateStmt.run(s.name, s.description, s.durationMin, s.priceCents, s.currency, s.sort, Date.now(), bid, id);
  return Number(result.changes) === 1 ? getService(bid, id) : undefined;
}

const deactivateStmt = db.prepare(`UPDATE services SET active = 0, updated_at = ? WHERE business_id = ? AND id = ?`);

/** Retires a service. Returns false when it does not exist in this business. */
export function deactivateService(bid: BusinessId, id: number): boolean {
  return Number(deactivateStmt.run(Date.now(), bid, id).changes) === 1;
}

/** "USD 25.00", or null when unpriced. */
export function formatPrice(s: Pick<Service, "priceCents" | "currency">): string | null {
  return s.priceCents == null ? null : `${s.currency} ${(s.priceCents / 100).toFixed(2)}`;
}
