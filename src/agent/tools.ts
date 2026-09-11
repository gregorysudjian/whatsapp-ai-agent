/**
 * Tools the agent can call.
 *
 * Each is a plain function taking already-parsed input, so it can be unit
 * tested without the model. The model-facing schemas sit next to them.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "../logger.ts";
import { recordEvent, pauseForHuman, type BusinessId } from "../store/db.ts";
import { availableSlots, createBooking } from "../store/bookings.ts";
import { getBusiness } from "../store/businesses.ts";
import { getSchedule, getSettings, LANGUAGE_NAMES } from "../store/settings.ts";
import { formatPrice, listServices } from "../store/services.ts";
import { describeHours } from "./prompt.ts";

/**
 * `strict: true` with additionalProperties:false guarantees the arguments
 * validate against the schema, which is what lets the executors below treat
 * required fields as present.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_business_info",
    description:
      "The business's current opening hours, address, services with durations and prices, FAQs and languages. Use this instead of guessing or recalling them.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "check_availability",
    description: "List bookable time slots that are still free on a given date.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date as YYYY-MM-DD" },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "create_booking",
    description:
      "Book a free slot. Check availability first. Fails if the slot is taken, in the past, or outside opening hours.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot as YYYY-MM-DDTHH:00" },
        name: { type: "string", description: "Name for the booking" },
        party_size: { type: "integer", description: "Number of people" },
      },
      required: ["slot", "name", "party_size"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand this conversation to a person. Use when the customer asks for a human, is upset, or wants something you cannot do. After this, stop replying.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why a human is needed" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

export interface ToolContext {
  /**
   * Which client this conversation belongs to. Like waId, it comes from the
   * verified webhook route - never from tool input - so the model cannot be
   * talked into acting on another client's data.
   */
  businessId: BusinessId;
  /** The contact this conversation is with - never taken from tool input. */
  waId: string;
  senderName: string | undefined;
}

export interface ToolOutcome {
  content: string;
  /** True when the agent should stop replying in this thread. */
  handoff?: boolean;
}

/**
 * Inputs arrive already parsed by the SDK. They are never string-matched:
 * Opus 5 varies its JSON escaping in tool arguments, so anything comparing
 * raw serialised input would be subtly wrong.
 */
export function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): ToolOutcome {
  const args = (input ?? {}) as Record<string, unknown>;
  log.info("tool_called", { name, businessId: ctx.businessId, waId: ctx.waId });
  recordEvent(ctx.businessId, "info", "tool_called", { name, waId: ctx.waId });

  switch (name) {
    case "get_business_info": {
      // Read fresh, so an edit on the settings page applies mid-conversation.
      const business = getBusiness(ctx.businessId);
      const s = getSettings(ctx.businessId);
      return {
        content: JSON.stringify({
          name: business?.name ?? null,
          about: s.about || null,
          address: s.address || null,
          contact: s.contact || null,
          timezone: business?.timezone ?? null,
          hours: describeHours(getSchedule(ctx.businessId)),
          services: listServices(ctx.businessId).map((svc) => ({
            service_id: svc.id, name: svc.name, duration_min: svc.durationMin,
            price: formatPrice(svc) ?? "not set - offer to ask a person",
          })),
          languages: s.languages.map((c) => LANGUAGE_NAMES[c] ?? c),
          faqs: s.faqs,
          note: "Anything null or missing is unknown: say so, and offer to pass the question to a person.",
        }),
      };
    }

    case "check_availability": {
      const slots = availableSlots(ctx.businessId, String(args["date"] ?? ""));
      return {
        content: slots.length
          ? JSON.stringify({ free: slots })
          : "No free slots on that date. Suggest another day.",
      };
    }

    case "create_booking": {
      const result = createBooking(
        ctx.businessId,
        ctx.waId,
        String(args["name"] ?? ctx.senderName ?? ""),
        String(args["slot"] ?? ""),
        Number(args["party_size"] ?? 1),
      );
      if (result.ok) return { content: `Booked for ${result.slot}.` };

      const why: Record<string, string> = {
        past: "That time is in the past.",
        taken: "That slot has just been taken.",
        closed: "That time is outside opening hours.",
        malformed: "That is not a valid slot; use YYYY-MM-DDTHH:00.",
      };
      return { content: `Booking failed. ${why[result.reason]} Offer an alternative.` };
    }

    case "escalate_to_human": {
      const reason = String(args["reason"] ?? "unspecified");
      pauseForHuman(ctx.businessId, ctx.waId, reason);
      return {
        content: "Handed to a human. Tell the customer someone will follow up, then stop.",
        handoff: true,
      };
    }

    default:
      // Reached only if the model invents a tool name.
      log.warn("unknown_tool", { name });
      return { content: `Unknown tool: ${name}` };
  }
}
