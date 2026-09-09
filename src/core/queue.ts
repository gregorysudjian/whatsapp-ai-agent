/**
 * Serialises work per conversation.
 *
 * Meta delivers webhooks concurrently. Two messages from the same person
 * arriving together would otherwise both read the same history, both call the
 * model, and both reply - the customer gets two answers to the first question
 * and none to the second, and the stored transcript interleaves.
 *
 * Different contacts still run in parallel; only same-key work is chained.
 * In-process, matching the event bus's documented single-instance assumption.
 */

const chains = new Map<string, Promise<unknown>>();

export function runSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();

  // Chained off both settle paths: a failed task must not stall the queue for
  // that conversation forever.
  const result = previous.then(task, task);

  // Tail is the swallowed form - the caller still sees rejections via `result`,
  // but an unobserved rejection here would crash the process.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);

  void tail.then(() => {
    // Only clear if nothing queued behind us, or we would drop a pending chain.
    if (chains.get(key) === tail) chains.delete(key);
  });

  return result;
}

/** Conversations with work in flight. Exposed for tests and diagnostics. */
export function pendingKeys(): string[] {
  return [...chains.keys()];
}
