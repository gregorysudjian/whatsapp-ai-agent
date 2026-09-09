/**
 * In-process pub/sub. The store publishes here; the dashboard's SSE endpoint
 * subscribes. Deliberately not a queue - a dashboard that misses an event
 * while disconnected just refetches on reconnect.
 */

import { EventEmitter } from "node:events";

export type AgentEvent =
  | { kind: "message"; direction: "in" | "out"; waId: string; id: string }
  | { kind: "status"; waId: string; id: string; status: string }
  | { kind: "event"; level: string; name: string };

const bus = new EventEmitter();
// One listener per open dashboard tab; the default cap of 10 is too low.
bus.setMaxListeners(100);

export function publish(event: AgentEvent): void {
  bus.emit("agent", event);
}

export function subscribe(fn: (event: AgentEvent) => void): () => void {
  bus.on("agent", fn);
  return () => bus.off("agent", fn);
}
