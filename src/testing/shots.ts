/**
 * Screenshot runner for visual checks.
 *
 *   npm run shots -- <outDir> [page ...]
 *
 * Boots the real app in-process on its OWN database (data/shots.db, wiped
 * each run) with .env.test's fake credentials - never the live database, and
 * never anything that can send a real message - seeds demo data, then shoots
 * each page at desktop and phone widths, light and dark, English and French.
 *
 * Pages are named: login, welcome, overview, admin-overview, placeholder, notfound
 * (later steps add their own). Default: all of them.
 */

import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { launchBrowser } from "./screenshot.ts";

// Set before any app module loads (they are imported dynamically below):
// the database is opened at import time, and this run must never touch the
// live one. Wiped every run so the pictures are reproducible.
process.env["DB_PATH"] = "./data/shots.db";
for (const f of ["data/shots.db", "data/shots.db-wal", "data/shots.db-shm"]) fs.rmSync(f, { force: true });

const { createApp } = await import("../app.ts");
const { seedDefaultBusiness, createBusiness, DEFAULT_BUSINESS_ID } = await import("../store/businesses.ts");
const { seedDemoData } = await import("./demo-data.ts");
const { makeUser } = await import("./auth.ts");

const [outDir, ...wanted] = process.argv.slice(2);
if (!outDir) {
  console.error("Usage: npm run shots -- <outDir> [page ...]");
  process.exit(1);
}

seedDefaultBusiness();
const other = createBusiness({ name: "Clinique Beauséjour", defaultLanguage: "fr" });
seedDemoData(DEFAULT_BUSINESS_ID);
const owner = await makeUser("owner", DEFAULT_BUSINESS_ID);
const admin = await makeUser("super_admin");
const newcomer = await makeUser("owner", DEFAULT_BUSINESS_ID, { mustChangePassword: true });

const server = createApp().listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

interface Page { name: string; path: string; cookie?: string; fullPage?: boolean }
const B = DEFAULT_BUSINESS_ID;
const pages: Page[] = [
  { name: "login", path: "/login" },
  { name: "welcome", path: "/welcome", cookie: newcomer.cookie },
  { name: "overview", path: `/b/${B}/overview`, cookie: owner.cookie },
  { name: "admin-overview", path: `/b/${other.id}/overview`, cookie: admin.cookie },
  { name: "placeholder", path: `/b/${B}/reports`, cookie: owner.cookie },
  { name: "notfound", path: `/b/${other.id}/overview`, cookie: owner.cookie },
  ...(((await import("./shots-pages.ts")).extraPages(B, owner.cookie, admin.cookie)) as Page[]),
];

const selected = wanted.length ? pages.filter((p) => wanted.includes(p.name)) : pages;
const variants = [
  { tag: "desktop-light-en", width: 1440, height: 900, dark: false, locale: "en" as const },
  { tag: "desktop-dark-fr", width: 1440, height: 900, dark: true, locale: "fr" as const },
  { tag: "phone-light-fr", width: 390, height: 844, dark: false, locale: "fr" as const, mobile: true },
  { tag: "phone-dark-en", width: 390, height: 844, dark: true, locale: "en" as const, mobile: true },
];

const browser = await launchBrowser();
try {
  for (const page of selected) {
    for (const v of variants) {
      const out = path.join(outDir, `${page.name}--${v.tag}.png`);
      await browser.shoot({
        url: `${base}${page.path}`, out, width: v.width, height: v.height,
        dark: v.dark, locale: v.locale, mobile: v.mobile ?? false,
        ...(page.cookie ? { cookie: page.cookie } : {}),
        ...(page.fullPage ? { fullPage: true } : {}),
      });
      console.log(out);
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(0);
