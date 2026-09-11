/**
 * Appointment reminders, and the customer's answer to them.
 *
 * A reminder is an approved WhatsApp template (the customer may not have
 * written in days, and outside the 24h window only templates deliver) with
 * two quick-reply buttons whose payloads are "confirm:<booking id>" and
 * "cancel:<booking id>". Tapping one comes back through the normal webhook
 * as a `button` message, handled here - never passed to the AI, because a
 * booking's status must not depend on a model reading a button label.
 *
 * Off unless a business turns it on (Settings -> Reminders), because it
 * messages customers who did not write first, and needs a template Meta has
 * approved.
 */

import { log } from "../logger.ts";
import { agentEnabled, recordEvent, type BusinessId } from "../store/db.ts";
import { getBusiness, listBusinesses } from "../store/businesses.ts";
import { getSettings, type AgentSettings } from "../store/settings.ts";
import {
  claimReminder, dueForReminder, getBooking, isPastInZone, updateBooking, wallClockNow, type Booking,
} from "../store/bookings.ts";
import { sendTemplate, sendText } from "../whatsapp/client.ts";
import type { InboundMessage } from "../whatsapp/types.ts";

// --- words ---------------------------------------------------------------------

type Lang = "en" | "fr" | "ar";

/** The reminder's language decides the language of everything around it. */
function langOf(s: AgentSettings): Lang {
  const code = s.reminders.templateLanguage.slice(0, 2);
  return code === "fr" || code === "ar" ? code : "en";
}

const LOCALE: Record<Lang, string> = { en: "en-CA", fr: "fr-CA", ar: "ar-u-nu-latn" };

