/**
 * Realistic demo traffic for screenshots and manual testing - only ever run
 * against a throwaway database (the shots runner enforces that).
 */

import type { BusinessId } from "../store/db.ts";
import { recordInbound, recordOutbound, recordStatus, recordUsage, pauseForHuman, takeOver } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";

let n = 0;
function inbound(bid: BusinessId, from: string, name: string, text: string, minutesAgo: number): void {
  const id = `demo-in-${bid}-${++n}`;
  const msg: InboundMessage = {
    id, from, senderName: name, timestamp: new Date(Date.now() - minutesAgo * 60_000), text,
    raw: { id, from, timestamp: "0", type: "text", text: { body: text } },
  };
  recordInbound(bid, msg);
}

function outbound(bid: BusinessId, to: string, text: string, opts: { staff?: number; status?: string } = {}): void {
  const id = `demo-out-${bid}-${++n}`;
  recordOutbound(bid, id, to, text, opts.staff ? "human" : "ai", opts.staff ?? null);
  if (!opts.staff) recordUsage(bid, id, { inputTokens: 1800, outputTokens: 70, cacheReadTokens: 1500, latencyMs: 2400 });
  if (opts.status) {
    recordStatus(bid, { id, status: opts.status, timestamp: "0", recipient_id: to } as Parameters<typeof recordStatus>[1]);
  }
}

/** `staffUserId`: a dashboard user who has taken one conversation over and replied. */
export function seedDemoData(bid: BusinessId, staffUserId?: number): void {
  inbound(bid, "96170111222", "Rami Haddad", "Hi! Do you have robotics classes for a 10 year old?", 180);
  outbound(bid, "96170111222", "Yes! Our robotics class is 60 minutes, Monday to Friday between 8am and 3pm. Would you like to book a trial?", { status: "read" });
  inbound(bid, "96170111222", "Rami Haddad", "Tuesday at 10 please", 170);
  outbound(bid, "96170111222", "Booked: Tuesday at 10:00 for the robotics class. See you then!", { status: "delivered" });

  inbound(bid, "96178333444", "Nour Khalil", "Can I bring my brother to the trial too?", 30 * 60);
  outbound(bid, "96178333444", "Of course! Both of you are welcome. Shall I book two seats?", { status: "read" });

  inbound(bid, "33612345678", "Sophie Martin", "Bonjour, quels sont vos tarifs pour le cours de code ?", 95);
  outbound(bid, "33612345678", "Bonjour Sophie ! Le cours de code dure 60 minutes. Voulez-vous réserver un créneau ?");

  inbound(bid, "96171555666", "Layla Nassar", "مرحبا، هل يوجد صف برمجة يوم الخميس؟", 40);
  outbound(bid, "96171555666", "مرحبا ليلى! نعم، يوجد صف برمجة يوم الخميس بين الساعة 8 صباحًا و3 مساءً. هل تريدين الحجز؟");

  inbound(bid, "15145550199", "Marc Tremblay", "I was charged twice last month, I want to talk to someone", 12);
  pauseForHuman(bid, "15145550199", "billing dispute - customer asked for a person");

  if (staffUserId) {
    inbound(bid, "33698765432", "Julien Roy", "Is there a discount for siblings?", 25);
    outbound(bid, "33698765432", "Let me check with the team for you.", { status: "read" });
    takeOver(bid, "33698765432", staffUserId);
    outbound(bid, "33698765432", "Hi Julien, this is the owner - yes, 15% off the second child. Want me to set that up?", { staff: staffUserId, status: "delivered" });
    inbound(bid, "33698765432", "Julien Roy", "Yes please!", 0);
  }
}
