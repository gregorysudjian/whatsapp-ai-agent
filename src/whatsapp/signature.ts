import crypto from "node:crypto";
import { config } from "../config.ts";

/**
 * Meta signs every webhook POST with HMAC-SHA256 over the *raw* body.
 * Without this check anyone who learns your URL can puppet the bot.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;

  const expected = crypto
    .createHmac("sha256", config.whatsapp.appSecret)
    .update(rawBody)
    .digest("hex");

  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
