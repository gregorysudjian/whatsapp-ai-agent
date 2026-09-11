/**
 * Reminders go out once, only when due, only for businesses that asked for
 * them; the customer's Confirm / Cancel tap changes their own booking and
 * nobody else's, without the AI ever seeing it.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { MockGraph } from "../testing/mock-graph.ts";
import { buttonPayload, deliver, targetFor, textMessagePayload, type Target } from "../testing/webhook.ts";
import { setClientForTesting, type MessagesClient } from "../agent/claude.ts";
import { createBusiness, setWhatsappCredentials } from "../store/businesses.ts";
import { createService } from "../store/services.ts";
import { getSettings, setSettings } from "../store/settings.ts";
import { db, setAgentEnabled } from "../store/db.ts";
import { createBooking, getBooking, updateBooking, wallClockNow } from "../store/bookings.ts";
import { listMessages } from "../store/queries.ts";
import { runReminders } from "./reminders.ts";

const TZ = "America/Toronto";
const graph = new MockGraph();
let server: Server;
let base: string;
let R: number; // reminders on
let Q: number; // reminders off
let target: Target;
let svc: number;
let svcQ: number;
let modelCalls = 0;

const fakeModel = {
  messages: {
    stream: () => {
      modelCalls++;
      return {
        finalMessage: async () => ({
          id: "m", type: "message", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: "agent reply", citations: [] }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        }),
      };
    },
  },
} as unknown as MessagesClient;

function remindersOn(bid: number, patch: Partial<ReturnType<typeof getSettings>["reminders"]> = {}) {
  const s = getSettings(bid);
  setSettings(bid, { ...s, reminders: { ...s.reminders, enabled: true, hoursBefore: 24, templateName: "appointment_reminder", templateLanguage: "en", ...patch } });
}

before(async () => {
  R = createBusiness({ name: "Reminder Salon", timezone: TZ }).id;
  Q = createBusiness({ name: "Quiet Salon", timezone: TZ }).id;
  setWhatsappCredentials(R, {
    phoneNumberId: "666666666666601", accessToken: "reminder-r-access-token-000",
    appSecret: "reminder-r-secret-00000", verifyToken: "reminder-r-verify",
  });
  setWhatsappCredentials(Q, {
    phoneNumberId: "666666666666602", accessToken: "reminder-q-access-token-000",
    appSecret: "reminder-q-secret-00000", verifyToken: "reminder-q-verify",
  });
  svc = createService(R, { name: "Check-in", durationMin: 5, priceCents: null, currency: "CAD" }).id;
  svcQ = createService(Q, { name: "Check-in", durationMin: 5, priceCents: null, currency: "CAD" }).id;
  remindersOn(R);
  target = targetFor(R);

  await graph.listen(4599);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  setClientForTesting(fakeModel);
});

after(async () => {
  setClientForTesting(undefined);
  await graph.close();
  await new Promise((r) => server.close(r));
});

beforeEach(() => graph.reset());

let seq = 0;
/**
 * A booking `hoursAhead` from now, made `madeHoursAgo` ago (backdated in the
 * table: a reminder is skipped for a booking made inside its own window).
 */
