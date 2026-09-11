/**
 * Clients of the platform, and the WhatsApp credentials each one brings.
 *
 * Credentials are encrypted on write and decrypted only at the moment of use.
 * Nothing in here returns a secret to a caller that asked for a Business -
 * `Business` has no secret fields at all, so a route cannot leak one by
 * serialising the wrong object.
 */

import crypto from "node:crypto";
import { db, readFlag, writeFlag, type BusinessId } from "./db.ts";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { decrypt, encrypt, redact } from "../security/crypto.ts";
import {
  SEED_NAME, SEED_SCHEDULE, SEED_SERVICES, SEED_SETTINGS, SEED_TIMEZONE,
} from "../agent/persona.ts";
import { ValidationError } from "./errors.ts";
import { getSettings, hasSettings, initSettings, setSettings } from "./settings.ts";
import { createService, listServices } from "./services.ts";

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

// Re-exported so existing imports keep working; the class lives in errors.ts
// to keep settings.ts and this module from importing each other.
export { ValidationError };
export {
  DEFAULT_SCHEDULE, getSchedule, setSchedule, validSchedule, type DayHours, type Schedule,
} from "./settings.ts";

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

  initSettings(id, language);
  log.info("business_created", { id, name });
  return getBusiness(id)!;
}

const timezoneStmt = db.prepare(`UPDATE businesses SET timezone = ?, updated_at = ? WHERE id = ?`);

export function setBusinessTimezone(id: BusinessId, timezone: string): void {
  timezoneStmt.run(validTimezone(timezone), Date.now(), id);
}

const profileStmt = db.prepare(
  `UPDATE businesses SET name = ?, timezone = ?, default_language = ?, updated_at = ? WHERE id = ?`,
);

/** What an owner may change about their own business on the settings page. */
export function updateBusinessProfile(
  id: BusinessId,
  input: { name: string; timezone: string; defaultLanguage: string },
): Business {
  profileStmt.run(validName(input.name), validTimezone(input.timezone), validLanguage(input.defaultLanguage), Date.now(), id);
  return getBusiness(id)!;
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

// --- boot -----------------------------------------------------------------

const renameStmt = db.prepare(`UPDATE businesses SET name = ?, updated_at = ? WHERE id = ?`);

/** Marks the one-time application of the owner's answers (2026-09-11). */
const SEED_FLAG = "seed_v2_applied";

/**
 * Keeps a pre-multi-tenancy install working with no manual steps, and seeds
 * the default business once. Runs on every boot; each part is a no-op once
 * done, and nothing here ever overwrites what an owner later saved:
 *
 *   - first boot: settings row, Ninja Co's hours, timezone and name;
 *   - once (flagged): the owner's answers - languages, contact, placeholder
 *     services - merged over whatever settings exist (migrated or default);
 *   - every boot: WHATSAPP_* env vars become business #1's encrypted
 *     credentials when they differ from what is stored.
 */
export function seedDefaultBusiness(): void {
  const seed = config.seedWhatsapp;
  const business = getBusiness(DEFAULT_BUSINESS_ID);
  if (!business) return;

  if (!hasSettings(DEFAULT_BUSINESS_ID)) {
    initSettings(DEFAULT_BUSINESS_ID, business.defaultLanguage, SEED_SCHEDULE);
    setBusinessTimezone(DEFAULT_BUSINESS_ID, SEED_TIMEZONE);
    if (business.name === "Default business") renameStmt.run(SEED_NAME, Date.now(), DEFAULT_BUSINESS_ID);
    log.info("default_business_initialised", { name: SEED_NAME });
  }

  if (!readFlag(DEFAULT_BUSINESS_ID, SEED_FLAG)) {
    setSettings(DEFAULT_BUSINESS_ID, { ...getSettings(DEFAULT_BUSINESS_ID), ...SEED_SETTINGS });
    if (listServices(DEFAULT_BUSINESS_ID, true).length === 0) {
      for (const svc of SEED_SERVICES) createService(DEFAULT_BUSINESS_ID, svc);
    }
    writeFlag(DEFAULT_BUSINESS_ID, SEED_FLAG, String(Date.now()));
    log.info("default_business_seeded", { languages: SEED_SETTINGS.languages, services: SEED_SERVICES.length });
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
