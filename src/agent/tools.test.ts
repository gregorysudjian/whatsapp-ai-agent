import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, executeTool } from "./tools.ts";
import { availableSlots, createBooking, getBooking } from "../store/bookings.ts";
import { createService, deactivateService, listServices } from "../store/services.ts";
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

/** Ninja Co's first service (60 minutes), as seeded. */
const svc = () => listServices(B)[0]!;
const book = (waId: string, start: string, name = "X") =>
  createBooking(B, { waId, customerName: name, serviceId: svc().id, start, source: "agent" });

test("availability lists free future half-hour starts only", () => {
  const slots = availableSlots(B, nextWeekday(), { serviceId: svc().id });
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.ok(new Date(slot).getTime() > Date.now(), `${slot} is not in the future`);
    assert.match(slot, /T\d{2}:(00|30)$/, "on the 30-minute grid");
  }
});

test("a malformed date yields nothing rather than throwing", () => {
  assert.deepEqual(availableSlots(B, "next tuesday"), []);
});

test("booking takes a slot, and the same slot cannot be taken twice", () => {
  const slot = `${nextWeekday()}T11:00`;
  const first = book(CUSTOMER, slot, "First");
  assert.equal(first.ok, true);

  assert.deepEqual(book(OTHER, slot, "Second"), { ok: false, reason: "taken" });
  assert.deepEqual(book(OTHER, `${nextWeekday()}T11:30`, "Overlapping"), { ok: false, reason: "taken" },
    "half an hour into a 60-minute booking is still taken");
  assert.ok(!availableSlots(B, nextWeekday(), { serviceId: svc().id }).includes(slot), "a booked slot must disappear from availability");
  assert.ok(!availableSlots(B, nextWeekday(), { serviceId: svc().id }).includes(`${nextWeekday()}T10:30`),
    "a start whose hour would run into the booking is not offered either");
});

test("the past cannot be booked", () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(book(CUSTOMER, `${yesterday}T10:00`), { ok: false, reason: "past" });
});

test("outside opening hours is refused", () => {
  assert.deepEqual(book(CUSTOMER, `${nextWeekday()}T03:00`), { ok: false, reason: "closed" });
});

test("3pm is closing time, so a 60-minute service starts at 2pm at the latest", () => {
  const day = nextWeekday();
  assert.deepEqual(book(CUSTOMER, `${day}T14:30`), { ok: false, reason: "closed" }, "would run past closing");
  assert.ok(availableSlots(B, day, { serviceId: svc().id }).every((s) => s <= `${day}T14:00`));
});

test("the agent books on the half hour", () => {
  assert.deepEqual(book(CUSTOMER, `${nextWeekday()}T09:15`), { ok: false, reason: "off_grid" });
});

test("weekends are closed", () => {
  const day = nextWeekend();
  assert.deepEqual(availableSlots(B, day, { serviceId: svc().id }), []);
  assert.deepEqual(book(CUSTOMER, `${day}T10:00`), { ok: false, reason: "closed" });
});

test("a malformed slot is refused, not coerced", () => {
  assert.deepEqual(book(CUSTOMER, "tomorrow at 2"), { ok: false, reason: "malformed" });
});

test("a failed booking tells the model what to do next", () => {
  const out = executeTool("create_booking", { service_id: svc().id, start: "garbage", name: "X", notes: "" }, ctx);
  assert.match(out.content, /Booking failed/);
  assert.match(out.content, /alternative/, "the model needs a next step, not just an error");
});

test("an unknown service is refused by availability and booking alike", () => {
  assert.match(executeTool("check_availability", { date: nextWeekday(), service_id: 999999 }, ctx).content, /Unknown service_id/);
  assert.match(executeTool("create_booking", { service_id: 999999, start: `${nextWeekday()}T10:00`, name: "X", notes: "" }, ctx).content, /Unknown service_id/);
});

test("a retired service cannot be offered or booked", () => {
  const retired = createService(B, { name: "Old class", durationMin: 60, priceCents: null, currency: "USD" });
  deactivateService(B, retired.id);
  assert.deepEqual(availableSlots(B, nextWeekday(), { serviceId: retired.id }), []);
  assert.deepEqual(createBooking(B, { waId: CUSTOMER, customerName: "X", serviceId: retired.id, start: `${nextWeekday()}T10:00`, source: "agent" }),
    { ok: false, reason: "no_service" });
});

// --- a customer's own bookings -------------------------------------------------

test("the agent books, lists, moves and cancels a customer's own booking", () => {
  const me = { businessId: B, waId: "17000000020", senderName: "Maya" };
  const day = nextWeekday();
  const made = executeTool("create_booking", { service_id: svc().id, start: `${day}T08:00`, name: "Maya", notes: "two kids" }, me);
  assert.match(made.content, /^Booked\./);
  const id = Number(/booking_id (\d+)/.exec(made.content)![1]);
  assert.equal(getBooking(B, id)?.waId, me.waId, "the owner of the booking is the verified sender, never tool input");
  assert.equal(getBooking(B, id)?.notes, "two kids");

  const listed = JSON.parse(executeTool("list_my_bookings", {}, me).content) as { booking_id: number }[];
  assert.deepEqual(listed.map((b) => b.booking_id), [id]);

  const moved = executeTool("reschedule_my_booking", { booking_id: id, start: `${day}T12:30` }, me);
  assert.match(moved.content, /^Moved\./);
  assert.equal(getBooking(B, id)?.start, `${day}T12:30`);
  assert.equal(getBooking(B, id)?.end, `${day}T13:30`);

  const cancelled = executeTool("cancel_my_booking", { booking_id: id }, me);
  assert.match(cancelled.content, /^Cancelled\./);
  assert.equal(getBooking(B, id)?.status, "cancelled");
  assert.equal(executeTool("list_my_bookings", {}, me).content, "This customer has no upcoming bookings.");
  assert.ok(availableSlots(B, day, { serviceId: svc().id }).includes(`${day}T12:30`), "a cancelled booking frees its time");
});

test("a customer cannot see, cancel or move someone else's booking", () => {
  const day = nextWeekday();
  const theirs = book("17000000031", `${day}T13:00`, "Owner Of It");
  assert.ok(theirs.ok);
  const id = theirs.ok ? theirs.booking.id : 0;
  const intruder = { businessId: B, waId: "17000000032", senderName: "Intruder" };

  assert.equal(executeTool("list_my_bookings", {}, intruder).content, "This customer has no upcoming bookings.");
  const cancel = executeTool("cancel_my_booking", { booking_id: id }, intruder);
  assert.match(cancel.content, /No such booking/, "someone else's booking reads exactly like a missing one");
  const move = executeTool("reschedule_my_booking", { booking_id: id, start: `${day}T08:30` }, intruder);
  assert.match(move.content, /No such booking/);
  assert.equal(getBooking(B, id)?.status, "booked");
  assert.equal(getBooking(B, id)?.start, `${day}T13:00`);
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