/** "Tuesday, September 15" / "mardi 15 septembre" - a wall-clock date, formatted without any timezone shift. */
export function formatDay(start: string, lang: Lang): string {
  const ms = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  return new Intl.DateTimeFormat(LOCALE[lang], { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(ms);
}

const REPLIES: Record<Lang, Record<"confirmed" | "cancelled" | "alreadyCancelled" | "past", (d: string, t: string) => string>> = {
  en: {
    confirmed: (d, t) => `Thanks! Your booking on ${d} at ${t} is confirmed. See you then.`,
    cancelled: (d, t) => `Your booking on ${d} at ${t} is cancelled. Reply here any time to book another.`,
    alreadyCancelled: () => "That booking was already cancelled. Reply here if you'd like a new one.",
    past: () => "That booking has already passed. Reply here if you'd like a new one.",
  },
  fr: {
    confirmed: (d, t) => `Merci ! Votre rendez-vous du ${d} à ${t} est confirmé. À bientôt.`,
    cancelled: (d, t) => `Votre rendez-vous du ${d} à ${t} est annulé. Répondez ici quand vous voulez pour en prendre un autre.`,
    alreadyCancelled: () => "Ce rendez-vous était déjà annulé. Répondez ici si vous en souhaitez un nouveau.",
    past: () => "Ce rendez-vous est déjà passé. Répondez ici si vous en souhaitez un nouveau.",
  },
  ar: {
    confirmed: (d, t) => `شكرًا! تم تأكيد موعدك يوم ${d} الساعة ${t}. نراك قريبًا.`,
    cancelled: (d, t) => `تم إلغاء موعدك يوم ${d} الساعة ${t}. راسلنا هنا في أي وقت لحجز موعد آخر.`,
    alreadyCancelled: () => "هذا الموعد ملغى مسبقًا. راسلنا هنا إذا أردت حجز موعد جديد.",
    past: () => "لقد مضى موعد هذا الحجز. راسلنا هنا إذا أردت حجز موعد جديد.",
  },
};

// --- sending ---------------------------------------------------------------------

export const REMINDER_INTERVAL_MS = 60_000;

/**
 * The template's variables, in the order docs/whatsapp-templates.md defines:
 * {{1}} name, {{2}} date, {{3}} time. The buttons carry the booking id.
 */
export function reminderTemplate(b: Booking, s: AgentSettings) {
  const lang = langOf(s);
  const time = b.start.slice(11);
  return {
    name: s.reminders.templateName,
    language: s.reminders.templateLanguage,
    components: [
      {
        type: "body" as const,
        parameters: [
          { type: "text" as const, text: b.customerName?.trim() || (lang === "fr" ? "bonjour" : lang === "ar" ? "مرحبًا" : "there") },
          { type: "text" as const, text: formatDay(b.start, lang) },
          { type: "text" as const, text: time },
        ],
      },
      { type: "button" as const, sub_type: "quick_reply" as const, index: "0", parameters: [{ type: "payload" as const, payload: `confirm:${b.id}` }] },
      { type: "button" as const, sub_type: "quick_reply" as const, index: "1", parameters: [{ type: "payload" as const, payload: `cancel:${b.id}` }] },
    ],
  };
}

/**
 * One pass over every business: send each reminder that has come due.
 * Returns how many were sent. Safe to run twice at once, or after a crash:
 * a reminder is claimed in the database before it is sent.
 */
export async function runReminders(now: number = Date.now()): Promise<number> {
  let sent = 0;
  for (const business of listBusinesses()) {
    // The kill switch stops every automatic message, not just AI replies:
    // an owner pausing the agent in a hurry means "stop talking to customers".
    if (business.status !== "active" || !business.hasCredentials || !agentEnabled(business.id)) continue;
    const settings = getSettings(business.id);
    if (!settings.reminders.enabled) continue;

    const hoursMs = settings.reminders.hoursBefore * 3_600_000;
    const tz = business.timezone;
    const due = dueForReminder(business.id, wallClockNow(tz, now), wallClockNow(tz, now + hoursMs));
    for (const b of due) {
      // Booked after its reminder time would have been ("remind 24h before",
      // booked 3h before): the customer has just talked to us, so a reminder
      // now would only be noise.
      if (wallClockNow(tz, b.createdAt + hoursMs) >= b.start) continue;
      if (!claimReminder(business.id, b.id, now)) continue;
      try {
        const tpl = reminderTemplate(b, settings);
        const preview = `⏰ ${tpl.name}: ${b.customerName ?? ""} · ${formatDay(b.start, langOf(settings))} ${b.start.slice(11)}`;
        await sendTemplate(business.id, b.waId!, tpl, preview);
        sent++;
        recordEvent(business.id, "info", "reminder_sent", { bookingId: b.id });
      } catch (err) {
        // Left claimed: graphPost already retried, and un-claiming would
        // retry a permanent failure (a rejected template) every minute.
        log.error("reminder_failed", { businessId: business.id, bookingId: b.id, err: String(err) });
        recordEvent(business.id, "error", "reminder_failed", { bookingId: b.id, error: String(err).slice(0, 300) });
      }
    }
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Started by index.ts only - tests call runReminders directly. */
export function startReminderScheduler(): void {
  if (timer) return;
  let running = false;
  timer = setInterval(() => {
    if (running) return; // a slow pass is never overlapped by the next one
    running = true;
    runReminders().catch((err) => log.error("reminder_run_failed", { err: String(err) })).finally(() => { running = false; });
  }, REMINDER_INTERVAL_MS);
  timer.unref();
}

// --- the customer's answer ----------------------------------------------------------

const PAYLOAD = /^(confirm|cancel):(\d{1,9})$/;

/** The booking action a message carries, if it is a reminder button. */
export function bookingButton(msg: InboundMessage): { action: "confirm" | "cancel"; bookingId: number } | null {
  const raw = msg.raw.button?.payload ?? msg.raw.interactive?.button_reply?.id;
  const m = raw ? PAYLOAD.exec(raw) : null;
  return m ? { action: m[1] as "confirm" | "cancel", bookingId: Number(m[2]) } : null;
}

/**
 * Handle a Confirm / Cancel tap. Returns true when the message was a
 * booking button (handled or refused) - the caller must then not pass it on
 * to the AI.
 *
 * The booking must belong to this business AND this customer; anything else
 * is ignored without a reply, so a forged payload learns nothing.
 */
export async function handleBookingButton(businessId: BusinessId, msg: InboundMessage): Promise<boolean> {
  const button = bookingButton(msg);
  if (!button) return false;

  const b = getBooking(businessId, button.bookingId);
  if (!b || b.waId !== msg.from) {
    log.warn("booking_button_ignored", { businessId, from: msg.from, bookingId: button.bookingId });
    recordEvent(businessId, "warn", "booking_button_ignored", { bookingId: button.bookingId });
    return true;
  }

  const lang = langOf(getSettings(businessId));
  const words = REPLIES[lang];
  const day = formatDay(b.start, lang);
  const time = b.start.slice(11);
  const tz = getBusiness(businessId)?.timezone ?? "UTC";

  let reply: string;
  if (b.status === "cancelled") reply = words.alreadyCancelled(day, time);
  else if (isPastInZone(b.start, tz)) reply = words.past(day, time);
  else if (button.action === "confirm") {
    if (b.status !== "confirmed") updateBooking(businessId, b.id, { status: "confirmed" }, "agent");
    recordEvent(businessId, "info", "booking_confirmed_by_customer", { bookingId: b.id });
    reply = words.confirmed(day, time);
  } else {
    updateBooking(businessId, b.id, { status: "cancelled" }, "agent");
    recordEvent(businessId, "info", "booking_cancelled_by_customer", { bookingId: b.id });
    reply = words.cancelled(day, time);
  }

  // Paused means no automatic messages; the booking change above still stands,
  // and the owner sees it on the Bookings page.
  if (!agentEnabled(businessId)) return true;
  try {
    // The customer has just tapped, so the 24h window is open.
    await sendText(businessId, msg.from, reply, { sender: "system" });
  } catch (err) {
    log.error("booking_button_reply_failed", { businessId, err: String(err) });
  }
  return true;
}
