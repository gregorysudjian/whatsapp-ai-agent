/**
 * Realistic demo traffic for screenshots and manual testing - only ever run
 * against a throwaway database (the shots runner enforces that).
 */

import type { BusinessId } from "../store/db.ts";
import { recordInbound, recordOutbound, recordStatus, recordUsage, pauseForHuman, takeOver } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";
import { db } from "../store/db.ts";
import { getBusiness } from "../store/businesses.ts";
import { listServices } from "../store/services.ts";
import { wallClockNow } from "../store/bookings.ts";

let n = 0;
function inbound(bid: BusinessId, from: string, name: string, text: string, minutesAgo: number): void {
  const id = `demo-in-${bid}-${++n}`;
  const msg: InboundMessage = {
    id, from, senderName: name, timestamp: new Date(Date.now() - minutesAgo * 60_000), text,
    raw: { id, from, timestamp: "0", type: "text", text: { body: text } },
  };
  recordInbound(bid, msg);
}

const setTs = db.prepare(`UPDATE messages SET ts = ? WHERE id = ?`);

/** `minutesAgo` backdates the reply to just after the question it answers. */
function outbound(bid: BusinessId, to: string, text: string, opts: { staff?: number; status?: string; minutesAgo?: number } = {}): void {
  const id = `demo-out-${bid}-${++n}`;
  recordOutbound(bid, id, to, text, opts.staff ? "human" : "ai", opts.staff ?? null);
  if (opts.minutesAgo !== undefined) setTs.run(Date.now() - opts.minutesAgo * 60_000, id);
  if (!opts.staff) recordUsage(bid, id, { inputTokens: 1800, outputTokens: 70, cacheReadTokens: 1500, latencyMs: 2400 });
  if (opts.status) {
    recordStatus(bid, { id, status: opts.status, timestamp: "0", recipient_id: to } as Parameters<typeof recordStatus>[1]);
  }
}

const insertBooking = db.prepare(`
  INSERT INTO bookings (business_id, wa_id, customer_name, service_id, start_at, end_at, duration_min, status, source, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const addDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * A week of bookings around today, in every status. Written directly (the
 * demo needs past ones, which the store rightly refuses to create) and laid
 * out so none overlap.
 */
function seedBookings(bid: BusinessId): void {
  const tz = getBusiness(bid)?.timezone ?? "UTC";
  const today = wallClockNow(tz).slice(0, 10);
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  /** The n-th working day before (n < 0) or after (n > 0) today; 0 is today. */
  const workday = (n: number) => {
    let d = today;
    for (let left = Math.abs(n); left > 0;) {
      d = addDay(d, Math.sign(n));
      if (weekday(d) !== 0 && weekday(d) !== 6) left--;
    }
    return d;
  };
  const [robotics, coding] = listServices(bid);
  if (!robotics || !coding) return;
  const rows: [number, string, string | null, string, typeof robotics, string, "agent" | "owner", string][] = [
    [-3, "09:00", "96170111222", "Rami Haddad", robotics, "completed", "agent", ""],
    [-3, "11:00", "33612345678", "Sophie Martin", coding, "completed", "agent", ""],
    [-2, "10:00", "96171555666", "Layla Nassar", coding, "no_show", "agent", ""],
    [-2, "13:30", null, "Karim (phoned)", robotics, "completed", "owner", "Paid cash"],
    [-1, "08:30", "96178333444", "Nour Khalil", robotics, "completed", "agent", "Two kids"],
    [0, "13:00", "33698765432", "Julien Roy", coding, "confirmed", "agent", ""],
    [1, "10:00", "96170111222", "Rami Haddad", robotics, "booked", "agent", ""],
    [1, "14:00", "15145550199", "Marc Tremblay", coding, "cancelled", "agent", ""],
    [2, "09:30", "33612345678", "Sophie Martin", coding, "confirmed", "agent", ""],
    [2, "11:00", null, "Hadi's school trip", robotics, "booked", "owner", "Group of 6"],
    [3, "08:00", "96178333444", "Nour Khalil", robotics, "booked", "agent", ""],
    [4, "10:00", "96171555666", "Layla Nassar", coding, "booked", "agent", ""],
  ];
  const now = Date.now();
  for (const [offset, time, waId, name, svc, status, source, notes] of rows) {
    const start = `${workday(offset)}T${time}`;
    const endMin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + svc.durationMin;
    const end = `${start.slice(0, 11)}${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
    // Made a few days before the appointment (never in the future), not all "just now".
    const made = Math.min(now - 3_600_000, Date.parse(`${start}:00Z`) - 3 * 86_400_000);
    insertBooking.run(bid, waId, name, svc.id, start, end, svc.durationMin, status, source, notes, made, made);
  }
}

