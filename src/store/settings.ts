/**
 * What each business's agent knows and how it behaves - one row per business
 * in business_settings, holding two JSON documents:
 *
 *   settings - facts, tone, languages, FAQs, handoff rules, reminders. Edited
 *              on the dashboard's settings page; fed into the system prompt.
 *   schedule - opening hours per weekday. Structured, because bookings must
 *              check it; the prompt's hours sentence is generated FROM it, so
 *              the two can never disagree.
 *
 * Validated with zod on the way in, so the prompt builder can trust every
 * field it reads.
 */

import { z } from "zod";
import { db, type BusinessId } from "./db.ts";
import { ValidationError } from "./errors.ts";

// --- settings ---------------------------------------------------------------

export const TONES = ["friendly", "professional", "concise"] as const;

/** Language codes the agent may reply in (ISO 639-1), with their names. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", fr: "French", ar: "Arabic", es: "Spanish", pt: "Portuguese", de: "German",
  it: "Italian", zh: "Chinese", hi: "Hindi", tr: "Turkish", ru: "Russian", fa: "Persian",
  ur: "Urdu", tl: "Tagalog", vi: "Vietnamese", ko: "Korean", ja: "Japanese", nl: "Dutch",
  pl: "Polish", ro: "Romanian", uk: "Ukrainian", el: "Greek", he: "Hebrew", sw: "Swahili",
};

const text = (max: number) => z.string().trim().max(max);

export const SettingsSchema = z.object({
  about: text(2000),
  address: text(300),
  /** Given to customers on handoff. Empty: "someone will follow up in this chat". */
  contact: text(200),
  tone: z.enum(TONES),
  customToneNotes: text(1000),
  languages: z.array(z.enum(Object.keys(LANGUAGE_NAMES) as [string, ...string[]])).min(1).max(10),
  faqs: z.array(z.object({ q: text(300).min(1), a: text(1500).min(1) }).strict()).max(50),
  handoff: z.object({
    keywords: z.array(text(60).min(1)).max(30),
    onAnger: z.boolean(),
    onAccountChange: z.boolean(),
    rules: text(1000),
  }).strict(),
  neverDo: z.array(text(200).min(1)).max(20),
  reminders: z.object({
    enabled: z.boolean(),
    hoursBefore: z.number().int().min(1).max(168),
    templateName: z.string().regex(/^[a-z0-9_]{1,100}$/, "lowercase letters, digits and _ only"),
    templateLanguage: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/, "like en, fr or en_US"),
  }).strict(),
}).strict();

export type AgentSettings = z.infer<typeof SettingsSchema>;

export function defaultSettings(language: string): AgentSettings {
  return {
    about: "",
    address: "",
    contact: "",
    tone: "friendly",
    customToneNotes: "",
    languages: [LANGUAGE_NAMES[language] ? language : "en"],
    faqs: [],
    handoff: { keywords: [], onAnger: true, onAccountChange: true, rules: "" },
    neverDo: [
      "promise a refund, discount, or delivery date",
      "quote a price that is not listed in the services",
    ],
    // Off by default: reminders message customers without them writing
    // first, so a business opts in deliberately (and after Meta approves
    // the template).
    reminders: { enabled: false, hoursBefore: 24, templateName: "appointment_reminder", templateLanguage: "en" },
  };
}

/** True once an owner has told the agent what the business actually does. */
export function isConfigured(settings: AgentSettings): boolean {
  return settings.about.trim().length > 0;
}

// --- opening hours ----------------------------------------------------------

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

// --- the row ----------------------------------------------------------------

const getStmt = db.prepare(`SELECT facts, schedule FROM business_settings WHERE business_id = ?`);
const insertStmt = db.prepare(`
  INSERT INTO business_settings (business_id, facts, schedule, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(business_id) DO NOTHING
`);
const setSettingsStmt = db.prepare(`UPDATE business_settings SET facts = ?, updated_at = ? WHERE business_id = ?`);
const setScheduleStmt = db.prepare(`UPDATE business_settings SET schedule = ?, updated_at = ? WHERE business_id = ?`);

function row(bid: BusinessId): { facts: string; schedule: string } | undefined {
  return getStmt.get(bid) as { facts: string; schedule: string } | undefined;
}

export function hasSettings(bid: BusinessId): boolean {
  return row(bid) !== undefined;
}

/** Creates the row with defaults; a no-op when one already exists. */
export function initSettings(bid: BusinessId, language: string, schedule: Schedule = DEFAULT_SCHEDULE): void {
  insertStmt.run(bid, JSON.stringify(defaultSettings(language)), JSON.stringify(schedule), Date.now());
}

export function getSettings(bid: BusinessId): AgentSettings {
  const r = row(bid);
  if (!r) return defaultSettings("en");
  // Parsed through the schema, filling any field a stored document lacks:
  // settings written before a field existed still load.
  const merged = { ...defaultSettings("en"), ...(JSON.parse(r.facts) as Partial<AgentSettings>) };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...defaultSettings("en"), ...merged } as AgentSettings;
}

export function setSettings(bid: BusinessId, input: unknown): AgentSettings {
  const parsed = SettingsSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`${first?.path.join(".") || "settings"}: ${first?.message ?? "invalid"}`);
  }
  if (!row(bid)) initSettings(bid, parsed.data.languages[0] ?? "en");
  setSettingsStmt.run(JSON.stringify(parsed.data), Date.now(), bid);
  return parsed.data;
}

export function getSchedule(bid: BusinessId): Schedule {
  const r = row(bid);
  return r ? (JSON.parse(r.schedule) as Schedule) : DEFAULT_SCHEDULE;
}

export function setSchedule(bid: BusinessId, schedule: unknown): Schedule {
  const valid = validSchedule(schedule);
  if (!row(bid)) initSettings(bid, "en", valid);
  setScheduleStmt.run(JSON.stringify(valid), Date.now(), bid);
  return valid;
}
