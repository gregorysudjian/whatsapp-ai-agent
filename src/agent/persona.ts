/**
 * Seed data for the default business (#1, Ninja Co), applied once on first
 * boot - never read at runtime after that. Owners edit everything here on
 * the dashboard's settings page; the prompt is built in prompt.ts from what
 * they save.
 *
 * Prices are PLACEHOLDERS: the owner said "put anything now, I'll change them
 * later" (2026-09-11). MORNING.md flags them, because the agent quotes prices
 * to real customers.
 */

import type { AgentSettings, Schedule } from "../store/settings.ts";

export const SEED_NAME = "Ninja Co";

/** Where the business is. Bookings and "is this slot in the past" use it. */
export const SEED_TIMEZONE = "Asia/Beirut";

/** JS weekdays: 0 = Sunday ... 6 = Saturday. Absent = closed. */
export const SEED_SCHEDULE: Schedule = {
  "1": { open: "08:00", close: "15:00" },
  "2": { open: "08:00", close: "15:00" },
  "3": { open: "08:00", close: "15:00" },
  "4": { open: "08:00", close: "15:00" },
  "5": { open: "08:00", close: "15:00" },
};

/** Merged over the defaults (or the migrated v1 settings) exactly once. */
export const SEED_SETTINGS: Partial<AgentSettings> = {
  about: "Robotics and coding tutoring",
  address: "Beirut, Lebanon",
  contact: "", // owner's answer: none; the agent says someone follows up in the chat
  languages: ["en", "fr", "ar"], // owner's answer
};

export const SEED_SERVICES = [
  { name: "Robotics class", description: "", durationMin: 60, priceCents: 2500, currency: "USD", sort: 0 },
  { name: "Coding class", description: "", durationMin: 60, priceCents: 2000, currency: "USD", sort: 1 },
];
