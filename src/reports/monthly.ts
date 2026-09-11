/**
 * The monthly PDF report for one business, in its default language.
 *
 * Built from the same numbers as the Overview page (store/overview.ts), for
 * the business's own calendar month. Drawn with pdfkit's built-in Helvetica,
 * so there are no font files to ship; that font covers English and French
 * (accents included) but not Arabic script, which is why the report's own
 * words are only ever English or French.
 */

import PDFDocument from "pdfkit";
import { getBusiness } from "../store/businesses.ts";
import type { BusinessId } from "../store/db.ts";
import { overview, type Overview } from "../store/overview.ts";
import { wallClockNow } from "../store/bookings.ts";

type Lang = "en" | "fr";

const WORDS: Record<Lang, Record<string, string>> = {
  en: {
    title: "Monthly report", generated: "Generated", times: "Times in", page: "WhatsApp agent report",
    conversations: "New conversations", inbound: "Messages received", aiShare: "Answered by the agent",
    aiShareNote: "{ai} of {all} replies", bookings: "Bookings made", bookingsNote: "{n} by the agent",
    handoffs: "Handed to a person", handoffsNote: "{n} taken over", response: "Typical reply time", responseNote: "90% within {p90}",
    vsPrevious: "vs the previous period", soFar: "to date (1 to {day})", replies: "Replies per day", agent: "Agent", team: "Team",
    appointments: "Appointments this month", booked: "Booked", confirmed: "Confirmed", completed: "Completed",
    no_show: "No-show", cancelled: "Cancelled", replyTimes: "Reply times", median: "Median", p90: "90% of replies within",
    unanswered: "Unanswered after 24 hours", noData: "No activity this month.", none: "—",
  },
  fr: {
    title: "Rapport mensuel", generated: "Généré le", times: "Heures de", page: "Rapport de l'agent WhatsApp",
    conversations: "Nouvelles discussions", inbound: "Messages reçus", aiShare: "Répondu par l'agent",
    aiShareNote: "{ai} réponses sur {all}", bookings: "Rendez-vous pris", bookingsNote: "{n} par l'agent",
    handoffs: "Transférés à une personne", handoffsNote: "{n} pris en charge", response: "Délai de réponse habituel", responseNote: "90 % en moins de {p90}",
    vsPrevious: "vs la période précédente", soFar: "en cours (du 1er au {day})", replies: "Réponses par jour", agent: "L'agent", team: "L'équipe",
    appointments: "Rendez-vous du mois", booked: "Réservé", confirmed: "Confirmé", completed: "Terminé",
    no_show: "Absent", cancelled: "Annulé", replyTimes: "Délais de réponse", median: "Médiane", p90: "90 % des réponses en moins de",
    unanswered: "Sans réponse après 24 heures", noData: "Aucune activité ce mois-ci.", none: "—",
  },
};

// The validated chart palette (categorical slots 1-2), plus the page's inks.
const BLUE = "#2a78d6";
const ORANGE = "#eb6834";
const INK = "#18181b";
const MUTED = "#71717a";
const HAIRLINE = "#e4e4e7";

/** Helvetica's encoding has no narrow no-break space, which fr-CA uses between thousands. */
const clean = (s: string) => s.replace(/[\u202f\u2009]/g, " ");

