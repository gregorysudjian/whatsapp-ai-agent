import { test } from "node:test";
import assert from "node:assert/strict";
import { runSerial, pendingKeys } from "./queue.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("work for one conversation runs strictly in order", async () => {
  const order: string[] = [];
  const job = (name: string, ms: number) => async () => {
    order.push(`${name}:start`);
    await tick(ms);
    order.push(`${name}:end`);
  };

  // First job is slower - without serialisation, b would finish inside a.
  const a = runSerial("wa-1", job("a", 40));
  const b = runSerial("wa-1", job("b", 1));
  await Promise.all([a, b]);

  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("different conversations are not blocked by each other", async () => {
  const order: string[] = [];
  const slow = runSerial("wa-2", async () => { await tick(40); order.push("slow"); });
  const fast = runSerial("wa-3", async () => { await tick(1); order.push("fast"); });
  await Promise.all([slow, fast]);

  assert.deepEqual(order, ["fast", "slow"], "a slow contact must not stall another");
});

test("a failing task does not stall the conversation behind it", async () => {
  const boom = runSerial("wa-4", async () => { throw new Error("handler blew up"); });
  await assert.rejects(() => boom, /handler blew up/);

  const after = await runSerial("wa-4", async () => "still works");
  assert.equal(after, "still works");
});

test("rejections reach the caller and do not crash the process", async () => {
  await assert.rejects(() => runSerial("wa-5", async () => { throw new Error("x"); }), /x/);
});

test("completed conversations are evicted, so the map cannot grow forever", async () => {
  await runSerial("wa-6", async () => undefined);
  await tick(5);
  assert.ok(!pendingKeys().includes("wa-6"));
});
