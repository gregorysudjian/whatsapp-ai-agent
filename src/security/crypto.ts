/**
 * Encryption for secrets at rest - WhatsApp tokens, app secrets, and later
 * calendar refresh tokens.
 *
 * AES-256-GCM, authenticated: a tampered ciphertext fails to decrypt rather
 * than decrypting to garbage. Each value is bound to its owner through
 * associated data, so a ciphertext copied from one business's row into
 * another's fails too - the database alone cannot be used to move one
 * client's credentials onto another client.
 *
 * The key never touches the database. Lose APP_ENCRYPTION_KEY and every stored
 * credential has to be re-entered; that is the intended failure mode.
 */

import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12; // GCM's recommended nonce size
const KEY_BYTES = 32;

export class EncryptionKeyError extends Error {}

/** Parses and checks a base64 key. Throws with instructions, never silently. */
export function parseKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new EncryptionKeyError(
      "APP_ENCRYPTION_KEY is not set. Generate one with `npm run gen-key` and add it to .env. " +
        "Back it up: without it, stored WhatsApp credentials cannot be decrypted.",
    );
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `APP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Generate one with \`npm run gen-key\`.`,
    );
  }
  return key;
}

export function generateKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}

/**
 * `context` names who owns the value, e.g. "business:<publicId>:wa_access_token".
 * Decryption must present the same context.
 */
export function encrypt(key: Buffer, plaintext: string, context: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decrypt(key: Buffer, sealed: string, context: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unrecognised ciphertext format");
  }
  const [, iv, tag, ciphertext] = parts as [string, string, string, string];

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  // Throws on a wrong key, a tampered value, or a mismatched context.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** For display: never show a secret, only whether one is set and its tail. */
export function redact(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? "****" : `****${value.slice(-4)}`;
}
