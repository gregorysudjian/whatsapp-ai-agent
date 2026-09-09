import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "./throttle.ts";

test("a burst is allowed up to the bucket size", async () => {
  const bucket = new TokenBucket(10, 5);
  const started = Date.now();
  for (let i = 0; i < 5; i++) await bucket.take();
  assert.ok(Date.now() - started < 50, "the first burst should not wait");
  assert.equal(bucket.available, 0);
});

test("past the burst, calls are paced rather than rejected", async () => {
  const bucket = new TokenBucket(20, 1); // 1 burst, then 20/s => ~50ms each
  await bucket.take();

  const started = Date.now();
  await bucket.take();
  const waited = Date.now() - started;

  assert.ok(waited >= 30, `expected pacing, waited only ${waited}ms`);
});

test("idle time banks capacity, capped at the burst size", async () => {
  const bucket = new TokenBucket(100, 3);
  for (let i = 0; i < 3; i++) await bucket.take();
  await new Promise((r) => setTimeout(r, 80)); // would earn 8 tokens uncapped
  assert.equal(bucket.available, 3, "capacity must cap at the burst size");
});