const insertHistoryMessage = db.prepare(`
  INSERT INTO messages (id, business_id, wa_id, direction, type, text, sender_name, ts, status, sender)
  VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?)
`);
const insertHistoryContact = db.prepare(`
  INSERT OR IGNORE INTO contacts (business_id, wa_id, name, first_seen, last_inbound_ts, last_message_ts, inbound_count, outbound_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertEvent = db.prepare(`INSERT INTO events (business_id, ts, level, name) VALUES (?, ?, 'info', ?)`);

/**
 * A month of believable past traffic, so the Overview has something to
 * draw: a few conversations a day, mostly answered by the agent within a
 * minute or two, some by a person, a handful of bookings. Deterministic (a
 * fixed-seed generator), so screenshots are comparable run to run.
 */
function seedHistory(bid: BusinessId): void {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const names = ["Ali", "Maya", "Georges", "Rita", "Omar", "Chloé", "Karim", "Lina", "Tony", "Hiba", "Paul", "Zeina"];
  const tz = getBusiness(bid)?.timezone ?? "UTC";
  const now = Date.now();
  let k = 0;
  for (let daysAgo = 34; daysAgo >= 1; daysAgo--) {
    const weekend = [0, 6].includes(new Date(now - daysAgo * 86_400_000).getUTCDay());
    const convos = Math.round((weekend ? 1 : 3) + rnd() * (weekend ? 2 : 5) + (34 - daysAgo) / 12);
    for (let c = 0; c < convos; c++) {
      const wa = `9617${String(100000 + ++k).padStart(6, "0")}`;
      const name = names[Math.floor(rnd() * names.length)]!;
      let t = now - daysAgo * 86_400_000 + Math.floor(rnd() * 10 * 3_600_000) - 5 * 3_600_000;
      const turns = 1 + Math.floor(rnd() * 3);
      let inCount = 0, outCount = 0;
      const byPerson = rnd() < 0.12;
      for (let turn = 0; turn < turns; turn++) {
        insertHistoryMessage.run(`demo-h-${bid}-${k}-${turn}-in`, bid, wa, "in", "…", name, t, null, "customer");
        inCount++;
        if (turn === turns - 1 && rnd() < 0.05) break; // left unanswered
        const human = byPerson && turn > 0;
        t += human ? 3 * 60_000 + Math.floor(rnd() * 35 * 60_000) : 15_000 + Math.floor(rnd() * (rnd() < 0.85 ? 90_000 : 600_000));
        insertHistoryMessage.run(`demo-h-${bid}-${k}-${turn}-out`, bid, wa, "out", "…", null, t, "read", human ? "human" : "ai");
        outCount++;
        t += 2 * 60_000 + Math.floor(rnd() * 20 * 60_000);
      }
      if (byPerson) {
        insertEvent.run(bid, t - 60_000, "handoff_requested");
        insertEvent.run(bid, t, "taken_over");
      }
      insertHistoryContact.run(bid, wa, name, t - 60 * 60_000, t, t, inCount, outCount);
      if (rnd() < 0.3) {
        const [svc] = listServices(bid);
        if (svc) {
          const day = wallClockNow(tz, t + 2 * 86_400_000).slice(0, 10);
          const hour = 8 + Math.floor(rnd() * 6);
          const start = `${day}T${String(hour).padStart(2, "0")}:${rnd() < 0.5 ? "00" : "30"}`;
          const endMin = hour * 60 + (start.endsWith("30") ? 30 : 0) + svc.durationMin;
          const end = `${day}T${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
          const status = daysAgo <= 2 ? "booked" : rnd() < 0.85 ? "completed" : rnd() < 0.5 ? "no_show" : "cancelled";
          // Past bookings only; overlaps with the week's showcase bookings would confuse the grid.
          if (daysAgo > 7) insertBooking.run(bid, wa, name, svc.id, start, end, svc.durationMin, status, "agent", "", t, t);
        }
      }
    }
  }
}

/** `staffUserId`: a dashboard user who has taken one conversation over and replied. */
export function seedDemoData(bid: BusinessId, staffUserId?: number): void {
  inbound(bid, "96170111222", "Rami Haddad", "Hi! Do you have robotics classes for a 10 year old?", 180);
  outbound(bid, "96170111222", "Yes! Our robotics class is 60 minutes, Monday to Friday between 8am and 3pm. Would you like to book a trial?", { status: "read", minutesAgo: 179 });
  inbound(bid, "96170111222", "Rami Haddad", "Tuesday at 10 please", 170);
  outbound(bid, "96170111222", "Booked: Tuesday at 10:00 for the robotics class. See you then!", { status: "delivered", minutesAgo: 169 });

  inbound(bid, "96178333444", "Nour Khalil", "Can I bring my brother to the trial too?", 30 * 60);
  outbound(bid, "96178333444", "Of course! Both of you are welcome. Shall I book two seats?", { status: "read", minutesAgo: 30 * 60 - 1 });

  inbound(bid, "33612345678", "Sophie Martin", "Bonjour, quels sont vos tarifs pour le cours de code ?", 95);
  outbound(bid, "33612345678", "Bonjour Sophie ! Le cours de code dure 60 minutes. Voulez-vous réserver un créneau ?", { minutesAgo: 94 });

  inbound(bid, "96171555666", "Layla Nassar", "مرحبا، هل يوجد صف برمجة يوم الخميس؟", 40);
  outbound(bid, "96171555666", "مرحبا ليلى! نعم، يوجد صف برمجة يوم الخميس بين الساعة 8 صباحًا و3 مساءً. هل تريدين الحجز؟", { minutesAgo: 39 });

  inbound(bid, "15145550199", "Marc Tremblay", "I was charged twice last month, I want to talk to someone", 12);
  pauseForHuman(bid, "15145550199", "billing dispute - customer asked for a person");
  seedBookings(bid);
  seedHistory(bid);

  if (staffUserId) {
    inbound(bid, "33698765432", "Julien Roy", "Is there a discount for siblings?", 25);
    outbound(bid, "33698765432", "Let me check with the team for you.", { status: "read", minutesAgo: 24 });
    takeOver(bid, "33698765432", staffUserId);
    outbound(bid, "33698765432", "Hi Julien, this is the owner - yes, 15% off the second child. Want me to set that up?", { staff: staffUserId, status: "delivered" });
    inbound(bid, "33698765432", "Julien Roy", "Yes please!", 0);
  }
}
