import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextBlock, buildSystemPrompt, describeHours, type PromptInput } from "./prompt.ts";
import { defaultSettings } from "../store/settings.ts";
import type { Service } from "../store/services.ts";

const svc = (id: number, name: string, priceCents: number | null): Service => ({
  id, businessId: 1, name, description: "", durationMin: 60, priceCents, currency: "USD", active: true, sort: id,
});

function input(over: Partial<PromptInput> = {}): PromptInput {
  return {
    businessName: "Ninja Co",
    timezone: "Asia/Beirut",
    settings: { ...defaultSettings("en"), about: "Robotics and coding tutoring", address: "Beirut, Lebanon", languages: ["en", "fr", "ar"] },
    schedule: {
      "1": { open: "08:00", close: "15:00" }, "2": { open: "08:00", close: "15:00" },
      "3": { open: "08:00", close: "15:00" }, "4": { open: "08:00", close: "15:00" },
      "5": { open: "08:00", close: "15:00" },
    },
    services: [svc(1, "Robotics class", 2500), svc(2, "Coding class", null)],
    ...over,
  };
}

// --- hours --------------------------------------------------------------------

test("consecutive days with the same hours collapse into one line", () => {
  assert.deepEqual(describeHours(input().schedule), ["Monday to Friday: 08:00-15:00", "Saturday and Sunday: closed"]);
});

test("a gap in the week splits the run", () => {
  assert.deepEqual(
    describeHours({ "1": { open: "09:00", close: "17:00" }, "3": { open: "09:00", close: "17:00" } }),
    ["Monday: 09:00-17:00", "Tuesday: closed", "Wednesday: 09:00-17:00", "Thursday to Sunday: closed"],
  );
});

test("a fully closed week says so rather than listing nothing", () => {
  assert.deepEqual(describeHours({}), ["Monday to Sunday: closed"]);
});

// --- the prompt ---------------------------------------------------------------

test("the prompt is byte-stable - it is the cached prefix of every request", () => {
  const a = buildSystemPrompt(input());
  const b = buildSystemPrompt(input());
  assert.equal(a, b);
  // No clock may leak in: the current hour and date must not appear.
  const now = new Date();
  assert.ok(!a.includes(String(now.getFullYear())), "a date in the cached prefix would break caching daily");
});

test("the hours sentence comes from the schedule, so the two cannot disagree", () => {
  const p = buildSystemPrompt(input());
  assert.match(p, /- Monday to Friday: 08:00-15:00/);
  assert.match(p, /- Saturday and Sunday: closed/);
});

test("services carry their duration and price; an unpriced one says so", () => {
  const p = buildSystemPrompt(input());
  assert.match(p, /Robotics class \(service_id 1\): 60 min, USD 25\.00/);
  assert.match(p, /Coding class \(service_id 2\): 60 min, price not set/);
});

test("with no services, the agent is told not to offer or book anything", () => {
  assert.match(buildSystemPrompt(input({ services: [] })), /Do not offer or book anything/);
});

test("the languages the owner chose are named, with a default", () => {
  const p = buildSystemPrompt(input());
  assert.match(p, /one of: Arabic, English, French\. Otherwise reply in English\./);
});

test("an empty field is described as unknown, never left as a blank the model fills in", () => {
  const p = buildSystemPrompt(input({ settings: { ...defaultSettings("en") } }));
  assert.match(p, /has not described the business yet/);
  assert.match(p, /Address: not provided\. Do not guess/);
});

test("handoff wording follows the contact setting", () => {
  assert.match(buildSystemPrompt(input()), /follow up here in this chat/);
  const withContact = input();
  withContact.settings = { ...withContact.settings, contact: "+961 1 234 567" };
  assert.match(buildSystemPrompt(withContact), /reach the team at \+961 1 234 567/);
});

test("handoff rules are included only when switched on", () => {
  const s = { ...defaultSettings("en"), about: "x", handoff: { keywords: ["refund", "lawyer"], onAnger: false, onAccountChange: false, rules: "anything medical" } };
  const p = buildSystemPrompt(input({ settings: s }));
  assert.doesNotMatch(p, /upset or angry/);
  assert.match(p, /mentions any of: refund, lawyer/);
  assert.match(p, /- anything medical/);
});

test("FAQs appear as question and answer pairs", () => {
  const s = { ...input().settings, faqs: [{ q: "Do you teach adults?", a: "Yes, from age 8 up." }] };
  const p = buildSystemPrompt(input({ settings: s }));
  assert.match(p, /Q: Do you teach adults\?\nA: Yes, from age 8 up\./);
});

test("'never' rules read naturally even if the owner typed 'never' themselves", () => {
  const s = { ...input().settings, neverDo: ["Never promise a refund", "quote prices for unlisted services"] };
  const p = buildSystemPrompt(input({ settings: s }));
  assert.match(p, /- Never promise a refund\./);
  assert.match(p, /- Never quote prices for unlisted services\./);
  assert.doesNotMatch(p, /Never Never/);
});

// --- the clock ----------------------------------------------------------------

test("the context block tells the agent the business's local date and time", () => {
  // 2026-09-11 00:30 UTC is 03:30 on Friday in Beirut (UTC+3).
  const block = buildContextBlock("Asia/Beirut", Date.UTC(2026, 8, 11, 0, 30));
  assert.match(block, /Friday, 11 September 2026/);
  assert.match(block, /03:30/);
  assert.match(block, /Asia\/Beirut/);
});
