/**
 * /api/b/:bid/* - everything an owner does with their own business.
 *
 * Mounted in app.ts behind requireAuth + requireBusinessAccess, so every
 * route added to this router is scoped by construction; authz.test.ts walks
 * this router's stack and proves it for each route, including ones added
 * later. Read the business with businessOf(req), never from the body.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { businessOf, clientIp, getAuth } from "../auth/middleware.ts";
import { resolveSession } from "../auth/sessions.ts";
import { getBusiness, updateBusinessProfile } from "../store/businesses.ts";
import { listConversations, listMessages, stats, type ConversationFilter } from "../store/queries.ts";
import {
  agentEnabled, contactExists, handBack, isPaused, setAgentEnabled, takeOver, windowState,
} from "../store/db.ts";
import { canAccessBusiness } from "../store/users.ts";
import { subscribe } from "../core/events.ts";
import { NotConnectedError, sendText } from "../whatsapp/client.ts";
import { log } from "../logger.ts";
import { getSchedule, getSettings, LANGUAGE_NAMES, setSchedule, setSettings } from "../store/settings.ts";
import { createService, deactivateService, listServices, updateService } from "../store/services.ts";
import { audit } from "../store/audit.ts";
import { buildContextBlock, buildSystemPrompt } from "../agent/prompt.ts";
import { body, handleError, query } from "./validate.ts";
import { addDays, MAX_RANGE_DAYS, overview } from "../store/overview.ts";
import {
  availableSlots, BOOKING_STATUSES, createBooking, listBookings, updateBooking, wallClockNow,
  type BookingFailure, type BookingPatch, type BookingStatus,
} from "../store/bookings.ts";

// mergeParams: the :bid in the mount path is visible to requireBusinessAccess.
export const businessRouter: Router = Router({ mergeParams: true });

/** Audit a write by the logged-in user, against the scoped business. */
function record(req: Request, action: string, target?: string, detail?: Record<string, unknown>): void {
  audit({
    userId: getAuth(req).user.id, businessId: businessOf(req), action,
    target: target ?? null, detail: detail ?? null, ip: clientIp(req),
  });
}

function profile(bid: number) {
  const b = getBusiness(bid)!;
  return {
    id: b.id, name: b.name, status: b.status, timezone: b.timezone,
    defaultLanguage: b.defaultLanguage, connected: b.hasCredentials,
  };
}

businessRouter.get("/summary", (req: Request, res: Response) => {
  const bid = businessOf(req);
  res.json({ business: profile(bid), stats: stats(bid) });
});

// --- agent settings -----------------------------------------------------------

businessRouter.get("/settings", (req: Request, res: Response) => {
  const bid = businessOf(req);
  res.json({
    business: profile(bid),
    settings: getSettings(bid),
    schedule: getSchedule(bid),
    services: listServices(bid, true),
    languageNames: LANGUAGE_NAMES,
  });
});

const ProfileBody = z.object({
  name: z.string(),
  timezone: z.string(),
  defaultLanguage: z.enum(["en", "fr"]),
}).strict();

const SettingsBody = z.object({
  business: ProfileBody.optional(),
  settings: z.unknown(),
}).strict();

businessRouter.put("/settings", (req: Request, res: Response) => {
  const input = body(SettingsBody, req, res);
  if (!input) return;
  const bid = businessOf(req);
  try {
    // Settings first: if they are invalid, the profile is not half-saved.
    const settings = setSettings(bid, input.settings);
    if (input.business) updateBusinessProfile(bid, input.business);
    record(req, "settings_updated");
    res.json({ business: profile(bid), settings });
  } catch (err) {
    handleError(err, res);
  }
});

businessRouter.put("/schedule", (req: Request, res: Response) => {
  const bid = businessOf(req);
  try {
    const schedule = setSchedule(bid, req.body);
    record(req, "schedule_updated");
    res.json({ schedule });
  } catch (err) {
    handleError(err, res);
  }
});

/** Exactly what the agent is told - so an owner can check it, word for word. */
businessRouter.get("/settings/preview", (req: Request, res: Response) => {
  const bid = businessOf(req);
  const b = getBusiness(bid)!;
  res.json({
    prompt: buildSystemPrompt({
      businessName: b.name, timezone: b.timezone,
      settings: getSettings(bid), schedule: getSchedule(bid), services: listServices(bid),
    }),
    context: buildContextBlock(b.timezone),
  });
});