function monthBounds(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export interface ReportData {
  business: { name: string; timezone: string; language: Lang };
  month: string;
  /** The last day covered, when the month is still in progress; null for a whole month. */
  throughDay: string | null;
  overview: Overview;
}

/**
 * The month in progress is reported to date, not to its last day: comparing
 * eleven days of September with thirty days before them would show every
 * number collapsing.
 */
export function reportData(bid: BusinessId, month: string, now: number = Date.now()): ReportData {
  const b = getBusiness(bid)!;
  const { from, to } = monthBounds(month);
  const today = wallClockNow(b.timezone, now).slice(0, 10);
  const partial = from <= today && today < to;
  return {
    business: { name: b.name, timezone: b.timezone, language: b.defaultLanguage },
    month,
    throughDay: partial ? today : null,
    overview: overview(bid, from, partial ? today : to),
  };
}

/** Render to a Buffer. `compress: false` keeps the text searchable, for tests. */
export function renderMonthlyReport(data: ReportData, opts: { compress?: boolean; now?: Date } = {}): Promise<Buffer> {
  const lang = data.business.language;
  const w = WORDS[lang];
  const tag = lang === "fr" ? "fr-CA" : "en-CA";
  const num = (n: number) => clean(new Intl.NumberFormat(tag).format(n));
  const pct = (n: number) => clean(new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 }).format(n));
  const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  const duration = (ms: number | null) => {
    if (ms === null) return w["none"]!;
    const unit = (n: number, u: string) => clean(new Intl.NumberFormat(tag, { style: "unit", unit: u, unitDisplay: "short", maximumFractionDigits: 0 }).format(n));
    if (ms < 60_000) return unit(Math.round(ms / 1000), "second");
    if (ms < 3_600_000) return unit(Math.round(ms / 60_000), "minute");
    return `${unit(Math.floor(ms / 3_600_000), "hour")} ${unit(Math.round((ms % 3_600_000) / 60_000), "minute")}`;
  };
  const monthName = clean(new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(Date.parse(`${data.month}-01T12:00:00Z`)));
  const title = monthName.charAt(0).toUpperCase() + monthName.slice(1)
    + (data.throughDay ? ` - ${fill(w["soFar"]!, { day: String(Number(data.throughDay.slice(8))) })}` : "");

  const doc = new PDFDocument({
    size: "A4", margin: 48, compress: opts.compress ?? true,
    info: { Title: `${w["title"]} - ${data.business.name} - ${data.month}`, Author: data.business.name, Creator: "WhatsApp agent dashboard" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const left = 48;
  const width = doc.page.width - 96;
  const o = data.overview;
  const c = o.totals;
  const p = o.previous;

  // --- header
  doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(w["title"]!, left, 48);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(22).text(clean(data.business.name), left, 62, { width });
  doc.fillColor(INK).font("Helvetica").fontSize(14).text(title, left, doc.y + 2);
  const headerBottom = doc.y + 10;
  doc.moveTo(left, headerBottom).lineTo(left + width, headerBottom).lineWidth(1).strokeColor(HAIRLINE).stroke();

  // --- tiles: 3 across, 2 down
  const delta = (now: number | null, before: number | null, goodWhenUp: boolean) => {
    if (now === null || before === null || before === 0) return null;
    const d = (now - before) / before;
    if (Math.abs(d) < 0.005) return null;
    return { text: `${d > 0 ? "+" : "-"}${pct(Math.abs(d))} ${w["vsPrevious"]}`, good: (d > 0) === goodWhenUp };
  };
  const tiles: { label: string; value: string; note?: string; change?: { text: string; good: boolean } | null }[] = [
    { label: w["conversations"]!, value: num(c.conversationsStarted), change: delta(c.conversationsStarted, p.conversationsStarted, true) },
    { label: w["inbound"]!, value: num(c.inbound), change: delta(c.inbound, p.inbound, true) },
    { label: w["aiShare"]!, value: c.aiShare === null ? w["none"]! : pct(c.aiShare),
      note: fill(w["aiShareNote"]!, { ai: num(c.aiReplies), all: num(c.aiReplies + c.humanReplies) }) },
    { label: w["bookings"]!, value: num(c.bookingsMade), note: fill(w["bookingsNote"]!, { n: num(c.bookingsByAgent) }), change: delta(c.bookingsMade, p.bookingsMade, true) },
    { label: w["handoffs"]!, value: num(c.handoffs), note: fill(w["handoffsNote"]!, { n: num(c.takeovers) }) },
    { label: w["response"]!, value: duration(c.responseMedianMs),
      ...(c.responseP90Ms !== null ? { note: fill(w["responseNote"]!, { p90: duration(c.responseP90Ms) }) } : {}),
      change: delta(c.responseMedianMs, p.responseMedianMs, false) },
  ];
  const gap = 10;
  const tileW = (width - gap * 2) / 3;
  const tileH = 74;
  let y = headerBottom + 16;
  tiles.forEach((t, i) => {
    const x = left + (i % 3) * (tileW + gap);
    const ty = y + Math.floor(i / 3) * (tileH + gap);
    doc.roundedRect(x, ty, tileW, tileH, 6).lineWidth(0.75).strokeColor(HAIRLINE).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(t.label, x + 10, ty + 9, { width: tileW - 20 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(t.value, x + 10, ty + 23, { width: tileW - 20 });
    let ny = ty + 47;
    if (t.change) {
      doc.fillColor(t.change.good ? "#006300" : "#d03b3b").font("Helvetica").fontSize(8).text(t.change.text, x + 10, ny, { width: tileW - 20 });
      ny += 11;
    }
    if (t.note) doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(t.note, x + 10, ny, { width: tileW - 20 });
  });
  y += tileH * 2 + gap + 26;

  // --- chart: replies per day, stacked
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(w["replies"]!, left, y);
  // Legend: always present for two series, text in ink beside a colour swatch.
  const legendY = y + 18;
  doc.rect(left, legendY + 1, 8, 8).fill(BLUE);
  doc.fillColor(INK).font("Helvetica").fontSize(9).text(`${w["agent"]}  ${num(c.aiReplies)}`, left + 12, legendY);
  doc.rect(left + 110, legendY + 1, 8, 8).fill(ORANGE);
  doc.fillColor(INK).text(`${w["team"]}  ${num(c.humanReplies)}`, left + 122, legendY);

  const plotTop = legendY + 22;
  const plotH = 150;
  const axisW = 28;
  const plotW = width - axisW;
  const days = o.daily;
  const max = Math.max(1, ...days.map((d) => d.ai + d.human));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => max / s <= 4) ?? Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const yOf = (v: number) => plotTop + plotH - (v / top) * plotH;
  for (let v = 0; v <= top; v += step) {
    doc.moveTo(left + axisW, yOf(v)).lineTo(left + width, yOf(v)).lineWidth(0.5).strokeColor(v === 0 ? "#c4c4cc" : HAIRLINE).stroke();
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(num(v), left, yOf(v) - 3.5, { width: axisW - 6, align: "right" });
  }
  const band = plotW / Math.max(1, days.length);
  const colW = Math.min(12, band * 0.62);
  days.forEach((d, i) => {
    const x = left + axisW + band * i + (band - colW) / 2;
    const aiTop = yOf(d.ai);
    if (d.ai > 0) doc.rect(x, aiTop, colW, yOf(0) - aiTop).fill(BLUE);
    if (d.human > 0) {
      // A 1pt surface gap between the two segments.
      const hTop = yOf(d.ai + d.human);
      doc.rect(x, hTop, colW, Math.max(0.5, aiTop - hTop - (d.ai > 0 ? 1 : 0))).fill(ORANGE);
    }
    if (i === 0 || i === days.length - 1 || ((i + 1) % 5 === 0 && days.length - 1 - i >= 2)) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(7).text(String(Number(d.date.slice(8))), x - 6, plotTop + plotH + 4, { width: colW + 12, align: "center" });
    }
  });
  y = plotTop + plotH + 30;

  // --- appointments by status, and reply times, side by side
  const colGap = 24;
  const half = (width - colGap) / 2;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(w["appointments"]!, left, y);
  doc.text(w["replyTimes"]!, left + half + colGap, y);
  let ry = y + 22;
  const row = (x: number, yy: number, label: string, value: string) => {
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(label, x, yy, { width: half - 70 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(value, x + half - 70, yy, { width: 70, align: "right" });
    doc.moveTo(x, yy + 15).lineTo(x + half, yy + 15).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
  };
  for (const k of ["booked", "confirmed", "completed", "no_show", "cancelled"] as const) {
    row(left, ry, w[k]!, num(o.bookingsByStatus[k]));
    ry += 21;
  }
  let ty2 = y + 22;
  row(left + half + colGap, ty2, w["median"]!, duration(c.responseMedianMs)); ty2 += 21;
  row(left + half + colGap, ty2, w["p90"]!, duration(c.responseP90Ms)); ty2 += 21;
  row(left + half + colGap, ty2, w["unanswered"]!, num(c.unanswered));

  if (c.inbound === 0 && c.bookingsMade === 0) {
    doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(10).text(w["noData"]!, left, ry + 16);
  }

  // --- footer
  const generated = clean(new Intl.DateTimeFormat(tag, { dateStyle: "long", timeZone: data.business.timezone }).format(opts.now ?? new Date()));
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text(`${w["page"]} · ${w["generated"]} ${generated} · ${w["times"]} ${data.business.timezone}`, left, doc.page.height - 64, { width, align: "center", lineBreak: false });

  doc.end();
  return done;
}
