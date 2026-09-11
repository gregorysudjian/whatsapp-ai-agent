/**
 * Law 25 (Québec) housekeeping: personal information is kept only as long
 * as the business needs it, and a customer can be erased on request.
 *
 * Both are scoped to one business - a customer who writes to two clients is
 * two separate relationships, and erasing them at one leaves the other alone.
 */

import { db, recordEvent, type BusinessId } from "./db.ts";
import { getBusiness, listBusinesses } from "./businesses.ts";
import { getSettings } from "./settings.ts";
import { getBooking, wallClockNow, type Booking } from "./bookings.ts";

/** `months` calendar months before `now`. */
export function cutoffFor(months: number, now: number = Date.now()): number {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

export interface PurgeCounts { messages: number; events: number; bookings: number; contacts: number }

const purgeMessages = db.prepare(`DELETE FROM messages WHERE business_id = ? AND ts < ?`);
const purgeEvents = db.prepare(`DELETE FROM events WHERE business_id = ? AND ts < ?`);
const purgeBookings = db.prepare(`DELETE FROM bookings WHERE business_id = ? AND end_at < ?`);
// A contact goes once nothing of theirs is left and they have been quiet past the cutoff.
const purgeContacts = db.prepare(`
  DELETE FROM contacts WHERE business_id = ?1 AND COALESCE(last_message_ts, first_seen) < ?2
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.business_id = ?1 AND m.wa_id = contacts.wa_id)
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.business_id = ?1 AND b.wa_id = contacts.wa_id)
`);

/** Delete what is older than this business's retention period. */
export function purgeBusiness(bid: BusinessId, now: number = Date.now()): PurgeCounts {
  const months = getSettings(bid).privacy.retentionMonths;
  const cutoff = cutoffFor(months, now);
  const tz = getBusiness(bid)?.timezone ?? "UTC";
  db.exec("BEGIN IMMEDIATE");
  try {
    const counts = {
      messages: Number(purgeMessages.run(bid, cutoff).changes),
      events: Number(purgeEvents.run(bid, cutoff).changes),
      // Bookings are wall-clock times where the business is.
      bookings: Number(purgeBookings.run(bid, wallClockNow(tz, cutoff)).changes),
      contacts: 0,
    };
    counts.contacts = Number(purgeContacts.run(bid, cutoff).changes);
    db.exec("COMMIT");
    if (counts.messages + counts.events + counts.bookings + counts.contacts > 0) {
      recordEvent(bid, "info", "retention_purge", { months, ...counts });
    }
    return counts;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Every business, plus the platform's own records: old sessions, expired OAuth states, old audit rows. */
export function purgeAll(now: number = Date.now()): void {
  for (const b of listBusinesses()) purgeBusiness(b.id, now);
  db.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).run(now);
  // The audit trail holds IP addresses; two years is enough to investigate anything.
  db.prepare(`DELETE FROM audit_log WHERE ts < ?`).run(cutoffFor(24, now));
}

// --- erasure --------------------------------------------------------------------------

export interface EraseCounts { messages: number; bookings: number; events: number; contact: boolean }

const eraseMessages = db.prepare(`DELETE FROM messages WHERE business_id = ? AND wa_id = ?`);
const bookingsOf = db.prepare(`SELECT id FROM bookings WHERE business_id = ? AND wa_id = ?`);
const eraseBookings = db.prepare(`DELETE FROM bookings WHERE business_id = ? AND wa_id = ?`);
// Event details carry the number ({"waId": ...}, {"from": ...}, {"to": ...}).
const eraseEvents = db.prepare(`DELETE FROM events WHERE business_id = ? AND detail LIKE ?`);
const eraseContactRow = db.prepare(`DELETE FROM contacts WHERE business_id = ? AND wa_id = ?`);
// The audit trail keeps that something happened, not who it happened to.
const redactAudit = db.prepare(`UPDATE audit_log SET target = '[erased]' WHERE business_id = ? AND target = ?`);

/**
 * Everything this business holds about one WhatsApp number, gone. Returns
 * the bookings that had calendar events, so the caller can remove those too.
 */
export function eraseContact(bid: BusinessId, waId: string): { counts: EraseCounts; calendarBookings: Booking[] } {
  if (!/^\d{5,20}$/.test(waId)) throw new Error("bad wa_id");
  const withEvents = (bookingsOf.all(bid, waId) as { id: number }[])
    .map((r) => getBooking(bid, Number(r.id))!)
    .filter((b) => b.calendarEventId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const counts: EraseCounts = {
      messages: Number(eraseMessages.run(bid, waId).changes),
      bookings: Number(eraseBookings.run(bid, waId).changes),
      events: Number(eraseEvents.run(bid, `%${waId}%`).changes),
      contact: Number(eraseContactRow.run(bid, waId).changes) === 1,
    };
    redactAudit.run(bid, waId);
    db.exec("COMMIT");
    return { counts, calendarBookings: withEvents };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// --- the AI disclosure -------------------------------------------------------------------

const disclosedStmt = db.prepare(`SELECT disclosed_at FROM contacts WHERE business_id = ? AND wa_id = ?`);
const markDisclosedStmt = db.prepare(`UPDATE contacts SET disclosed_at = ? WHERE business_id = ? AND wa_id = ? AND disclosed_at IS NULL`);

/** True exactly once per customer: the caller that gets true sends the notice. */
export function claimDisclosure(bid: BusinessId, waId: string, now: number = Date.now()): boolean {
  const row = disclosedStmt.get(bid, waId) as { disclosed_at: number | null } | undefined;
  if (!row || row.disclosed_at !== null) return false;
  return Number(markDisclosedStmt.run(now, bid, waId).changes) === 1;
}

type Lang = "en" | "fr" | "ar";

const DISCLOSURE: Record<Lang, (business: string, url: string) => string> = {
  en: (b, url) => `Hi! You're chatting with ${b}'s automated assistant. Someone from the team can step in at any time.${url ? ` Privacy: ${url}` : ""}`,
  fr: (b, url) => `Bonjour ! Vous discutez avec l'assistant automatisé de ${b}. Une personne de l'équipe peut prendre le relais à tout moment.${url ? ` Confidentialité : ${url}` : ""}`,
  ar: (b, url) => `مرحبًا! أنت تتحدث مع المساعد الآلي لـ ${b}. يمكن لأحد أعضاء الفريق التدخل في أي وقت.${url ? ` الخصوصية: ${url}` : ""}`,
};

/**
 * The notice in the customer's language when it can be told from their first
 * message (Arabic script, or a clearly French message) and the business
 * speaks it; otherwise the business's main language.
 */
export function disclosureText(bid: BusinessId, firstMessage: string): string {
  const s = getSettings(bid);
  const offered = s.languages.filter((l): l is Lang => l === "en" || l === "fr" || l === "ar");
  let lang: Lang = offered[0] ?? "en";
  if (/[\u0600-\u06FF]/.test(firstMessage) && offered.includes("ar")) lang = "ar";
  else if (/[àâçéèêëîïôûùœ]|\b(bonjour|salut|merci|je|vous|svp|oui)\b/i.test(firstMessage) && offered.includes("fr")) lang = "fr";
  else if (/\b(hi|hello|hey|thanks|please|i|you)\b/i.test(firstMessage) && offered.includes("en")) lang = "en";
  return DISCLOSURE[lang](getBusiness(bid)?.name ?? "", s.privacy.privacyUrl);
}