// --- services -----------------------------------------------------------------

const serviceId = (req: Request) => {
  const raw = req.params["id"];
  return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
};

businessRouter.get("/services", (req: Request, res: Response) => {
  res.json({ services: listServices(businessOf(req), true) });
});

businessRouter.post("/services", (req: Request, res: Response) => {
  try {
    const service = createService(businessOf(req), req.body);
    record(req, "service_created", String(service.id), { name: service.name });
    res.status(201).json({ service });
  } catch (err) {
    handleError(err, res);
  }
});

businessRouter.put("/services/:id", (req: Request, res: Response) => {
  try {
    const service = updateService(businessOf(req), serviceId(req), req.body);
    if (!service) {
      res.status(404).json({ error: "service_not_found" });
      return;
    }
    record(req, "service_updated", String(service.id), { name: service.name });
    res.json({ service });
  } catch (err) {
    handleError(err, res);
  }
});

businessRouter.delete("/services/:id", (req: Request, res: Response) => {
  const id = serviceId(req);
  if (!deactivateService(businessOf(req), id)) {
    res.status(404).json({ error: "service_not_found" });
    return;
  }
  record(req, "service_deactivated", String(id));
  res.json({ ok: true });
});

// --- the kill switch ----------------------------------------------------------

// Reachable from the dashboard on purpose: a stop button you have to SSH in to
// press is not a stop button.
businessRouter.put("/agent", (req: Request, res: Response) => {
  const input = body(z.object({ enabled: z.boolean() }).strict(), req, res);
  if (!input) return;
  const bid = businessOf(req);
  setAgentEnabled(bid, input.enabled);
  record(req, input.enabled ? "agent_enabled" : "agent_disabled");
  res.json({ agentEnabled: agentEnabled(bid) });
});

// --- inbox --------------------------------------------------------------------

const ConversationsQuery = z.object({
  filter: z.enum(["all", "needs_human", "human", "ai"]).default("all"),
  q: z.string().max(100).default(""),
});

businessRouter.get("/conversations", (req: Request, res: Response) => {
  const input = query(ConversationsQuery, req, res);
  if (!input) return;
  const filter: ConversationFilter = input.filter;
  res.json({ conversations: listConversations(businessOf(req), 200, { filter, q: input.q }) });
});

/** WhatsApp ids are the customer's number in international form, digits only. */
function waIdOf(req: Request, res: Response): string | undefined {
  const raw = req.params["waId"];
  if (typeof raw === "string" && /^\d{5,20}$/.test(raw) && contactExists(businessOf(req), raw)) return raw;
  // Same answer for "malformed" and "someone else's": nothing to learn by probing.
  res.status(404).json({ error: "conversation_not_found" });
  return undefined;
}

function conversationState(bid: number, waId: string) {
  const row = listConversations(bid, 50, { q: waId }).find((c) => c.waId === waId) ?? null;
  return { conversation: row, window: windowState(bid, waId) };
}

businessRouter.get("/conversations/:waId/messages", (req: Request, res: Response) => {
  const waId = waIdOf(req, res);
  if (!waId) return;
  const bid = businessOf(req);
  res.json({ ...conversationState(bid, waId), messages: listMessages(bid, waId, 500) });
});

businessRouter.post("/conversations/:waId/takeover", (req: Request, res: Response) => {
  const waId = waIdOf(req, res);
  if (!waId) return;
  const bid = businessOf(req);
  takeOver(bid, waId, getAuth(req).user.id);
  record(req, "conversation_taken_over", waId);
  res.json(conversationState(bid, waId));
});

businessRouter.post("/conversations/:waId/handback", (req: Request, res: Response) => {
  const waId = waIdOf(req, res);
  if (!waId) return;
  const bid = businessOf(req);
  handBack(bid, waId);
  record(req, "conversation_handed_back", waId);
  res.json(conversationState(bid, waId));
});

const ReplyBody = z.object({
  text: z.string().trim().min(1).max(4096),
}).strict();

/**
 * A person replies from the dashboard. Replying takes the conversation over
 * first - otherwise the agent could answer the customer's next message on top
 * of the person who is mid-conversation with them.
 */
