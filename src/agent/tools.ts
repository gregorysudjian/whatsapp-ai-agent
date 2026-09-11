/**
 * Tools the agent can call.
 *
 * Each is a plain function taking already-parsed input, so it can be unit
 * tested without the model. The model-facing schemas sit next to them.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "../logger.ts";
import { recordEvent, pauseForHuman, type BusinessId } from "../store/db.ts";
import {
  availableSlots, cancelForCustomer, createBooking, rescheduleForCustomer, upcomingForCustomer,
  type Booking, type BookingFailure,
} from "../store/bookings.ts";
import { getBusiness } from "../store/businesses.ts";
import { getSchedule, getSettings, LANGUAGE_NAMES } from "../store/settings.ts";
import { formatPrice, getService, listServices } from "../store/services.ts";
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
    description: "List the start times still free on a date for one service (its duration is taken into account).",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date as YYYY-MM-DD" },
        service_id: { type: "integer", description: "The service_id from the services list" },
      },
      required: ["date", "service_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_booking",
    description:
      "Book a service at a free start time for this customer. Check availability first. Fails if the time is taken, in the past, or outside opening hours.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "integer", description: "The service_id from the services list" },
        start: { type: "string", description: "Start as YYYY-MM-DDTHH:MM, one of the times check_availability returned" },
        name: { type: "string", description: "The customer's name for the booking" },
        notes: { type: "string", description: "Anything the business should know, e.g. the number of people; empty string if nothing" },
      },
      required: ["service_id", "start", "name", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "list_my_bookings",
    description: "This customer's upcoming bookings, with their booking_id. Use before cancelling or rescheduling.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "cancel_my_booking",
    description: "Cancel one of this customer's own upcoming bookings. Confirm with the customer first.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { booking_id: { type: "integer", description: "From list_my_bookings" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    name: "reschedule_my_booking",
    description: "Move one of this customer's own upcoming bookings to a new free start time (same service). Check availability first.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        booking_id: { type: "integer", description: "From list_my_bookings" },
        start: { type: "string", description: "New start as YYYY-MM-DDTHH:MM" },
      },
      required: ["booking_id", "start"],
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
      const serviceId = Number(args["service_id"]);
      const service = getService(ctx.businessId, serviceId);
      if (!service || !service.active) return { content: WHY.no_service };
      const slots = availableSlots(ctx.businessId, String(args["date"] ?? ""), { serviceId });
      return {
        content: slots.length
          ? JSON.stringify({ service: service.name, duration_min: service.durationMin, free_starts: slots })
          : "No free times on that date for this service. Suggest another day.",
      };
    }

    case "create_booking": {
      const result = createBooking(ctx.businessId, {
        // Whose booking it is comes from the verified webhook, never from input.
        waId: ctx.waId,
        customerName: String(args["name"] ?? "") || ctx.senderName || null,
        serviceId: Number(args["service_id"]),
        start: String(args["start"] ?? ""),
        notes: String(args["notes"] ?? ""),
        source: "agent",
      });
      if (result.ok) return { content: `Booked. ${describe(result.booking)} Confirm these details to the customer.` };
      return { content: `Booking failed. ${WHY[result.reason]} Offer an alternative.` };
    }

    case "list_my_bookings": {
      const mine = upcomingForCustomer(ctx.businessId, ctx.waId);
      return {
        content: mine.length
          ? JSON.stringify(mine.map((b) => ({ booking_id: b.id, service: b.serviceName, start: b.start, end: b.end, status: b.status })))
          : "This customer has no upcoming bookings.",
      };
    }

    case "cancel_my_booking": {
      const result = cancelForCustomer(ctx.businessId, ctx.waId, Number(args["booking_id"]));
      if (result.ok) return { content: `Cancelled. ${describe(result.booking)}` };
      return { content: `Could not cancel. ${WHY[result.reason]}` };
    }

    case "reschedule_my_booking": {
      const result = rescheduleForCustomer(ctx.businessId, ctx.waId, Number(args["booking_id"]), String(args["start"] ?? ""));
      if (result.ok) return { content: `Moved. ${describe(result.booking)} Confirm the new time to the customer.` };
      return { content: `Could not reschedule. ${WHY[result.reason]} Offer an alternative.` };
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

/** What the model is told about a failure, in words it can pass on. */
const WHY: Record<BookingFailure, string> = {
  past: "That time is in the past.",
  taken: "That time has just been taken.",
  closed: "That time is outside opening hours, or the service would run past closing.",
  malformed: "That is not a valid time; use YYYY-MM-DDTHH:MM.",
  off_grid: "Bookings start on the hour or the half hour.",
  no_service: "Unknown service_id. Use one from the services list.",
  // Someone else's booking reads exactly like a missing one.
  not_found: "No such booking for this customer. Use list_my_bookings.",
  cancelled: "That booking is already cancelled.",
};

function describe(b: Booking): string {
  return `booking_id ${b.id}: ${b.serviceName ?? "appointment"}, ${b.start.replace("T", " ")} to ${b.end.slice(11)}, name ${b.customerName ?? "not given"}.`;
}
