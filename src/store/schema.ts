/**
 * Numbered migrations, tracked in PRAGMA user_version.
 *
 * Every database - fresh or years old - walks the same path from 0 upward, so
 * there is exactly one way a schema comes to exist. Each migration runs in a
 * transaction: it lands completely or not at all, and a failure leaves the
 * previous version intact rather than a half-rebuilt table.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Migration = (db: DatabaseSync) => void;

/** Additive column changes, checked with PRAGMA so a real failure surfaces. */
function addColumns(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r["name"])),
  );
  for (const [name, decl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name) !== undefined;
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>)["n"]);
}

const MIGRATIONS: Migration[] = [
  /**
   * 1 - the single-business schema as it existed before multi-tenancy.
   * Idempotent, so a pre-migration database (user_version 0 but tables
   * present) passes through it unchanged and a fresh one gets created.
   */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, wa_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        type TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', sender_name TEXT,
        ts INTEGER NOT NULL, status TEXT, error TEXT, raw TEXT
      );
      CREATE TABLE IF NOT EXISTS contacts (
        wa_id TEXT PRIMARY KEY, name TEXT, first_seen INTEGER NOT NULL,
        last_inbound_ts INTEGER, last_message_ts INTEGER,
        inbound_count INTEGER NOT NULL DEFAULT 0, outbound_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        level TEXT NOT NULL, name TEXT NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL, name TEXT,
        slot TEXT NOT NULL UNIQUE, party_size INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    addColumns(db, "contacts", {
      paused: "INTEGER NOT NULL DEFAULT 0",
      needs_human: "INTEGER NOT NULL DEFAULT 0",
      handoff_reason: "TEXT",
    });
    addColumns(db, "messages", {
      input_tokens: "INTEGER", output_tokens: "INTEGER",
      cache_read_tokens: "INTEGER", latency_ms: "INTEGER",
    });
  },

  /**
   * 2 - multi-tenancy.
   *
   * Every client-owned table gains business_id, and every existing row is
   * assigned to business #1 so a single-business install carries its history
   * over intact.
   *
   * business_id is NOT NULL with NO default. A default would be a trap: any
   * future insert that forgot to pass it would silently file one client's data
   * under another's. Without one, that insert fails loudly instead. SQLite
   * cannot add such a column in place, so the affected tables are rebuilt.
   */
  (db) => {
    const now = Date.now();

    db.exec(`
      CREATE TABLE businesses (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id              TEXT NOT NULL UNIQUE,
        name                   TEXT NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','inactive')),
        timezone               TEXT NOT NULL DEFAULT 'America/Toronto',
        default_language       TEXT NOT NULL DEFAULT 'en'
                               CHECK (default_language IN ('en','fr')),
        wa_phone_number_id     TEXT UNIQUE,
        wa_business_account_id TEXT,
        wa_access_token_enc    TEXT,
        wa_app_secret_enc      TEXT,
        wa_verify_token_enc    TEXT,
        graph_version          TEXT NOT NULL DEFAULT 'v23.0',
        created_at             INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL
      );

      -- facts: what the agent may say (feeds the system prompt).
      -- schedule: when it may book, per weekday. Structured, because a
      -- booking check cannot parse "Monday to Friday, 8am to 3pm".
      CREATE TABLE business_settings (
        business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
        facts       TEXT NOT NULL,
        schedule    TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);

    // Unguessable, because it appears in the client's webhook URL.
    db.prepare(`
      INSERT INTO businesses (id, public_id, name, created_at, updated_at)
      VALUES (1, ?, 'Default business', ?, ?)
    `).run(crypto.randomBytes(9).toString("base64url"), now, now);

    // messages - rowid order IS conversation order (see queries.ts), so the
    // copy must preserve it; a rebuild without ORDER BY rowid would scramble
    // every transcript's history.
    db.exec(`
      CREATE TABLE messages_v2 (
        id                TEXT PRIMARY KEY,
        business_id       INTEGER NOT NULL REFERENCES businesses(id),
        wa_id             TEXT NOT NULL,
        direction         TEXT NOT NULL CHECK (direction IN ('in','out')),
        type              TEXT NOT NULL,
        text              TEXT NOT NULL DEFAULT '',
        sender_name       TEXT,
        ts                INTEGER NOT NULL,
        status            TEXT,
        error             TEXT,
        raw               TEXT,
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        cache_read_tokens INTEGER,
        latency_ms        INTEGER
      );
      INSERT INTO messages_v2 (id, business_id, wa_id, direction, type, text, sender_name,
                               ts, status, error, raw, input_tokens, output_tokens,
                               cache_read_tokens, latency_ms)
        SELECT id, 1, wa_id, direction, type, text, sender_name, ts, status, error, raw,
               input_tokens, output_tokens, cache_read_tokens, latency_ms
        FROM messages ORDER BY rowid;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      CREATE INDEX messages_by_convo    ON messages (business_id, wa_id);
      CREATE INDEX messages_by_business ON messages (business_id, ts DESC);
    `);

    // contacts - keyed per business: one customer texting two of your
    // clients is two separate relationships, not one shared record.
    db.exec(`
      CREATE TABLE contacts_v2 (
        business_id     INTEGER NOT NULL REFERENCES businesses(id),
        wa_id           TEXT NOT NULL,
        name            TEXT,
        first_seen      INTEGER NOT NULL,
        last_inbound_ts INTEGER,
        last_message_ts INTEGER,
        inbound_count   INTEGER NOT NULL DEFAULT 0,
        outbound_count  INTEGER NOT NULL DEFAULT 0,
        paused          INTEGER NOT NULL DEFAULT 0,
        needs_human     INTEGER NOT NULL DEFAULT 0,
        handoff_reason  TEXT,
        PRIMARY KEY (business_id, wa_id)
      );
      INSERT INTO contacts_v2
        SELECT 1, wa_id, name, first_seen, last_inbound_ts, last_message_ts,
               inbound_count, outbound_count, paused, needs_human, handoff_reason
        FROM contacts;
      DROP TABLE contacts;
      ALTER TABLE contacts_v2 RENAME TO contacts;
    `);

    // settings - the kill switch was global; it is per client now.
    db.exec(`
      CREATE TABLE settings_v2 (
        business_id INTEGER NOT NULL REFERENCES businesses(id),
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        PRIMARY KEY (business_id, key)
      );
      INSERT INTO settings_v2 SELECT 1, key, value FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_v2 RENAME TO settings;
    `);

    // events - business_id is nullable here, and only here: some events
    // (a bad signature on an unknown URL) happen before any business is known.
    db.exec(`
      CREATE TABLE events_v2 (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER REFERENCES businesses(id),
        ts          INTEGER NOT NULL,
        level       TEXT NOT NULL,
        name        TEXT NOT NULL,
        detail      TEXT
      );
      INSERT INTO events_v2 (business_id, ts, level, name, detail)
        SELECT 1, ts, level, name, detail FROM events ORDER BY id;
      DROP TABLE events;
      ALTER TABLE events_v2 RENAME TO events;
      CREATE INDEX events_by_business ON events (business_id, ts DESC);
    `);

    // bookings - a slot was unique across everyone, so two clients could not
    // both take 10:00. Unique per business now. (Reworked fully in step 6.)
    db.exec(`
      CREATE TABLE bookings_v2 (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id INTEGER NOT NULL REFERENCES businesses(id),
        wa_id       TEXT NOT NULL,
        name        TEXT,
        slot        TEXT NOT NULL,
        party_size  INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL,
        UNIQUE (business_id, slot)
      );
      INSERT INTO bookings_v2 (business_id, wa_id, name, slot, party_size, created_at)
        SELECT 1, wa_id, name, slot, party_size, created_at FROM bookings ORDER BY id;
      DROP TABLE bookings;
      ALTER TABLE bookings_v2 RENAME TO bookings;
    `);

    // orders - out of scope by decision. Dropped only when empty; any real
    // rows are set aside rather than destroyed.
    if (tableExists(db, "orders")) {
      if (rowCount(db, "orders") === 0) db.exec(`DROP TABLE orders`);
      else db.exec(`ALTER TABLE orders RENAME TO orders_legacy`);
    }
  },

  /**
   * 3 - people who log in, their sessions, and an audit trail.
   *
   * A super admin sees every business, so has no business_id; an owner has
   * exactly one. The CHECK makes any other pairing impossible rather than
   * merely unlikely - an owner row with no business would otherwise be read
   * as "unrestricted" by any code that forgot to look at the role.
   *
   * Sessions store only a SHA-256 of the token. The token itself lives in the
   * browser cookie, so a copy of the database yields no usable sessions.
   *
   * The audit log is append-only by convention and deliberately separate
   * from `events` (which is operational noise): it answers "who saw or
   * changed what, when" - the question a Law 25 confidentiality incident
   * register has to be able to answer.
   */
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash        TEXT NOT NULL,
        role                 TEXT NOT NULL CHECK (role IN ('super_admin','owner')),
        business_id          INTEGER REFERENCES businesses(id),
        name                 TEXT,
        locale               TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','fr')),
        active               INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at           INTEGER NOT NULL,
        last_login_at        INTEGER,
        CHECK ((role = 'super_admin' AND business_id IS NULL) OR
               (role = 'owner'       AND business_id IS NOT NULL))
      );
      CREATE INDEX users_by_business ON users (business_id);

      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        ip           TEXT,
        user_agent   TEXT
      );
      CREATE INDEX sessions_by_user ON sessions (user_id);

      CREATE TABLE audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        user_id     INTEGER REFERENCES users(id),
        business_id INTEGER REFERENCES businesses(id),
        action      TEXT NOT NULL,
        target      TEXT,
        detail      TEXT,
        ip          TEXT
      );
      CREATE INDEX audit_by_business ON audit_log (business_id, ts DESC);
      CREATE INDEX audit_by_user     ON audit_log (user_id, ts DESC);
    `);
  },

  /**
   * 4 - services, and agent settings v2.
   *
   * Services get a table so bookings can reference a stable id. The settings
   * JSON moves from the old "facts" shape to v2 in place. Two rules matter:
   * placeholders like "<not configured>" or "Not provided yet - ..." become
   * empty fields rather than surviving as text the agent might quote, and the
   * old free-text hours are dropped - hours now come only from the schedule,
   * so a sentence and a schedule can never disagree again.
   *
   * Self-contained on purpose: a migration must not import app code whose
   * shape will keep changing after the migration is written.
   */
  (db) => {
    db.exec(`
      CREATE TABLE services (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        business_id  INTEGER NOT NULL REFERENCES businesses(id),
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        duration_min INTEGER NOT NULL CHECK (duration_min > 0),
        price_cents  INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
        currency     TEXT NOT NULL DEFAULT 'CAD',
        active       INTEGER NOT NULL DEFAULT 1,
        sort         INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX services_by_business ON services (business_id, active, sort);
    `);

    const placeholder = (v: unknown) =>
      typeof v !== "string" || v.trim() === "" || v.trim().startsWith("<") || /^not provided/i.test(v.trim());
    const clean = (v: unknown) => (placeholder(v) ? "" : String(v).trim());

    const rows = db.prepare(`
      SELECT s.business_id, s.facts, b.default_language
      FROM business_settings s JOIN businesses b ON b.id = s.business_id
    `).all() as { business_id: number; facts: string; default_language: string }[];
    const update = db.prepare(`UPDATE business_settings SET facts = ? WHERE business_id = ?`);

    for (const r of rows) {
      const v1 = JSON.parse(r.facts) as Record<string, unknown>;
      if (v1["version"] === 2) continue;
      const neverDo = Array.isArray(v1["neverDo"])
        ? (v1["neverDo"] as unknown[]).map(String).filter((x) => !/\border\b/i.test(x)) // orders are gone
        : [];
      const v2 = {
        about: clean(v1["what"]),
        address: clean(v1["address"]),
        contact: clean(v1["contact"]),
        tone: "friendly",
        customToneNotes: "",
        languages: [r.default_language === "fr" ? "fr" : "en"],
        faqs: [],
        handoff: { keywords: [], onAnger: true, onAccountChange: true, rules: "" },
        neverDo: neverDo.length ? neverDo : [
          "promise a refund, discount, or delivery date",
          "quote a price that is not listed in the services",
        ],
        reminders: { enabled: false, hoursBefore: 24, templateName: "appointment_reminder", templateLanguage: "en" },
      };
      update.run(JSON.stringify(v2), r.business_id);
    }
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings `db` up to the current version. Returns the versions applied. */
export function migrate(db: DatabaseSync): number[] {
  const current = Number(
    (db.prepare("PRAGMA user_version").get() as Record<string, unknown>)["user_version"],
  );
  const applied: number[] = [];

  // Off while tables are rebuilt (SQLite's documented procedure), back on
  // afterwards so business_id references are enforced for every write.
  db.exec("PRAGMA foreign_keys = OFF");

  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      MIGRATIONS[version - 1]!(db);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
      applied.push(version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${version} failed and was rolled back: ${String(err)}`);
    }
  }

  db.exec("PRAGMA foreign_keys = ON");
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`Foreign key violations after migration: ${JSON.stringify(violations)}`);
  }
  return applied;
}