function booking(hoursAhead: number, opts: { bid?: number; waId?: string | null; madeHoursAgo?: number; name?: string } = {}) {
  const bid = opts.bid ?? R;
  // 5-minute bookings, 7 minutes apart: whole hours are never a multiple of 7
  // minutes for the offsets used here, so no two test bookings ever overlap.
  const start = wallClockNow(TZ, Date.now() + hoursAhead * 3_600_000 + (++seq) * 7 * 60_000);
  const result = createBooking(bid, {
    waId: opts.waId === undefined ? `1666000${String(seq).padStart(4, "0")}` : opts.waId,
    customerName: opts.name ?? "Dana", serviceId: bid === R ? svc : svcQ, start, source: "owner",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const b = result.booking;
  db.prepare(`UPDATE bookings SET created_at = ? WHERE id = ?`).run(Date.now() - (opts.madeHoursAgo ?? 72) * 3_600_000, b.id);
  return getBooking(bid, b.id)!;
}

const remindedIds = () => graph.sentTemplates.map((t) => {
  const btn = t.components.find((c) => (c as { index?: string }).index === "0") as { parameters: { payload: string }[] };
  return Number(btn.parameters[0]!.payload.split(":")[1]);
});

// --- when a reminder goes out ------------------------------------------------------

test("a booking inside the reminder window is reminded; one further out is not", async () => {
  const soon = booking(3);
  const later = booking(40);
  const sent = await runReminders();
  assert.ok(sent >= 1);
  assert.ok(remindedIds().includes(soon.id));
  assert.ok(!remindedIds().includes(later.id), "40h away is outside a 24h window");
  assert.ok(getBooking(R, soon.id)!.reminderSentAt, "claimed in the database");
});

test("the template carries name, date, time and the two booking buttons", async () => {
  const b = booking(5, { name: "Dana Lee" });
  await runReminders();
  const tpl = graph.sentTemplates.find((t) => t.to === b.waId)!;
  assert.equal(tpl.name, "appointment_reminder");
  assert.equal(tpl.language, "en");
  const [body, confirm, cancel] = tpl.components as { type: string; parameters: Record<string, string>[] }[];
  assert.deepEqual(body!.parameters.map((p) => p["text"]), ["Dana Lee", body!.parameters[1]!["text"], b.start.slice(11)]);
  assert.match(body!.parameters[1]!["text"]!, /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/, "a readable date, like Tuesday, September 15");
  assert.equal(confirm!.parameters[0]!["payload"], `confirm:${b.id}`);
  assert.equal(cancel!.parameters[0]!["payload"], `cancel:${b.id}`);
  assert.equal(listMessages(R, b.waId!).at(-1)?.type, "template", "the inbox shows the reminder");
});

test("running twice - or twice at once - sends each reminder once", async () => {
  const b = booking(6);
  await Promise.all([runReminders(), runReminders()]);
  await runReminders();
  assert.equal(remindedIds().filter((id) => id === b.id).length, 1);
});

test("cancelled bookings, bookings with no number, and bookings made inside the window are skipped", async () => {
  const cancelled = booking(4);
  updateBooking(R, cancelled.id, { status: "cancelled" }, "owner");
  const noNumber = booking(4, { waId: null });
  const lastMinute = booking(4, { madeHoursAgo: 1 });
  await runReminders();
  for (const b of [cancelled, noNumber, lastMinute]) assert.ok(!remindedIds().includes(b.id), `booking ${b.id} should be skipped`);
});

test("a business with reminders off sends nothing, and the kill switch stops reminders too", async () => {
  const quiet = booking(3, { bid: Q });
  await runReminders();
  assert.ok(!graph.sentTemplates.some((t) => t.to === quiet.waId), "reminders are opt-in");

  const paused = booking(3);
  setAgentEnabled(R, false);
  try {
    await runReminders();
    assert.ok(!remindedIds().includes(paused.id), "paused means no automatic messages at all");
  } finally {
    setAgentEnabled(R, true);
  }
  await runReminders();
  assert.ok(remindedIds().includes(paused.id), "and resuming sends what is still due");
});

test("a moved booking is reminded again for its new time", async () => {
  const b = booking(3);
  await runReminders();
  assert.ok(remindedIds().includes(b.id));
  const moved = updateBooking(R, b.id, { start: wallClockNow(TZ, Date.now() + 8 * 3_600_000 + 3 * 60_000) }, "owner");
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(getBooking(R, b.id)!.reminderSentAt, null);
  graph.reset();
  await runReminders();
  assert.ok(remindedIds().includes(b.id));
});

// --- the customer's answer ---------------------------------------------------------

async function tap(from: string, payload: string, label = "Confirm") {
  const res = await deliver(base, buttonPayload(label, payload, { from, phoneNumberId: target.phoneNumberId }), target);
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 250));
}

test("Confirm confirms the customer's own booking and answers without the AI", async () => {
  const b = booking(10);
  const before = modelCalls;
  await tap(b.waId!, `confirm:${b.id}`);
  assert.equal(getBooking(R, b.id)!.status, "confirmed");
  assert.equal(modelCalls, before, "the model never sees a button tap");
  assert.equal(graph.sentTexts.length, 1);
  assert.match(graph.sentTexts[0]!, /is confirmed/);
  assert.equal(listMessages(R, b.waId!).at(-1)?.sender, "system");
});

test("Cancel cancels it; a second tap says it is already cancelled", async () => {
  const b = booking(11);
  await tap(b.waId!, `cancel:${b.id}`, "Cancel");
  assert.equal(getBooking(R, b.id)!.status, "cancelled");
  assert.match(graph.sentTexts[0]!, /is cancelled/);
  graph.reset();
  await tap(b.waId!, `confirm:${b.id}`);
  assert.equal(getBooking(R, b.id)!.status, "cancelled", "a cancelled booking is not revived by a stale button");
  assert.match(graph.sentTexts[0]!, /already cancelled/);
});

test("a button for someone else's booking - or another business's - is ignored", async () => {
  const b = booking(12);
  const before = modelCalls;
  await tap("16660009999", `cancel:${b.id}`, "Cancel");
  assert.equal(getBooking(R, b.id)!.status, "booked");
  assert.equal(graph.sentTexts.length, 0, "no reply: a forged payload learns nothing");
  assert.equal(modelCalls, before, "and it is not handed to the AI either");

  const elsewhere = booking(12, { bid: Q, waId: "16660008888" });
  await tap("16660008888", `cancel:${elsewhere.id}`, "Cancel");
  assert.equal(getBooking(Q, elsewhere.id)!.status, "booked", "a booking id from another business does nothing here");
});

test("the reply follows the reminder's language", async () => {
  remindersOn(R, { templateLanguage: "fr" });
  try {
    const b = booking(13);
    await tap(b.waId!, `confirm:${b.id}`, "Confirmer");
    assert.match(graph.sentTexts[0]!, /est confirmé/);
  } finally {
    remindersOn(R);
  }
});

test("an ordinary message still goes to the agent", async () => {
  const before = modelCalls;
  await deliver(base, textMessagePayload("hello", { from: "16660007777", phoneNumberId: target.phoneNumberId }), target);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(modelCalls, before + 1);
});

test("a reminder can be claimed exactly once, even across processes", async () => {
  const { claimReminder } = await import("../store/bookings.ts");
  const b = booking(20);
  assert.equal(claimReminder(R, b.id), true);
  assert.equal(claimReminder(R, b.id), false, "the second claimant - another process, a restart - gets nothing");
  assert.equal(claimReminder(Q, b.id), false, "and no business can claim another's booking");
});
