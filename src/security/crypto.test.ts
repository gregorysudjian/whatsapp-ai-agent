import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  decrypt, encrypt, EncryptionKeyError, generateKey, parseKey, redact,
} from "./crypto.ts";

const key = parseKey(generateKey());
const CTX = "business:abc123:wa_access_token";

test("a value round-trips", () => {
  const sealed = encrypt(key, "EAAG-real-token-value", CTX);
  assert.equal(decrypt(key, sealed, CTX), "EAAG-real-token-value");
});

test("the plaintext does not appear in the stored form", () => {
  const secret = "EAAG-this-must-not-be-readable";
  const sealed = encrypt(key, secret, CTX);
  assert.ok(!sealed.includes(secret));
  assert.ok(!Buffer.from(sealed).toString("base64").includes(Buffer.from(secret).toString("base64")));
});

test("the same value encrypts differently each time", () => {
  // A fresh nonce per value: identical tokens must not produce identical
  // ciphertexts, or two clients sharing a secret would be visible as such.
  assert.notEqual(encrypt(key, "same", CTX), encrypt(key, "same", CTX));
});

test("a tampered ciphertext is rejected, not decrypted to garbage", () => {
  const sealed = encrypt(key, "token", CTX);
  const parts = sealed.split(".");
  const body = Buffer.from(parts[3]!, "base64");
  body[0] = body[0]! ^ 0x01;
  parts[3] = body.toString("base64");
  assert.throws(() => decrypt(key, parts.join("."), CTX));
});

test("a ciphertext moved to another business fails to decrypt", () => {
  // The associated data binds a value to its owner: copying business A's
  // encrypted token into business B's row in the database does not work.
  const sealed = encrypt(key, "business A's token", "business:AAAA:wa_access_token");
  assert.throws(() => decrypt(key, sealed, "business:BBBB:wa_access_token"));
});

test("a ciphertext moved to another field fails to decrypt", () => {
  const sealed = encrypt(key, "the app secret", "business:AAAA:wa_app_secret");
  assert.throws(() => decrypt(key, sealed, "business:AAAA:wa_access_token"));
});

test("the wrong key cannot decrypt", () => {
  const sealed = encrypt(key, "token", CTX);
  assert.throws(() => decrypt(parseKey(generateKey()), sealed, CTX));
});

test("a missing key refuses to start, with instructions", () => {
  assert.throws(() => parseKey(undefined), EncryptionKeyError);
  assert.throws(() => parseKey("   "), /gen-key/);
});

test("a key of the wrong length is refused", () => {
  assert.throws(() => parseKey(crypto.randomBytes(16).toString("base64")), /32 bytes/);
});

test("redaction shows only that a secret is set", () => {
  assert.equal(redact("EAAGabcdef1234"), "****1234");
  assert.equal(redact(""), null);
  assert.equal(redact(null), null);
  assert.equal(redact("abc"), "****");
});
