/**
 * The monthly PDF: a real PDF, the right month's numbers, in the business's
 * language, for its owner only.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.ts";
import { call, makeUser, type TestUser } from "../testing/auth.ts";
import { createBusiness } from "../store/businesses.ts";
import { db } from "../store/db.ts";
import { listAudit } from "../store/audit.ts";
import { renderMonthlyReport, reportData } from "./monthly.ts";

let FR: number;
let EN: number;
let owner: TestUser;
let server: Server;
let base: string;

const insert = db.prepare(`INSERT INTO messages (id, business_id, wa_id, direction, type, text, ts, sender) VALUES (?, ?, ?, ?, 'text', 'x', ?, ?)`);
let n = 0;
function traffic(bid: number, month: string, inbound: number) {
  for (let i = 0; i < inbound; i++) {
    const t = Date.parse(`${month}-10T12:00:00Z`) + i * 3_600_000;
    insert.run(`rep-${bid}-${++n}`, bid, `1514555${String(i).padStart(4, "0")}`, "in", t, "customer");
    insert.run(`rep-${bid}-${++n}`, bid, `1514555${String(i).padStart(4, "0")}`, "out", t + 90_000, i % 4 === 0 ? "human" : "ai");
  }
}

/**
 * The page's text. pdfkit writes each run as hex strings inside a TJ array,
 * split wherever kerning applies, so the pieces are decoded and joined per
 * run (Helvetica's encoding matches Latin-1 for the accents used here).
 */
function pdfText(pdf: Buffer): string[] {
  const src = pdf.toString("latin1");
  return [...src.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) =>
    [...m[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, "hex").toString("latin1")).join(""),
  );
}

before(async () => {
  FR = createBusiness({ name: "Rapport Clinique", defaultLanguage: "fr", timezone: "America/Montreal" }).id;
  EN = createBusiness({ name: "Report Studio", defaultLanguage: "en", timezone: "America/Toronto" }).id;
  traffic(FR, "2030-01", 8);
  traffic(FR, "2030-02", 3); // another month: must not be counted
  traffic(EN, "2030-01", 5);
  owner = await makeUser("owner", FR);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise((r) => server.close(r)); });

test("a real PDF, in French for a French business, with that month's numbers", async () => {
  const data = reportData(FR, "2030-01");
  assert.equal(data.overview.totals.inbound, 8, "January only");
  assert.equal(data.overview.range.days, 31);
  const pdf = await renderMonthlyReport(data, { compress: false, now: new Date("2030-02-01T12:00:00Z") });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.subarray(-6).toString(), /%%EOF/);
  const text = pdfText(pdf);
  const has = (s: string) => text.some((t) => t.includes(s));
  for (const s of ["Rapport mensuel", "Rapport Clinique", "Janvier 2030", "Messages reçus", "Répondu par l'agent", "Rendez-vous du mois", "Délais de réponse"]) {
    assert.ok(has(s), `missing "${s}" in ${JSON.stringify(text.slice(0, 12))}`);
  }
  assert.ok(text.includes("8"), "the inbound count");
  assert.ok(has("75\u00a0%"), "6 of 8 replies by the agent, written the French way (a no-break space before %)");
  assert.ok(!has("Messages received"), "no English on a French report");
});

test("English for an English business", async () => {
  const text = pdfText(await renderMonthlyReport(reportData(EN, "2030-01"), { compress: false }));
  assert.ok(text.some((t) => t.includes("Monthly report")));
  assert.ok(text.some((t) => t.includes("January 2030")));
  assert.ok(text.some((t) => t.includes("Messages received")));
});

test("an empty month still renders, and says so", async () => {
  const text = pdfText(await renderMonthlyReport(reportData(EN, "2031-05"), { compress: false }));
  assert.ok(text.some((t) => t.includes("No activity this month.")));
});

test("the download is a PDF for the owner, audited, and nobody else's", async () => {
  const res = await fetch(`${base}/api/b/${FR}/reports/monthly?month=2030-01`, { headers: { cookie: owner.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="rapport-clinique-2030-01.pdf"');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.ok(listAudit(FR).some((r) => r.action === "report_downloaded" && r.target === "2030-01"));

  assert.equal((await call(base, `/api/b/${FR}/reports/monthly?month=2030-13`, { cookie: owner.cookie })).status, 400);
  assert.equal((await call(base, `/api/b/${EN}/reports/monthly?month=2030-01`, { cookie: owner.cookie })).status, 404);

  const months = await call(base, `/api/b/${FR}/reports`, { cookie: owner.cookie });
  const list = months.json["months"] as string[];
  assert.equal(list[0], months.json["current"], "newest first");
  assert.deepEqual(list, [...list].sort().reverse(), "one entry per month, newest first");
  assert.ok(list.every((m) => /^\d{4}-\d{2}$/.test(m) && m <= String(months.json["current"])));
});

test("the month in progress is reported to date, and says so", async () => {
  const now = Date.parse("2030-01-11T15:00:00Z"); // Jan 11, 10:00 in Montreal
  const data = reportData(FR, "2030-01", now);
  assert.equal(data.throughDay, "2030-01-11");
  assert.equal(data.overview.range.to, "2030-01-11");
  assert.equal(data.overview.range.days, 11, "compared with the 11 days before, not a whole month");
  const text = pdfText(await renderMonthlyReport(data, { compress: false }));
  assert.ok(text.some((t) => t.includes("Janvier 2030 - en cours (du 1er au 11)")), JSON.stringify(text.slice(0, 5)));
  assert.equal(reportData(FR, "2029-12", now).throughDay, null, "a finished month is whole");
});
