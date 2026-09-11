/**
 * Password hashing with scrypt from node:crypto - memory-hard, so a stolen
 * hash is expensive to brute-force on GPUs, and no native dependency.
 *
 * Stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later without
 * invalidating existing passwords: verification reads the parameters from the
 * stored value, not from the current constants.
 */

import crypto from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
// scrypt needs ~128*N*r bytes; the default 32 MiB cap is too small for N=2^15.
const MAXMEM = 128 * N * R * 2;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: n, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string];
  const expectedKey = Buffer.from(expected, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return key.length === expectedKey.length && crypto.timingSafeEqual(key, expectedKey);
}

/**
 * A hash to verify against when the email does not exist, so a login for an
 * unknown account takes as long as one with a wrong password. Without it, the
 * response time alone reveals which emails have accounts.
 */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  return decoy;
}

const COMMON = new Set([
  "password", "password1", "password123", "1234567890", "qwertyuiop", "azertyuiop",
  "motdepasse", "0123456789", "iloveyou12", "letmein123", "welcome123", "admin12345",
]);

/** Returns a reason the password is unacceptable, or null when it is fine. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return "too_short";
  if (password.length > 200) return "too_long";
  const lower = password.toLowerCase();
  if (lower === email.toLowerCase() || lower === email.split("@")[0]?.toLowerCase()) return "matches_email";
  if (COMMON.has(lower)) return "too_common";
  if (new Set(password).size < 4) return "too_repetitive";
  return null;
}

/** 16 characters from an alphabet with no look-alikes (0/O, 1/l/I). */
export function generatePassword(length = 16): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // randomInt, not byte % length: 256 is not a multiple of the alphabet size,
  // so a modulo would make some characters slightly more likely than others.
  return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}
