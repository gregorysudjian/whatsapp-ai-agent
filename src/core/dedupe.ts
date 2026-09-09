/**
 * Meta retries a webhook until it gets a 200, so the same message id can
 * arrive several times. Replying twice to one question looks broken, and with
 * an LLM behind it, costs twice.
 *
 * Backed by the messages table rather than a Map: an in-memory set forgets
 * everything on restart, and Meta's retries outlive a restart easily. The
 * message id is the primary key there, so "have we seen this?" is just a
 * lookup - no second source of truth to keep in sync.
 */

import { hasMessage } from "../store/db.ts";

export function isDuplicate(messageId: string): boolean {
  return hasMessage(messageId);
}
