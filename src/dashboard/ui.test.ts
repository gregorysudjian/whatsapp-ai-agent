/**
 * The dashboard is inline HTML/CSS/JS with no build step, so nothing else
 * would catch a syntax error before it reached a browser as a blank page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const uiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");
const html = fs.readFileSync(uiPath, "utf8");

function inlineScript(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "ui.html must contain an inline script");
  return match[1]!;
}

test("the inline script parses", () => {
  // Compiling without running is enough: a syntax error here ships a page
  // that renders its shell and then does nothing at all.
  assert.doesNotThrow(
    () => new vm.Script(inlineScript(), { filename: "ui.html" }),
    "syntax error in the dashboard script",
  );
});

test("hidden elements stay hidden", () => {
  // `.banner { display: flex }` outranks the UA's `[hidden] { display: none }`,
  // which pinned both banners permanently open.
  assert.match(
    html, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "a [hidden] override is required whenever a class sets display on a hideable element",
  );
});

test("elements toggled by script are actually hideable", () => {
  const toggled = [...html.matchAll(/\$\("(\w+)"\)\.hidden\s*=/g)].map((m) => m[1]!);
  assert.ok(toggled.length > 0, "expected some elements to be toggled via .hidden");
  for (const id of toggled) {
    assert.match(html, new RegExp(`id="${id}"[^>]*`), `#${id} must exist in the markup`);
  }
});

test("the page cannot scroll sideways", () => {
  assert.match(html, /overflow-x:\s*hidden/, "body must not scroll horizontally");
  assert.match(html, /main\s*>\s*\*\s*\{[^}]*min-width:\s*0/,
    "grid children need min-width:0 or long ids force the page wider than the viewport");
});
