import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from "./passwords.ts";

test("a password verifies against its own hash, and nothing else does", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse batterY", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("the stored form carries its own parameters and never the password", async () => {
  const stored = await hashPassword("Some-secret-value-9");
  const parts = stored.split("$");
  assert.equal(parts[0], "scrypt");
  assert.equal(parts.length, 6);
  assert.ok(!stored.includes("Some-secret-value-9"));
});

test("the same password hashes differently each time (salted)", async () => {
  assert.notEqual(await hashPassword("same-password-1"), await hashPassword("same-password-1"));
});

test("a malformed stored hash fails closed", async () => {
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
  assert.equal(await verifyPassword("anything", "bcrypt$1$2$3$4$5"), false);
});

test("the policy refuses the usual mistakes", () => {
  assert.equal(passwordProblem("short", "a@b.co"), "too_short");
  assert.equal(passwordProblem("owner@ninja.co", "owner@ninja.co"), "matches_email");
  assert.equal(passwordProblem("Password123", "a@b.co"), "too_common");
  assert.equal(passwordProblem("aaaaaaaaaaaa", "a@b.co"), "too_repetitive");
  assert.equal(passwordProblem("a-perfectly-fine-passphrase", "a@b.co"), null);
});

test("generated passwords are long, varied and free of look-alike characters", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.equal(p.length, 16);
    assert.doesNotMatch(p, /[0O1lI]/);
    assert.equal(passwordProblem(p, "x@y.z"), null);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});
