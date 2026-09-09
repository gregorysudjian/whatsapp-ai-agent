import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, executeTool } from "./tools.ts";
import { availableSlots, createBooking, lookupOrder, seedOrder } from "../store/business.ts";
import { recordInbound, isPaused, clearHandoff } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";

const CUSTOMER = "17000000001";
const OTHER = "17000000002";
const ctx = { waId: CUSTOMER, senderName: "Test" };

/** Tomorrow, so slots are always in the future regardless of when this runs. */
function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

// Ids unique to this file: the suite shares one database, and a fixture id
// reused elsewhere makes tests depend on which file ran first.
const ORDER = seedOrder("T1001", CUSTOMER, "shipped", "Blue widget x2");
const MISSING = "T9999";

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

// --- orders ---------------------------------------------------------------

test("an order belonging to the caller is returned", () => {
  const found = lookupOrder(ORDER, CUSTOMER);
  assert.notEqual(found, "not_found");
  assert.notEqual(found, "wrong_phone");
  assert.equal(typeof found === "object" ? found.status : "", "shipped");
});

test("order ids are case and whitespace tolerant", () => {
  assert.notEqual(lookupOrder(`  ${ORDER.toLowerCase()} `, CUSTOMER), "not_found");
});

test("someone else's order is not readable", () => {
  assert.equal(lookupOrder(ORDER, OTHER), "wrong_phone");
});

test("the tool does not reveal that another customer's order exists", () => {
  const stranger = { waId: OTHER, senderName: undefined };
  const real = executeTool("lookup_order", { order_id: ORDER }, stranger);
  const fake = executeTool("lookup_order", { order_id: MISSING }, stranger);

  // Both echo the id they were asked about, so compare the shape with the id
  // removed: what must not differ is anything that confirms the id is real.
  const shape = (s: string) => s.replace(/T\d{4}/, "<id>");
  assert.equal(
    shape(real.content), shape(fake.content),
    "a wrong-owner answer must look identical to not-found, or it confirms the id",
  );
  assert.doesNotMatch(real.content, /shipped|widget|processing/, "no order details may leak");
});

// --- availability and booking ---------------------------------------------

test("availability lists free future slots only", () => {
  const slots = availableSlots(tomorrow());
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    assert.ok(new Date(slot).getTime() > Date.now(), `${slot} is not in the future`);
  }
});

test("a malformed date yields nothing rather than throwing", () => {
  assert.deepEqual(availableSlots("next tuesday"), []);
});

test("booking takes a slot, and the same slot cannot be taken twice", () => {
  const slot = `${tomorrow()}T11:00`;
  const first = createBooking(CUSTOMER, "First", slot, 2);
  assert.equal(first.ok, true);

  const second = createBooking(OTHER, "Second", slot, 2);
  assert.deepEqual(second, { ok: false, reason: "taken" });

  assert.ok(!availableSlots(tomorrow()).includes(slot), "a booked slot must disappear from availability");
});

test("the past cannot be booked", () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(createBooking(CUSTOMER, "X", `${yesterday}T10:00`, 1), { ok: false, reason: "past" });
});

test("outside opening hours is refused", () => {
  assert.deepEqual(createBooking(CUSTOMER, "X", `${tomorrow()}T03:00`, 1), { ok: false, reason: "closed" });
});

test("a malformed slot is refused, not coerced", () => {
  assert.deepEqual(createBooking(CUSTOMER, "X", "tomorrow at 2", 1), { ok: false, reason: "malformed" });
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
  recordInbound(msg);

  const out = executeTool("escalate_to_human", { reason: "customer asked" }, { waId: wa, senderName: "T" });

  assert.equal(out.handoff, true, "the caller must know to stop replying");
  assert.equal(isPaused(wa), true);
  clearHandoff(wa);
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
