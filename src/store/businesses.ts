/**
 * Clients of the platform, and the WhatsApp credentials each one brings.
 *
 * Credentials are encrypted on write and decrypted only at the moment of use.
 * Nothing in here returns a secret to a caller that asked for a Business -
 * `Business` has no secret fields at all, so a route cannot leak one by
 * serialising the wrong object.
 */

import crypto from "node:crypto";
import { db, type BusinessId } from "./db.ts";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { decrypt, encrypt, redact } from "../security/crypto.ts";
import {
  BUSINESS as SEED_FACTS, SEED_SCHEDULE, SEED_TIMEZONE, isConfigured, type BusinessFacts,
} from "../agent/persona.ts";

/** Created by migration 2; holds everything from before multi-tenancy. */
export const DEFAULT_BUSINESS_ID: BusinessId = 1;

export type BusinessStatus = "active" | "inactive";
export type Language = "en" | "fr";

/** Safe to send to a browser: no secrets, only whether they are set. */
export interface Business {
  id: BusinessId;
  publicId: string;
  name: string;
  status: BusinessStatus;
  timezone: string;
  defaultLanguage: Language;
  waPhoneNumberId: string | null;
  waBusinessAccountId: string | null;
  graphVersion: string;
  hasCredentials: boolean;
  createdAt: number;
}

/** Decrypted. Lives only for the duration of a send or a verification. */
export interface WhatsappCredentials {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
}

export class ValidationError extends Error {}

// --- validation -----------------------------------------------------------

function validName(name: unknown): string {
  const value = typeof name === "string" ? name.trim() : "";
  if (value.length < 2 || value.length > 120) {
    throw new ValidationError("Business name must be 2-120 characters.");
  }
  return value;
}

function validTimezone(tz: unknown): string {
  const value = typeof tz === "string" ? tz.trim() : "";
  try {
    // Throws RangeError on an unknown zone - the platform's own list, not ours.
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return value;
  } catch {
    throw new ValidationError(`Unknown timezone: ${value || "(empty)"}`);
  }
}

function validLanguage(lang: unknown): Language {
  if (lang === "en" || lang === "fr") return lang;
  throw new ValidationError("Language must be en or fr.");
}

/** Meta ids are long digit strings; anything else is a paste error. */
function validMetaId(label: string, value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!/^\d{6,25}$/.test(v)) throw new ValidationError(`${label} must be digits only.`);
  return v;
}

function validSecret(label: string, value: unknown, min = 8): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length < min || v.length > 1024) {
    throw new ValidationError(`${label} looks wrong (expected ${min}-1024 characters).`);
  }
  return v;
}

// --- reads ----------------------------------------------------------------

function toBusiness(r: Record<string, unknown>): Business {
  return {
    id: Number(r["id"]),
    publicId: String(r["public_id"]),
    name: String(r["name"]),
    status: r["status"] === "inactive" ? "inactive" : "active",
    timezone: String(r["timezone"]),
    defaultLanguage: r["default_language"] === "fr" ? "fr" : "en",
    waPhoneNumberId: r["wa_phone_number_id"] == null ? null : String(r["wa_phone_number_id"]),
    waBusinessAccountId: r["wa_business_account_id"] == null ? null : String(r["wa_business_account_id"]),
    graphVersion: String(r["graph_version"]),
    hasCredentials: r["wa_access_token_enc"] != null && r["wa_app_secret_enc"] != null,
    createdAt: Number(r["created_at"]),
  };
}

const byId = db.prepare(`SELECT * FROM businesses WHERE id = ?`);
const byPublicId = db.prepare(`SELECT * FROM businesses WHERE public_id = ?`);
const byPhoneId = db.prepare(`SELECT * FROM businesses WHERE wa_phone_number_id = ?`);
const all = db.prepare(`SELECT * FROM businesses ORDER BY id`);

export function getBusiness(id: BusinessId): Business | undefined {
  const row = byId.get(id) as Record<string, unknown> | undefined;
  return row ? toBusiness(row) : undefined;
}

