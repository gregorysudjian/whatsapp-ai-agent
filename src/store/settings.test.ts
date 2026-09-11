import { test } from "node:test";
import assert from "node:assert/strict";
import { createBusiness, DEFAULT_BUSINESS_ID } from "./businesses.ts";
import { defaultSettings, getSchedule, getSettings, setSchedule, setSettings } from "./settings.ts";
import { createService, deactivateService, formatPrice, getService, listServices, updateService } from "./services.ts";

// --- settings -----------------------------------------------------------------

test("a new business starts with safe defaults: reminders off, nothing claimed", () => {
  const b = createBusiness({ name: "Settings Fresh Co", defaultLanguage: "fr" });
  const s = getSettings(b.id);
  assert.equal(s.reminders.enabled, false, "reminders message customers unprompted - opt-in only");
  assert.equal(s.about, "");
  assert.deepEqual(s.languages, ["fr"]);
});

test("settings round-trip and stay per business", () => {
  const a = createBusiness({ name: "Settings A" });
  const b = createBusiness({ name: "Settings B" });
  setSettings(a.id, { ...defaultSettings("en"), about: "Only A says this" });
  assert.equal(getSettings(a.id).about, "Only A says this");
  assert.equal(getSettings(b.id).about, "", "B must not see A's settings");
});

test("invalid settings are refused with the offending field named", () => {
  const b = createBusiness({ name: "Settings Invalid" });
  const bad = (patch: Record<string, unknown>) => () => setSettings(b.id, { ...defaultSettings("en"), ...patch });
  assert.throws(bad({ languages: [] }), /languages/);
  assert.throws(bad({ languages: ["xx"] }), /languages/);
  assert.throws(bad({ tone: "sarcastic" }), /tone/);
  assert.throws(bad({ about: "x".repeat(2001) }), /about/);
  assert.throws(bad({ faqs: [{ q: "", a: "x" }] }), /faqs/);
  assert.throws(bad({ reminders: { enabled: true, hoursBefore: 24, templateName: "Bad Name!", templateLanguage: "en" } }), /templateName/);
  assert.throws(bad({ injected: "extra field" }), /./, "unknown fields are rejected, not stored");
});

test("schedules are validated and per business", () => {
  const a = createBusiness({ name: "Schedule A" });
  setSchedule(a.id, { "6": { open: "10:00", close: "14:00" } });
  assert.deepEqual(getSchedule(a.id), { "6": { open: "10:00", close: "14:00" } });
  assert.throws(() => setSchedule(a.id, { "1": { open: "18:00", close: "09:00" } }), /closes before it opens/);
  assert.throws(() => setSchedule(a.id, { "9": { open: "09:00", close: "10:00" } }), /Bad weekday/);
});

// --- the default business, seeded from the owner's answers --------------------

test("Ninja Co is seeded with the owner's languages and placeholder services", () => {
  const s = getSettings(DEFAULT_BUSINESS_ID);
  assert.deepEqual(s.languages, ["en", "fr", "ar"]);
  assert.equal(s.contact, "", "the owner chose no handoff contact");
  const names = listServices(DEFAULT_BUSINESS_ID).map((x) => `${x.name} ${formatPrice(x)}`);
  assert.ok(names.includes("Robotics class USD 25.00"));
  assert.ok(names.includes("Coding class USD 20.00"));
});

// --- services -----------------------------------------------------------------

test("services are created, edited and retired within their business only", () => {
  const a = createBusiness({ name: "Services A" });
  const b = createBusiness({ name: "Services B" });
  const svc = createService(a.id, { name: "Consultation", durationMin: 30, priceCents: 5000, currency: "cad" });
  assert.equal(svc.currency, "CAD", "currency is normalised");

  assert.equal(getService(b.id, svc.id), undefined, "another business cannot read it by id");
  assert.equal(updateService(b.id, svc.id, { name: "Hijacked", durationMin: 30, priceCents: 1, currency: "CAD" }), undefined);
  assert.equal(deactivateService(b.id, svc.id), false, "nor retire it");
  assert.equal(getService(a.id, svc.id)?.name, "Consultation");

  updateService(a.id, svc.id, { name: "Consultation (long)", durationMin: 90, priceCents: null, currency: "CAD" });
  assert.equal(formatPrice(getService(a.id, svc.id)!), null);

  assert.equal(deactivateService(a.id, svc.id), true);
  assert.equal(listServices(a.id).length, 0, "retired services leave the active list");
  assert.equal(listServices(a.id, true).length, 1, "but are kept, for bookings that reference them");
});

test("service input is validated", () => {
  const a = createBusiness({ name: "Services Invalid" });
  assert.throws(() => createService(a.id, { name: "", durationMin: 30, priceCents: null, currency: "CAD" }), /name/);
  assert.throws(() => createService(a.id, { name: "X", durationMin: 0, priceCents: null, currency: "CAD" }), /durationMin/);
  assert.throws(() => createService(a.id, { name: "X", durationMin: 30, priceCents: -1, currency: "CAD" }), /priceCents/);
  assert.throws(() => createService(a.id, { name: "X", durationMin: 30, priceCents: null, currency: "DOLLARS" }), /currency/);
});
