/**
 * Meta retries a webhook until it gets a 200, so the same message id can
 * arrive several times. Replying twice to one question looks broken, and with
 * an LLM behind it, costs twice.
 *
 * Backed by the messages table rather than a Map: an in-memory set forgets
 * everything on restart, and Meta's retries outlive a restart easily. Scoped
 * by business, like every other read.
 */

import { hasMessage, type BusinessId } from "../store/db.ts";

export function isDuplicate(businessId: BusinessId, messageId: string): boolean {
  return hasMessage(businessId, messageId);
}