export function getBusinessByPublicId(publicId: string): Business | undefined {
  const row = byPublicId.get(publicId) as Record<string, unknown> | undefined;
  return row ? toBusiness(row) : undefined;
}

export function getBusinessByPhoneNumberId(phoneNumberId: string): Business | undefined {
  const row = byPhoneId.get(phoneNumberId) as Record<string, unknown> | undefined;
  return row ? toBusiness(row) : undefined;
}

export function listBusinesses(): Business[] {
  return all.all().map((r) => toBusiness(r as Record<string, unknown>));
}

// --- writes ---------------------------------------------------------------

const insertBusiness = db.prepare(`
  INSERT INTO businesses (public_id, name, timezone, default_language, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export interface NewBusiness {
  name: string;
  timezone?: string;
  defaultLanguage?: Language;
}

export function createBusiness(input: NewBusiness): Business {
  const name = validName(input.name);
  const timezone = validTimezone(input.timezone ?? "America/Toronto");
  const language = validLanguage(input.defaultLanguage ?? "en");
  const now = Date.now();

  // Unguessable, because it appears in the client's webhook URL.
  const publicId = crypto.randomBytes(9).toString("base64url");
  const result = insertBusiness.run(publicId, name, timezone, language, now, now);
  const id = Number(result.lastInsertRowid);

  setFacts(id, unconfiguredFacts(name));
  log.info("business_created", { id, name });
  return getBusiness(id)!;
}

const timezoneStmt = db.prepare(`UPDATE businesses SET timezone = ?, updated_at = ? WHERE id = ?`);

export function setBusinessTimezone(id: BusinessId, timezone: string): void {
  timezoneStmt.run(validTimezone(timezone), Date.now(), id);
}

const statusStmt = db.prepare(`UPDATE businesses SET status = ?, updated_at = ? WHERE id = ?`);

export function setBusinessStatus(id: BusinessId, status: BusinessStatus): void {
  if (status !== "active" && status !== "inactive") throw new ValidationError("Bad status.");
  statusStmt.run(status, Date.now(), id);
}

// --- credentials ----------------------------------------------------------

/** Binds each ciphertext to its business and field; see security/crypto.ts. */
const ctx = (publicId: string, field: string) => `business:${publicId}:${field}`;

const credStmt = db.prepare(`
  UPDATE businesses SET
    wa_phone_number_id = ?, wa_business_account_id = ?,
    wa_access_token_enc = ?, wa_app_secret_enc = ?, wa_verify_token_enc = ?,
    graph_version = ?, updated_at = ?
  WHERE id = ?
`);

export interface CredentialInput {
  phoneNumberId: string;
  businessAccountId?: string | undefined;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphVersion?: string | undefined;
}

export function setWhatsappCredentials(id: BusinessId, input: CredentialInput): void {
  const business = getBusiness(id);
  if (!business) throw new ValidationError(`No business ${id}.`);

  const phoneNumberId = validMetaId("Phone number ID", input.phoneNumberId);
  const businessAccountId = input.businessAccountId
    ? validMetaId("WhatsApp Business Account ID", input.businessAccountId)
    : null;
  const graphVersion = input.graphVersion?.trim() || "v23.0";
  if (!/^v\d{1,2}\.\d$/.test(graphVersion)) throw new ValidationError("Graph version looks like v23.0.");

  // One phone number belongs to one client. Two businesses sharing a number
  // would make webhook routing ambiguous.
  const owner = getBusinessByPhoneNumberId(phoneNumberId);
  if (owner && owner.id !== id) {
    throw new ValidationError("That phone number ID is already connected to another business.");
  }

  const key = config.security.encryptionKey;
  credStmt.run(
    phoneNumberId,
    businessAccountId,
    encrypt(key, validSecret("Access token", input.accessToken, 20), ctx(business.publicId, "wa_access_token")),
    encrypt(key, validSecret("App secret", input.appSecret, 16), ctx(business.publicId, "wa_app_secret")),
    encrypt(key, validSecret("Verify token", input.verifyToken, 6), ctx(business.publicId, "wa_verify_token")),
    graphVersion,
    Date.now(),
    id,
  );
  log.info("credentials_updated", { businessId: id, phoneNumberId });
}

const secretsStmt = db.prepare(`
  SELECT public_id, wa_phone_number_id, wa_access_token_enc, wa_app_secret_enc,
         wa_verify_token_enc, graph_version
  FROM businesses WHERE id = ?
`);

/** Decrypts on demand. Returns undefined when the business is not connected. */
export function getWhatsappCredentials(id: BusinessId): WhatsappCredentials | undefined {
  const r = secretsStmt.get(id) as Record<string, unknown> | undefined;
  if (!r || !r["wa_phone_number_id"] || !r["wa_access_token_enc"] || !r["wa_app_secret_enc"]) {
    return undefined;
  }
  const key = config.security.encryptionKey;
  const publicId = String(r["public_id"]);
  return {
    phoneNumberId: String(r["wa_phone_number_id"]),
    accessToken: decrypt(key, String(r["wa_access_token_enc"]), ctx(publicId, "wa_access_token")),
    appSecret: decrypt(key, String(r["wa_app_secret_enc"]), ctx(publicId, "wa_app_secret")),
    verifyToken: r["wa_verify_token_enc"]
      ? decrypt(key, String(r["wa_verify_token_enc"]), ctx(publicId, "wa_verify_token"))
      : "",
    graphVersion: String(r["graph_version"]),
  };
}

/** For the admin panel: proof a secret is set, never the secret. */
export function credentialSummary(id: BusinessId): Record<string, string | null> | undefined {
  const creds = getWhatsappCredentials(id);
  if (!creds) return undefined;
  return {
    phoneNumberId: creds.phoneNumberId,
    accessToken: redact(creds.accessToken),
    appSecret: redact(creds.appSecret),
    verifyToken: redact(creds.verifyToken),
    graphVersion: creds.graphVersion,
  };
}

// --- facts that feed the system prompt ------------------------------------

/** What a new client's agent knows before its owner fills in settings. */
export function unconfiguredFacts(name: string): BusinessFacts {
  return {
    name,
    what: "<not configured>",
    hours: "<not configured>",
    address: "<not configured>",
    contact: "<not configured>",
    neverDo: [
      "promise a refund, discount, or delivery date",
      "quote a price that is not listed here",
    ],
  };
}

// --- opening hours --------------------------------------------------------

/** "HH:MM", 24h. */
export interface DayHours { open: string; close: string }

/** Keyed by JS weekday: "0" = Sunday ... "6" = Saturday. Absent = closed. */
export type Schedule = Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours>>;

/** What a new client gets until its owner sets real hours: Mon-Fri 9-5. */
export const DEFAULT_SCHEDULE: Schedule = {
  "1": { open: "09:00", close: "17:00" }, "2": { open: "09:00", close: "17:00" },
  "3": { open: "09:00", close: "17:00" }, "4": { open: "09:00", close: "17:00" },
  "5": { open: "09:00", close: "17:00" },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validSchedule(input: unknown): Schedule {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Schedule must be an object keyed by weekday 0-6.");
  }
  const out: Schedule = {};
  for (const [day, hours] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(day)) throw new ValidationError(`Bad weekday: ${day}`);
    if (hours == null) continue; // explicitly closed
    const h = hours as Record<string, unknown>;
    const open = String(h["open"] ?? "");
    const close = String(h["close"] ?? "");
    if (!HHMM.test(open) || !HHMM.test(close)) throw new ValidationError(`Hours for day ${day} must be HH:MM.`);
    // Lexical compare is correct for zero-padded 24h times.
    if (open >= close) throw new ValidationError(`Day ${day} closes before it opens.`);
    out[day as keyof Schedule] = { open, close };
  }
  return out;
}

// --- settings row: facts + schedule ---------------------------------------

const getSettingsStmt = db.prepare(
  `SELECT facts, schedule FROM business_settings WHERE business_id = ?`,
);
// Each upsert touches only its own column; the other is supplied solely for
// the very first insert, where the row does not exist yet.
const upsertFactsStmt = db.prepare(`
  INSERT INTO business_settings (business_id, facts, schedule, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(business_id) DO UPDATE SET facts = excluded.facts, updated_at = excluded.updated_at
`);
const upsertScheduleStmt = db.prepare(`
  INSERT INTO business_settings (business_id, facts, schedule, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(business_id) DO UPDATE SET schedule = excluded.schedule, updated_at = excluded.updated_at
`);

function settingsRow(id: BusinessId): Record<string, unknown> | undefined {
  return getSettingsStmt.get(id) as Record<string, unknown> | undefined;
}

export function getFacts(id: BusinessId): BusinessFacts {
  const row = settingsRow(id);
  if (!row) return unconfiguredFacts(getBusiness(id)?.name ?? "this business");
  return JSON.parse(String(row["facts"])) as BusinessFacts;
}

export function setFacts(id: BusinessId, facts: BusinessFacts): void {
  upsertFactsStmt.run(id, JSON.stringify(facts), JSON.stringify(DEFAULT_SCHEDULE), Date.now());
}

export function getSchedule(id: BusinessId): Schedule {
  const row = settingsRow(id);
  return row ? (JSON.parse(String(row["schedule"])) as Schedule) : DEFAULT_SCHEDULE;
}

export function setSchedule(id: BusinessId, schedule: unknown): void {
  const valid = validSchedule(schedule);
  const name = getBusiness(id)?.name ?? "this business";
  upsertScheduleStmt.run(id, JSON.stringify(unconfiguredFacts(name)), JSON.stringify(valid), Date.now());
}

export const factsConfigured = isConfigured;

// --- boot -----------------------------------------------------------------

const renameStmt = db.prepare(`UPDATE businesses SET name = ?, updated_at = ? WHERE id = ?`);

/**
 * Keeps a pre-multi-tenancy install working with no manual steps: the
 * WHATSAPP_* env vars become business #1's (encrypted) credentials, and the
 * facts that used to be hardcoded in persona.ts become its settings. Runs on
 * every boot; a no-op once the database already agrees with the env.
 */
export function seedDefaultBusiness(): void {
  const seed = config.seedWhatsapp;
  const business = getBusiness(DEFAULT_BUSINESS_ID);
  if (!business) return;

  // Seeded once, on the first boot after migration - the same moment the
  // facts are - so a timezone later changed in the admin panel is not reset.
  if (!settingsRow(DEFAULT_BUSINESS_ID)) {
    setFacts(DEFAULT_BUSINESS_ID, SEED_FACTS);
    setSchedule(DEFAULT_BUSINESS_ID, SEED_SCHEDULE);
    setBusinessTimezone(DEFAULT_BUSINESS_ID, SEED_TIMEZONE);
    if (!SEED_FACTS.name.startsWith("<")) {
      renameStmt.run(SEED_FACTS.name, Date.now(), DEFAULT_BUSINESS_ID);
    }
    log.info("default_business_facts_seeded", { name: SEED_FACTS.name });
  }

  if (seed.phoneNumberId && seed.accessToken && seed.appSecret) {
    const current = getWhatsappCredentials(DEFAULT_BUSINESS_ID);
    const unchanged =
      current?.phoneNumberId === seed.phoneNumberId &&
      current.accessToken === seed.accessToken &&
      current.appSecret === seed.appSecret &&
      current.verifyToken === seed.verifyToken;
    if (!unchanged) {
      try {
        setWhatsappCredentials(DEFAULT_BUSINESS_ID, {
          phoneNumberId: seed.phoneNumberId,
          businessAccountId: seed.businessAccountId || undefined,
          accessToken: seed.accessToken,
          appSecret: seed.appSecret,
          verifyToken: seed.verifyToken,
          graphVersion: seed.graphVersion,
        });
        log.info("default_business_credentials_seeded", { phoneNumberId: seed.phoneNumberId });
      } catch (err) {
        log.warn("default_business_seed_skipped", { err: String(err) });
      }
    }
  }
}
