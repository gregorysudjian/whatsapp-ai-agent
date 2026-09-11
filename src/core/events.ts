/**
 * In-process pub/sub. The store publishes here; the dashboard's SSE endpoint
 * subscribes. Deliberately not a queue - a dashboard that misses an event
 * while disconnected just refetches on reconnect.
 *
 * Every event carries its businessId, and a subscription must name the
 * business it is allowed to see. There is no "subscribe to everything" for a
 * client-facing stream: an unfiltered live feed would show one client another
 * client's conversations in real time.
 */

import { EventEmitter } from "node:events";

export type AgentEvent = { businessId: number } & (
  | { kind: "message"; direction: "in" | "out"; waId: string; id: string }
  | { kind: "status"; waId: string; id: string; status: string }
  | { kind: "event"; level: string; name: string }
);

const bus = new EventEmitter();
// One listener per open dashboard tab; the default cap of 10 is too low.
bus.setMaxListeners(200);

export function publish(event: AgentEvent): void {
  bus.emit("agent", event);
}

/**
 * `scope` is a single business, or "all" - which only the super-admin
 * surface may pass, and the type makes that choice explicit at the call site.
 */
export function subscribe(
  scope: number | "all",
  fn: (event: AgentEvent) => void,
): () => void {
  const listener = (event: AgentEvent) => {
    if (scope === "all" || event.businessId === scope) fn(event);
  };
  bus.on("agent", listener);
  return () => bus.off("agent", listener);
}