businessRouter.post("/conversations/:waId/reply", async (req: Request, res: Response) => {
  const input = body(ReplyBody, req, res);
  if (!input) return;
  const waId = waIdOf(req, res);
  if (!waId) return;
  const bid = businessOf(req);
  const userId = getAuth(req).user.id;

  if (!getBusiness(bid)?.hasCredentials) {
    res.status(409).json({ error: "not_connected" });
    return;
  }
  if (!windowState(bid, waId).open) {
    res.status(409).json({ error: "window_closed" });
    return;
  }

  if (!isPaused(bid, waId)) record(req, "conversation_taken_over", waId, { via: "reply" });
  takeOver(bid, waId, userId);

  try {
    const ids = await sendText(bid, waId, input.text, { sender: "human", userId });
    // sendText re-checks the window; it can close between our check and the send.
    if (ids.length === 0) {
      res.status(409).json({ error: "window_closed" });
      return;
    }
    // The text itself stays out of the audit log: it already lives in the
    // conversation, and copying it elsewhere doubles what has to be erased later.
    record(req, "conversation_replied", waId, { chars: input.text.length });
    res.status(201).json({ ids, ...conversationState(bid, waId) });
  } catch (err) {
    if (err instanceof NotConnectedError) {
      res.status(409).json({ error: "not_connected" });
      return;
    }
    log.error("manual_reply_failed", { businessId: bid, err: String(err) });
    res.status(502).json({ error: "send_failed" });
  }
});

/**
 * Server-sent events for this one business: the inbox refetches when told
 * something changed, so it never polls. The stream re-checks the session on
 * every heartbeat - logging out, or losing access to the business, closes it
 * - and does so without counting as activity, so an open tab does not keep a
 * session alive past its idle limit.
 */
businessRouter.get("/stream", (req: Request, res: Response) => {
  const bid = businessOf(req);
  const { token } = getAuth(req);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Without this, a proxy can sit on the stream waiting for a buffer to fill.
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = subscribe(bid, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    const user = resolveSession(token, Date.now(), false);
    if (!user || !canAccessBusiness(user, bid)) {
      res.end();
      return;
    }
    res.write(": ping\n\n");
  }, STREAM_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** Comment frames keep idle connections from being reaped by intermediaries. */
export const STREAM_HEARTBEAT_MS = 25_000;

// --- bookings -------------------------------------------------------------------

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2030-01-31");
const WALL_TIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "a time like 2030-01-31T10:00");

const BookingsQuery = z.object({
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
  status: z.enum(["active", ...BOOKING_STATUSES]).optional(),
});

businessRouter.get("/bookings", (req: Request, res: Response) => {
  const input = query(BookingsQuery, req, res);
  if (!input) return;
  const bid = businessOf(req);
  const b = getBusiness(bid)!;
  res.json({
    bookings: listBookings(bid, {
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      ...(input.status ? { status: input.status } : {}),
    }),
    // Bookings are wall-clock times where the business is; the page needs
    // "now" in that same zone, not the browser's.
    now: wallClockNow(b.timezone),
    timezone: b.timezone,
    schedule: getSchedule(bid),
  });
});

const SlotsQuery = z.object({
  date: ISO_DATE,
  serviceId: z.coerce.number().int().positive(),
  exceptId: z.coerce.number().int().positive().optional(),
});

businessRouter.get("/bookings/slots", (req: Request, res: Response) => {
  const input = query(SlotsQuery, req, res);
  if (!input) return;
  res.json({
    slots: availableSlots(businessOf(req), input.date, {
      serviceId: input.serviceId,
      ...(input.exceptId ? { exceptId: input.exceptId } : {}),
    }),
  });
});

/** How each refusal reaches the browser: a conflict with the calendar, or a bad request. */
function bookingFailure(res: Response, reason: BookingFailure): void {
  const status = reason === "not_found" ? 404
    : reason === "malformed" || reason === "no_service" ? 400
    : 409;
  res.status(status).json({ error: reason });
}

const NewBookingBody = z.object({
  customerName: z.string().trim().min(1).max(120),
  waId: z.union([z.literal(""), z.string().regex(/^\d{5,20}$/, "digits only, with the country code")]).optional(),
  serviceId: z.number().int().positive(),
  start: WALL_TIME,
  notes: z.string().max(1000).optional(),
  partySize: z.number().int().min(1).max(100).optional(),
}).strict();

businessRouter.post("/bookings", (req: Request, res: Response) => {
  const input = body(NewBookingBody, req, res);
  if (!input) return;
  const result = createBooking(businessOf(req), {
    waId: input.waId || null,
    customerName: input.customerName,
    serviceId: input.serviceId,
    start: input.start,
    source: "owner",
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.partySize !== undefined ? { partySize: input.partySize } : {}),
  });
  if (!result.ok) return bookingFailure(res, result.reason);
  record(req, "booking_created", String(result.booking.id), { start: result.booking.start, serviceId: result.booking.serviceId });
  res.status(201).json({ booking: result.booking });
});

