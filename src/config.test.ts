import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneEmptyCredentials } from "./config.ts";

test("an empty credential var is removed, not left to shadow the chain", () => {
  const env: Record<string, string | undefined> = {
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "   ",
  };
  const pruned = pruneEmptyCredentials(env);

  assert.ok(!("ANTHROPIC_AUTH_TOKEN" in env), "empty token must be deleted, not blanked");
  assert.ok(!("ANTHROPIC_API_KEY" in env));
  assert.deepEqual(pruned.sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
});

test("a real credential is left alone", () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-real" };
  assert.deepEqual(pruneEmptyCredentials(env), []);
  assert.equal(env["ANTHROPIC_API_KEY"], "sk-ant-real");
});

test("absent vars are not invented", () => {
  const env: Record<string, string | undefined> = {};
  assert.deepEqual(pruneEmptyCredentials(env), []);
  assert.ok(!("ANTHROPIC_API_KEY" in env));
});
