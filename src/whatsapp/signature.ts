import crypto from "node:crypto";

/**
 * Meta signs every webhook POST with HMAC-SHA256 over the *raw* body, using
 * the app secret of the Meta app that owns the number. Without this check
 * anyone who learns your URL can puppet the bot.
 *
 * The secret is a parameter, not a global: each client brings its own Meta
 * app, so each is verified against its own secret.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;

  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
