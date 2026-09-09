/**
 * Send a signed, Meta-shaped webhook at a locally running agent.
 *
 *   npm run fake-webhook -- "are you open today?"
 *   npm run fake-webhook -- "hello" --from 15145551234 --port 3001
 *
 * Signed with the real WHATSAPP_APP_SECRET, so the signature check runs for
 * real. Lets you hold a whole conversation with the bot without a phone, a
 * tunnel, or Meta ever being involved.
 */

import { textMessagePayload, deliver } from "./webhook.ts";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const text = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];

if (!text) {
  console.error('Usage: npm run fake-webhook -- "your message" [--from <number>] [--port <port>]');
  process.exit(1);
}

const from = flag("from", "15550001111");
const port = flag("port", String(process.env["PORT"] ?? 3000));
const baseUrl = `http://localhost:${port}`;

const payload = textMessagePayload(text, { from, name: flag("name", "Test User") });
const result = await deliver(baseUrl, payload);

console.log(`-> POST ${baseUrl}/webhook  (from ${from})`);
console.log(`<- ${result.status} ${result.text}`);
console.log(
  result.status === 200
    ? "Delivered. Watch the server log or the dashboard for the reply."
    : "Rejected - check WHATSAPP_APP_SECRET matches the running server.",
);
