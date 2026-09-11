import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, executeTool } from "./tools.ts";
import { availableSlots, createBooking } from "../store/bookings.ts";
import { recordInbound, isPaused, clearHandoff } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";
import { DEFAULT_BUSINESS_ID as B } from "../store/businesses.ts";

const CUSTOMER = "17000000001";
const OTHER = "17000000002";
const ctx = { businessId: B, waId: CUSTOMER, senderName: "Test" };

/**
 * The first open (or closed) day after today, so slots are always in the
 * future and a Friday run doesn't land on a Saturday. Local date on purpose:
 * slots are parsed as local time, so a UTC date can be off by one day.
 */
function nextDay(open: boolean): string {
  const d = new Date(Date.now() + 86_400_000);
  const isWeekend = () => d.getDay() === 0 || d.getDay() === 6;
  while (isWeekend() === open) d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const nextWeekday = () => nextDay(true);
const nextWeekend = () => nextDay(false);

// --- schemas --------------------------------------------------------------

test("every tool is strict with a closed schema", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.strict, true, `${tool.name} must be strict`);
    assert.equal(
      (tool.input_schema as { additionalProperties?: boolean }).additionalProperties, false,
      `${tool.name} must close its schema`,
    );
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
  }
});

// --- orders are out of scope ------------------------------------------------

test("order lookup is not offered to the model", () => {
  // Removed by decision: with no order data source, the tool could only ever
  // answer "no order found" - telling customers their real orders don't exist.
  assert.ok(!TOOLS.some((t) => t.name === "lookup_order"));
});

// --- availability and booking ---------------------------------------------

test("availability lists free future slots only", () => {
  const slots = availableSlots(B, nextWeekday());
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.ok(new Date(slot).getTime() > Date.now(), `${slot} is not in the future`);
  }
});

test("a malformed date yields nothing rather than throwing", () => {
  assert.deepEqual(availableSlots(B, "next tuesday"), []);
});

test("booking takes a slot, and the same slot cannot be taken twice", () => {
  const slot = `${nextWeekday()}T11:00`;
  const first = createBooking(B, CUSTOMER, "First", slot, 2);
  assert.equal(first.ok, true);

  const second = createBooking(B, OTHER, "Second", slot, 2);
  assert.deepEqual(second, { ok: false, reason: "taken" });

  assert.ok(!availableSlots(B, nextWeekday()).includes(slot), "a booked slot must disappear from availability");
});

test("the past cannot be booked", () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(createBooking(B, CUSTOMER, "X", `${yesterday}T10:00`, 1), { ok: false, reason: "past" });
});

test("outside opening hours is refused", () => {
  assert.deepEqual(createBooking(B, CUSTOMER, "X", `${nextWeekday()}T03:00`, 1), { ok: false, reason: "closed" });
});

test("3pm is closing time, so the last slot starts at 2pm", () => {
  const day = nextWeekday();
  assert.deepEqual(createBooking(B, CUSTOMER, "X", `${day}T15:00`, 1), { ok: false, reason: "closed" });
  assert.ok(availableSlots(B, day).every((s) => s < `${day}T15:00`));
});

test("weekends are closed", () => {
  const day = nextWeekend();
  assert.deepEqual(availableSlots(B, day), []);
  assert.deepEqual(createBooking(B, CUSTOMER, "X", `${day}T10:00`, 1), { ok: false, reason: "closed" });
});

test("a malformed slot is refused, not coerced", () => {
  assert.deepEqual(createBooking(B, CUSTOMER, "X", "tomorrow at 2", 1), { ok: false, reason: "malformed" });
});

test("a failed booking tells the model what to do next", () => {
  const out = executeTool("create_booking", { slot: "garbage", name: "X", party_size: 1 }, ctx);
  assert.match(out.content, /Booking failed/);
  assert.match(out.content, /alternative/, "the model needs a next step, not just an error");
});

// --- escalation -----------------------------------------------------------

test("escalating pauses the conversation and signals the caller", () => {
  const wa = "17000000009";
  const msg: InboundMessage = {
    id: "tool-seed-1", from: wa, senderName: "T", timestamp: new Date(), text: "get me a human",
    raw: { id: "tool-seed-1", from: wa, timestamp: "0", type: "text", text: { body: "get me a human" } },
  };
  recordInbound(B, msg);

  const out = executeTool("escalate_to_human", { reason: "customer asked" }, { businessId: B, waId: wa, senderName: "T" });

  assert.equal(out.handoff, true, "the caller must know to stop replying");
  assert.equal(isPaused(B, wa), true);
  clearHandoff(B, wa);
});

// --- unknown tools --------------------------------------------------------

test("an invented tool name is reported, not thrown", () => {
  const out = executeTool("refund_everything", {}, ctx);
  assert.match(out.content, /Unknown tool/);
});

test("business info is honest when the persona is unconfigured", () => {
  const out = executeTool("get_business_info", {}, ctx);
  // persona.ts ships with placeholders, so this is the shipped behaviour.
  assert.match(out.content, /not been configured|hours/);
});
