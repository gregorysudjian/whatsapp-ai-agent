/**
 * Realistic demo traffic for screenshots and manual testing - only ever run
 * against a throwaway database (the shots runner enforces that).
 */

import type { BusinessId } from "../store/db.ts";
import { recordInbound, recordOutbound, recordUsage, pauseForHuman } from "../store/db.ts";
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

function outbound(bid: BusinessId, to: string, text: string, usage = true): void {
  const id = `demo-out-${bid}-${++n}`;
  recordOutbound(bid, id, to, text);
  if (usage) recordUsage(bid, id, { inputTokens: 1800, outputTokens: 70, cacheReadTokens: 1500, latencyMs: 2400 });
}

export function seedDemoData(bid: BusinessId): void {
  inbound(bid, "96170111222", "Rami Haddad", "Hi! Do you have robotics classes for a 10 year old?", 180);
  outbound(bid, "96170111222", "Yes! Our robotics class is 60 minutes, Monday to Friday between 8am and 3pm. Would you like to book a trial?");
  inbound(bid, "96170111222", "Rami Haddad", "Tuesday at 10 please", 170);
  outbound(bid, "96170111222", "Booked: Tuesday at 10:00 for the robotics class. See you then!");

  inbound(bid, "33612345678", "Sophie Martin", "Bonjour, quels sont vos tarifs pour le cours de code ?", 95);
  outbound(bid, "33612345678", "Bonjour Sophie ! Le cours de code dure 60 minutes. Voulez-vous réserver un créneau ?");

  inbound(bid, "96171555666", "Layla Nassar", "مرحبا، هل يوجد صف برمجة يوم الخميس؟", 40);
  outbound(bid, "96171555666", "مرحبا ليلى! نعم، يوجد صف برمجة يوم الخميس بين الساعة 8 صباحًا و3 مساءً. هل تريدين الحجز؟");

  inbound(bid, "15145550199", "Marc Tremblay", "I was charged twice last month, I want to talk to someone", 12);
  pauseForHuman(bid, "15145550199", "billing dispute - customer asked for a person");
}