const bookingId = (req: Request) => {
  const raw = req.params["id"];
  return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
};

const PatchBookingBody = z.object({
  start: WALL_TIME.optional(),
  serviceId: z.number().int().positive().optional(),
  status: z.enum(BOOKING_STATUSES as [BookingStatus, ...BookingStatus[]]).optional(),
  notes: z.string().max(1000).optional(),
  customerName: z.string().trim().max(120).nullable().optional(),
  partySize: z.number().int().min(1).max(100).optional(),
}).strict();

businessRouter.patch("/bookings/:id", (req: Request, res: Response) => {
  const input = body(PatchBookingBody, req, res);
  if (!input) return;
  const patch: BookingPatch = {};
  if (input.start !== undefined) patch.start = input.start;
  if (input.serviceId !== undefined) patch.serviceId = input.serviceId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.customerName !== undefined) patch.customerName = input.customerName;
  if (input.partySize !== undefined) patch.partySize = input.partySize;

  const result = updateBooking(businessOf(req), bookingId(req), patch, "owner");
  if (!result.ok) return bookingFailure(res, result.reason);
  record(req, "booking_updated", String(result.booking.id), { fields: Object.keys(patch) });
  res.json({ booking: result.booking });
});

const CancelBody = z.object({
  /** Tell the customer on WhatsApp. Only possible inside the 24h window until templates exist. */
  notify: z.boolean().default(false),
  message: z.string().trim().max(1000).default(""),
}).strict();

businessRouter.post("/bookings/:id/cancel", async (req: Request, res: Response) => {
  const input = body(CancelBody, req, res);
  if (!input) return;
  const bid = businessOf(req);
  const result = updateBooking(bid, bookingId(req), { status: "cancelled" }, "owner");
  if (!result.ok) return bookingFailure(res, result.reason);
  const booking = result.booking;
  record(req, "booking_cancelled", String(booking.id), { notify: input.notify });

  // The cancellation stands whatever happens to the message: a failed notice
  // is reported back so the owner can tell the customer another way.
  let notified = false;
  let notifyError: string | null = null;
  if (input.notify) {
    if (!booking.waId) notifyError = "no_whatsapp";
    else if (!input.message) notifyError = "empty_message";
    else if (!getBusiness(bid)?.hasCredentials) notifyError = "not_connected";
    else if (!windowState(bid, booking.waId).open) notifyError = "window_closed";
    else {
      try {
        const ids = await sendText(bid, booking.waId, input.message, { sender: "human", userId: getAuth(req).user.id });
        notified = ids.length > 0;
        if (!notified) notifyError = "window_closed";
      } catch (err) {
        log.error("cancel_notice_failed", { businessId: bid, err: String(err) });
        notifyError = err instanceof NotConnectedError ? "not_connected" : "send_failed";
      }
    }
  }
  res.json({ booking, notified, notifyError });
});

// --- overview -------------------------------------------------------------------

const OverviewQuery = z.object({ from: ISO_DATE.optional(), to: ISO_DATE.optional() });

businessRouter.get("/overview", (req: Request, res: Response) => {
  const input = query(OverviewQuery, req, res);
  if (!input) return;
  const bid = businessOf(req);
  // Days are the business's days: "today" is today where it is.
  const today = wallClockNow(getBusiness(bid)!.timezone).slice(0, 10);
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -29);
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (Number.isNaN(span) || span < 1 || span > MAX_RANGE_DAYS) {
    res.status(400).json({ error: "invalid_range" });
    return;
  }
  res.json({ ...overview(bid, from, to), today, agentEnabled: agentEnabled(bid), business: profile(bid) });
});
