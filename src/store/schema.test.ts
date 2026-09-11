/**
 * The upgrade path from a single-business database - the shape every
 * existing install has - to the multi-tenant schema. Runs against its own
 * temporary files, never the suite's shared database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate, SCHEMA_VERSION } from "./schema.ts";

function tempDb(): { db: DatabaseSync; file: string } {
  const file = path.join(os.tmpdir(), `schema-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  return { db: new DatabaseSync(file), file };
}

/** A database exactly as the pre-migration code left it, with history in it. */
function legacyDatabase(): { db: DatabaseSync; file: string } {
  const t = tempDb();
  t.db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, wa_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')), type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', sender_name TEXT, ts INTEGER NOT NULL,
      status TEXT, error TEXT, raw TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, latency_ms INTEGER);
    CREATE TABLE contacts (wa_id TEXT PRIMARY KEY, name TEXT, first_seen INTEGER NOT NULL,
      last_inbound_ts INTEGER, last_message_ts INTEGER,
      inbound_count INTEGER NOT NULL DEFAULT 0, outbound_count INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0, needs_human INTEGER NOT NULL DEFAULT 0, handoff_reason TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      level TEXT NOT NULL, name TEXT NOT NULL, detail TEXT);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL, name TEXT,
      slot TEXT NOT NULL UNIQUE, party_size INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, phone TEXT NOT NULL, status TEXT NOT NULL,
      item TEXT NOT NULL, placed_at INTEGER NOT NULL, eta TEXT);

    -- Deliberately inserted with timestamps out of order: history is ordered
    -- by rowid, so the rebuild must preserve insertion order, not sort by ts.
    INSERT INTO messages (id, wa_id, direction, type, text, ts) VALUES
      ('w1', '1555', 'in',  'text', 'hello',        300),
      ('w2', '1555', 'out', 'text', 'hi there',     100),
      ('w3', '1555', 'in',  'text', 'are you open', 200);
    INSERT INTO contacts (wa_id, name, first_seen, paused, needs_human, handoff_reason)
      VALUES ('1555', 'Sam', 1, 1, 1, 'asked for a person');
    INSERT INTO settings VALUES ('agent_enabled', '0');
    INSERT INTO events (ts, level, name) VALUES (1, 'info', 'webhook_verified');
    INSERT INTO bookings (wa_id, name, slot, created_at) VALUES ('1555', 'Sam', '2030-01-02T10:00', 1);
  `);
  return t;
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

test("a legacy database upgrades with every row kept and assigned to business 1", () => {
  const { db, file } = legacyDatabase();
  try {
    assert.deepEqual(migrate(db), [1, 2]);

    for (const table of ["messages", "contacts", "settings", "events", "bookings"]) {
      const rows = all(db, `SELECT business_id FROM ${table}`);
      assert.ok(rows.length > 0, `${table} lost its rows`);
      assert.ok(rows.every((r) => r["business_id"] === 1), `${table} rows must belong to business 1`);
    }

    const contact = all(db, `SELECT * FROM contacts`)[0]!;
    assert.equal(contact["name"], "Sam");
    assert.equal(contact["handoff_reason"], "asked for a person", "handoff state must survive");

    assert.equal(all(db, `SELECT value FROM settings WHERE key='agent_enabled'`)[0]?.["value"], "0",
      "an agent switched off must stay off after the upgrade");
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test("conversation order survives the table rebuild", () => {
  const { db, file } = legacyDatabase();
  try {
    migrate(db);
    assert.deepEqual(
      all(db, `SELECT id FROM messages ORDER BY rowid`).map((r) => r["id"]),
      ["w1", "w2", "w3"],
      "rowid order is conversation order; sorting by ts here would scramble transcripts",
    );
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test("an empty orders table is dropped; one with data is set aside, never destroyed", () => {
  const empty = legacyDatabase();
  const withData = legacyDatabase();
  try {
    migrate(empty.db);
    assert.equal(all(empty.db, `SELECT name FROM sqlite_master WHERE name LIKE 'orders%'`).length, 0);

    withData.db.exec(`INSERT INTO orders VALUES ('A1', '1555', 'shipped', 'widget', 1, NULL)`);
    migrate(withData.db);
    assert.deepEqual(
      all(withData.db, `SELECT id FROM orders_legacy`).map((r) => r["id"]), ["A1"],
      "real order rows must be preserved under a new name",
    );
  } finally {
    empty.db.close(); withData.db.close();
    fs.rmSync(empty.file, { force: true }); fs.rmSync(withData.file, { force: true });
  }
});

test("migrating twice is a no-op", () => {
  const { db, file } = legacyDatabase();
  try {
    migrate(db);
    assert.deepEqual(migrate(db), []);
    assert.equal(
      (db.prepare("PRAGMA user_version").get() as Record<string, unknown>)["user_version"],
      SCHEMA_VERSION,
    );
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});

test("a fresh database arrives at the same schema as an upgraded one", () => {
  const fresh = tempDb();
  const legacy = legacyDatabase();
  try {
    migrate(fresh.db);
    migrate(legacy.db);
    const shape = (db: DatabaseSync) => all(db,
      `SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((r) => `${r["name"]}: ${String(r["sql"]).replace(/\s+/g, " ")}`);
    assert.deepEqual(shape(fresh.db), shape(legacy.db), "one path to one schema");
  } finally {
    fresh.db.close(); legacy.db.close();
    fs.rmSync(fresh.file, { force: true }); fs.rmSync(legacy.file, { force: true });
  }
});

test("after migration, a row without a business is refused", () => {
  const { db, file } = legacyDatabase();
  try {
    migrate(db);
    assert.throws(
      () => db.prepare(`INSERT INTO contacts (wa_id, first_seen) VALUES ('x', 1)`).run(),
      /NOT NULL/,
    );
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
});
