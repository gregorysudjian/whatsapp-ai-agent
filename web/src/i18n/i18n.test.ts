/**
 * Every string the dashboard shows exists in both languages, is not empty,
 * and keeps its {placeholders}. The type system already refuses a missing
 * French key; this catches what types cannot - blanks, dropped variables,
 * and English pasted in as "French".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { en, type Key } from "./en.ts";
import { fr } from "./fr.ts";

const keys = Object.keys(en) as Key[];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Words that are genuinely the same in both languages. */
// "Inactive" is correct French too (feminine, agreeing with « entreprise »).
const SAME_IN_BOTH = new Set<Key>(["nav.contacts", "nav.menu", "nav.clients", "shell.inactive",
  "settings.minutes", "settings.question", "inbox.hours", "inbox.minutes",
  "bookings.date", "bookings.notes", "bookings.notifyMessage", "contacts.count",
  "admin.col.client", "admin.col.whatsapp", "admin.total", "admin.action"]);

test("French has exactly the English keys", () => {
  assert.deepEqual(Object.keys(fr).sort(), [...keys].sort());
});

test("no string is empty or only whitespace", () => {
  for (const k of keys) {
    assert.ok(en[k].trim(), `en ${k} is empty`);
    assert.ok(fr[k].trim(), `fr ${k} is empty`);
  }
});

test("placeholders survive translation", () => {
  for (const k of keys) {
    assert.deepEqual(placeholders(fr[k]), placeholders(en[k]), `${k}: ${en[k]}  vs  ${fr[k]}`);
  }
});

test("French is actually French, not English pasted in", () => {
  const same = keys.filter((k) => fr[k] === en[k] && !SAME_IN_BOTH.has(k));
  assert.deepEqual(same, [], "identical to English - translate, or add to SAME_IN_BOTH if genuinely the same");
});
