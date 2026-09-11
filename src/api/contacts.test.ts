/**
 * Contacts and their CSV export: only this business's people, opened safely
 * in a spreadsheet (no formula runs from a customer-chosen name), accented
 * and Arabic names intact, and the export audited.
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
import { csvCell, toCsv } from "./csv.ts";

let A: number;
let B: number;
let owner: TestUser;
let server: Server;
let base: string;

const insertContact = db.prepare(`
  INSERT INTO contacts (business_id, wa_id, name, first_seen, last_message_ts, inbound_count, outbound_count, control)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBooking = db.prepare(`
  INSERT INTO bookings (business_id, wa_id, start_at, end_at, duration_min, status, created_at, updated_at)
  VALUES (?, ?, '2030-01-01T10:00', '2030-01-01T11:00', 60, ?, 1, 1)
`);

before(async () => {
  A = createBusiness({ name: "Contacts Co", defaultLanguage: "fr", timezone: "America/Montreal" }).id;
  B = createBusiness({ name: "Contacts Neighbour" }).id;
  const t0 = Date.parse("2030-01-01T15:00:00Z");
  insertContact.run(A, "15145550001", "Chloé Tremblay", t0, t0 + 5_000, 3, 2, "ai");
  insertContact.run(A, "15145550002", '=HYPERLINK("http://evil.example","Click me")', t0 + 1, t0 + 9_000, 1, 1, "ai");
  insertContact.run(A, "96170000003", "ليلى نصار", t0 + 2, t0 + 1_000, 7, 6, "human");
  insertContact.run(A, "15145550004", 'Sam "The Man", Jr.', t0 + 3, null, 0, 0, "ai");
  insertContact.run(B, "15145550009", "Neighbour's Customer", t0, t0, 1, 1, "ai");
  insertBooking.run(A, "15145550001", "booked");
  insertBooking.run(A, "15145550001", "completed");
  insertBooking.run(A, "15145550001", "cancelled");
  insertBooking.run(B, "15145550001", "booked"); // same number, other business: not A's booking

  owner = await makeUser("owner", A);
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise((r) => server.close(r)); });

test("cells that would run as formulas are defused; quotes and commas survive", () => {
  for (const evil of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) {
    assert.ok(csvCell(evil).replace(/^"/, "").startsWith("'"), `${JSON.stringify(evil)} must not start a formula`);
  }
  assert.equal(csvCell("Chloé"), "Chloé");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(12), "12");
});

test("the file starts with a BOM and uses CRLF", () => {
  const csv = toCsv(["a", "b"], [["1", "2"]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv, "﻿a,b\r\n1,2\r\n");
});

test("the list is this business's contacts, with their bookings counted", async () => {
  const res = await call(base, `/api/b/${A}/contacts`, { cookie: owner.cookie });
  assert.equal(res.status, 200);
  const list = res.json["contacts"] as Record<string, unknown>[];
  assert.equal(list.length, 4);
  assert.ok(!list.some((c) => c["name"] === "Neighbour's Customer"));
  const chloe = list.find((c) => c["waId"] === "15145550001")!;
  assert.equal(chloe["bookings"], 2, "cancelled bookings and the neighbour's booking are not counted");
  assert.equal(list[0]!["waId"], "15145550002", "most recent message first by default");
});

test("search and sort", async () => {
  const q = await call(base, `/api/b/${A}/contacts?q=${encodeURIComponent("chloé")}`, { cookie: owner.cookie });
  assert.deepEqual((q.json["contacts"] as Record<string, unknown>[]).map((c) => c["waId"]), ["15145550001"]);
  const byMessages = await call(base, `/api/b/${A}/contacts?sort=messages`, { cookie: owner.cookie });
  assert.equal((byMessages.json["contacts"] as Record<string, unknown>[])[0]!["waId"], "96170000003");
  const bad = await call(base, `/api/b/${A}/contacts?sort=${encodeURIComponent("name; DROP TABLE contacts")}`, { cookie: owner.cookie });
  assert.equal(bad.status, 400, "the sort order is a fixed list, never SQL from the request");
});

test("the export is safe to open, in the business's language, and only its own rows", async () => {
  const res = await fetch(`${base}/api/b/${A}/contacts.csv`, { headers: { cookie: owner.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="contacts-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 byte-order mark");
  // TextDecoder drops the BOM itself (its presence was checked on the bytes).
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\r\n");
  assert.equal(lines[0], "Nom,Numéro WhatsApp,Premier contact,Dernier message,Messages reçus,Messages envoyés,Rendez-vous,Pris en charge par");
  assert.equal(lines.filter(Boolean).length, 5, "a header and four contacts");
  assert.ok(!text.includes("Neighbour"), "nothing from another business");
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil.example"",""Click me"")"`), "the formula is defused");
  assert.ok(text.includes("ليلى نصار") && text.includes("Chloé Tremblay"));
  assert.ok(text.includes('"Sam ""The Man"", Jr."'));
  assert.ok(text.includes("2030-01-01 10:00"), "times in the business's zone (Montreal), 15:00 UTC = 10:00");
  assert.ok(text.includes(",Une personne"));

  const en = await fetch(`${base}/api/b/${A}/contacts.csv?lang=en`, { headers: { cookie: owner.cookie } });
  assert.match(await en.text(), /^Name,WhatsApp number/);
});

test("an export is audited, and another business's export is refused", async () => {
  assert.ok(listAudit(A).some((r) => r.action === "contacts_exported" && r.userId === owner.user.id));
  const other = await fetch(`${base}/api/b/${B}/contacts.csv`, { headers: { cookie: owner.cookie } });
  assert.equal(other.status, 404);
});
