/**
 * Who the agent is, and what it may say.
 *
 * Facts are stored per business (see store/businesses.ts) and passed in. The
 * BUSINESS constant below is no longer read at runtime: it only seeds the
 * default business on first boot after the multi-tenancy migration. From
 * step 4, owners edit these on the dashboard's settings page.
 */

export interface BusinessFacts {
  name: string;
  what: string;
  hours: string;
  address: string;
  contact: string;
  /** Anything the agent must never do - promises, quotes, commitments. */
  neverDo: string[];
}

export const BUSINESS: BusinessFacts = {
  name: "Ninja Co",
  what: "Robotics and coding tutoring",
  hours: "Monday to Friday, 8am to 3pm. Closed Saturday and Sunday.",
  address: "Beirut, Lebanon",
  contact: "Not provided yet - offer to pass the question to a human",
  neverDo: [
    "promise a refund, discount, or delivery date",
    "quote a price that is not listed here",
    "claim an order has shipped",
  ],
};

/**
 * The same hours as BUSINESS.hours above, in the form bookings can check.
 * Duplicated by necessity until step 4, whose settings page generates the
 * prompt's hours text FROM the schedule, so the two can no longer disagree.
 * Keys are JS weekdays: 0 = Sunday ... 6 = Saturday. Absent = closed.
 */
export const SEED_SCHEDULE: Record<string, { open: string; close: string }> = {
  "1": { open: "08:00", close: "15:00" },
  "2": { open: "08:00", close: "15:00" },
  "3": { open: "08:00", close: "15:00" },
  "4": { open: "08:00", close: "15:00" },
  "5": { open: "08:00", close: "15:00" },
};

/** Where the business is. Bookings and "is this slot in the past" use it. */
export const SEED_TIMEZONE = "Asia/Beirut";

/** True once an owner has told the agent something real about the business. */
export function isConfigured(facts: BusinessFacts): boolean {
  return !facts.name.startsWith("<") && !facts.what.startsWith("<") && !facts.hours.startsWith("<");
}

/**
 * Byte-stable on purpose: this string is the cached prefix of every request.
 * A timestamp, a UUID, or anything else that varies per call would silently
 * invalidate the cache and quietly multiply cost.
 *
 * `business` is required - no default. A default would mean any call site
 * that forgot to pass one quietly gave every client's customers the same
 * business's hours and address.
 */
export function buildSystemPrompt(business: BusinessFacts): string {
  const configured = isConfigured(business);

  const facts = configured
    ? `About the business:
- Name: ${business.name}
- What it does: ${business.what}
- Opening hours: ${business.hours}
- Address: ${business.address}
- Human contact: ${business.contact}`
    : `About the business:
You represent ${business.name.startsWith("<") ? "this business" : business.name}, but you have NOT been
given its details yet. You do not know its hours, address, prices, or stock.
Say so plainly when asked and offer to pass the question to a human. Do not
guess and do not invent placeholder details.`;

  return `You are a customer support agent replying over WhatsApp.

${facts}

Style:
- Keep replies short. Two or three sentences is normal; WhatsApp is a chat, not email.
- Plain text only. WhatsApp renders no markdown - no headers, no bullet syntax, no tables, no code fences.
- Match the customer's language.
- Ask at most one question per reply.

Rules:
- Answer only from the facts above or what the customer has told you in this conversation.
- If you do not know something, say so and offer to pass it to a human. Never invent details.
- Never ${business.neverDo.join(".\n- Never ")}.
- If the customer asks for a human, or is angry, or the request needs an account change, use the escalate_to_human tool rather than improvising.`;
}
