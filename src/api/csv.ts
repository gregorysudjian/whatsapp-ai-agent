/**
 * CSV for spreadsheets - Excel in particular, which is where an owner will
 * open it.
 *
 * - UTF-8 with a byte-order mark, or Excel reads "Chloé" as "ChloÃ©" and
 *   Arabic as noise.
 * - CRLF line ends (RFC 4180).
 * - Formula injection: a cell starting with = + - @ (or a tab or carriage
 *   return) is run as a formula when the file is opened. Customer names come
 *   from WhatsApp profiles - anyone can name themselves
 *   `=HYPERLINK("http://evil","Click")` - so such cells get a leading
 *   apostrophe, which spreadsheets show as plain text.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
