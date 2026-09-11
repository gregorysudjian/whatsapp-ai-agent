/**
 * No invisible characters in source code. A raw byte-order mark, no-break
 * space or zero-width space works exactly like its \u escape - and is
 * impossible to see in review, which is how one slipped in once. Write the
 * escape instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const INVISIBLE = /[\uFEFF\u202F\u2009\u00A0\u200B\u200C\u200D\u2060]/;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("no raw invisible characters in the source", () => {
  const offenders: string[] = [];
  for (const file of [...sources("src"), ...sources("web/src")]) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (INVISIBLE.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "write these as unicode escapes (backslash-u), not raw characters");
});
