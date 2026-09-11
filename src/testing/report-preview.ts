/**
 * Renders the monthly report on the screenshot database's demo data and
 * photographs it, so its layout can be checked by eye:
 *
 *   node --env-file=.env.test src/testing/report-preview.ts <outDir> [en|fr]
 *
 * Run `npm run shots` first (it builds data/shots.db). Never touches the live database.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env["DB_PATH"] = "./data/shots.db";
if (!fs.existsSync("data/shots.db")) {
  console.error("No data/shots.db - run `npm run shots -- <dir> overview` first.");
  process.exit(1);
}

const { renderMonthlyReport, reportData } = await import("../reports/monthly.ts");
const { DEFAULT_BUSINESS_ID } = await import("../store/businesses.ts");
const { launchBrowser } = await import("./screenshot.ts");

const [outDir = ".", lang = "en"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const month = new Date().toISOString().slice(0, 7);
const data = reportData(DEFAULT_BUSINESS_ID, month);
data.business.language = lang === "fr" ? "fr" : "en";
const pdfPath = path.resolve(outDir, `report-${lang}.pdf`);
fs.writeFileSync(pdfPath, await renderMonthlyReport(data));
console.log(pdfPath);

const browser = await launchBrowser();
try {
  const out = path.join(outDir, `report-${lang}.png`);
  await browser.shoot({ url: pathToFileURL(pdfPath).href, out, width: 900, height: 1200, dark: false, locale: lang === "fr" ? "fr" : "en", mobile: false });
  console.log(out);
} finally {
  await browser.close();
}
process.exit(0);
