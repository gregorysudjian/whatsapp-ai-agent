/**
 * A consistent copy of the database, taken while the server runs:
 *
 *   npm run backup                      (or, in Docker: node dist/cli/backup.js)
 *
 * Written next to the database as backups/agent-<timestamp>.db. VACUUM INTO
 * copies a snapshot through SQLite itself, so a write in progress can't tear
 * the copy - unlike copying the file. Copy the result off the server, and
 * keep APP_ENCRYPTION_KEY backed up separately: the stored credentials are
 * encrypted with it.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.env["DB_PATH"]?.trim() || "./data/agent.db";
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(1);
}
const dir = path.join(path.dirname(dbPath), "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const out = path.join(dir, `agent-${stamp}.db`);
const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`Backed up to ${out} (${fs.statSync(out).size} bytes).`);
