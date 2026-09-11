/**
 * Builds what the agent is told, from what the owner saved in settings.
 *
 * Two parts, sent as two system blocks:
 *
 *   buildSystemPrompt - everything durable. BYTE-STABLE: the same inputs give
 *   the same string, in a fixed order, with no clock in it. It is the cached
 *   prefix of every request, and any per-call variation would silently
 *   invalidate the cache and multiply cost.
 *
 *   buildContextBlock - "what time is it where the business is". Changes
 *   every minute, so it goes AFTER the cache breakpoint. Without it the agent
 *   cannot resolve "tomorrow at 10" to a date at all.
 */

import type { AgentSettings, DayHours, Schedule } from "../store/settings.ts";
import { LANGUAGE_NAMES } from "../store/settings.ts";
import { formatPrice, type Service } from "../store/services.ts";

export interface PromptInput {
  businessName: string;
  timezone: string;
  settings: AgentSettings;
  schedule: Schedule;
  services: Service[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, as people read a week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const same = (a: DayHours | undefined, b: DayHours | undefined) =>
  (!a && !b) || (!!a && !!b && a.open === b.open && a.close === b.close);

/**
 * "Monday to Friday: 08:00-15:00", "Saturday and Sunday: closed" - runs of
 * consecutive days with identical hours collapse into one line.
 */
export function describeHours(schedule: Schedule): string[] {
  const runs: { days: number[]; hours: DayHours | undefined }[] = [];
  for (const day of WEEK_ORDER) {
    const hours = schedule[String(day) as keyof Schedule];
    const last = runs[runs.length - 1];
    if (last && same(last.hours, hours)) last.days.push(day);
    else runs.push({ days: [day], hours });
  }
  return runs.map(({ days, hours }) => {
    const first = DAY_NAMES[days[0]!]!;
    const lastDay = DAY_NAMES[days[days.length - 1]!]!;
    const label = days.length === 1 ? first : days.length === 2 ? `${first} and ${lastDay}` : `${first} to ${lastDay}`;
    return `${label}: ${hours ? `${hours.open}-${hours.close}` : "closed"}`;
  });
}

const TONE_TEXT: Record<AgentSettings["tone"], string> = {
  friendly: "Warm and upbeat, like a helpful front-desk person. Short, natural sentences.",
  professional: "Polite, precise and calm. No slang and no emoji.",
  concise: "As brief as possible while still complete. No pleasantries beyond a greeting.",
};

export function buildSystemPrompt({ businessName, timezone, settings: s, schedule, services }: PromptInput): string {
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`You are the WhatsApp assistant for ${businessName}. You talk with its customers on its behalf.`, "");

  push(`About ${businessName}:`);
  push(s.about || "The owner has not described the business yet. If asked what it does, say you will pass the question to a person.");
  push(`Address: ${s.address || "not provided. Do not guess; offer to pass the question to a person."}`);
  push(`All dates and times are local to the business (${timezone}).`, "");

  push("Opening hours:", ...describeHours(schedule).map((h) => `- ${h}`), "");

  if (services.length) {
    push("Services (the only ones that exist):");
    for (const svc of services) {
      const price = formatPrice(svc);
      push(`- ${svc.name} (service_id ${svc.id}): ${svc.durationMin} min, ${price ?? "price not set"}${svc.description ? `. ${svc.description}` : ""}`);
    }
    push("Quote only these prices. For a service whose price is not set, say you do not have the price and offer to ask a person.", "");
  } else {
    push("No services are listed yet. Do not offer or book anything; offer to pass questions to a person.", "");
  }

  if (s.faqs.length) {
    push("Frequently asked questions (use these answers when they apply):");
    for (const f of s.faqs) push(`Q: ${f.q}`, `A: ${f.a}`);
    push("");
  }

  const languages = s.languages.map((c) => LANGUAGE_NAMES[c] ?? c);
  push("Languages:");
  push(`Reply in the customer's language when it is one of: ${[...languages].sort().join(", ")}. Otherwise reply in ${languages[0] ?? "English"}.`, "");

  push(`Tone: ${TONE_TEXT[s.tone]}`);
  if (s.customToneNotes) push(`Also: ${s.customToneNotes}`);
  push("");

  push(
    "Style:",
    "- Keep replies short. Two or three sentences is normal; WhatsApp is a chat, not email.",
    "- Plain text only. WhatsApp renders no markdown: no headers, no bullet syntax, no tables, no code fences.",
    "- Ask at most one question per reply.",
    "",
    "Rules:",
    "- Answer only from the facts above, tool results, or what the customer told you in this conversation.",
    "- If you do not know something, say so and offer to pass it to a person. Never invent details.",
    ...s.neverDo.map((n) => `- Never ${n.replace(/^never\s+/i, "")}.`),
    "",
  );

  push("Handing off to a person. Use the escalate_to_human tool when:");
  push("- the customer asks for a person");
  if (s.handoff.onAnger) push("- the customer is upset or angry");
  if (s.handoff.onAccountChange) push("- the request needs an account change, a refund, or anything you cannot do yourself");
  if (s.handoff.keywords.length) push(`- the message mentions any of: ${s.handoff.keywords.join(", ")}`);
  if (s.handoff.rules) push(`- ${s.handoff.rules}`);
  push(s.contact
    ? `After escalating, tell the customer a person will follow up, and that they can also reach the team at ${s.contact}. Then stop.`
    : "After escalating, tell the customer a person will follow up here in this chat. Then stop.");

  return lines.join("\n");
}

/** The volatile part: the business's local date and time, to the minute. */
export function buildContextBlock(timezone: string, now: number = Date.now()): string {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(now);
  return `Current date and time at the business: ${local} (${timezone}).`;
}
