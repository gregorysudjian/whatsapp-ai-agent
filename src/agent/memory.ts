/**
 * Conversation memory. The store is already the transcript - every inbound and
 * outbound message lands there - so history is a query, not a second cache
 * that can drift from what was actually sent.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { listMessages } from "../store/queries.ts";
import type { BusinessId } from "../store/db.ts";

/** How many past turns to replay. Cost scales with this on every message. */
export const HISTORY_LIMIT = 20;

/**
 * Build the messages array for a conversation.
 *
 * Two API rules shape this: the first entry must be `user`, and empty content
 * is rejected. Both are easy to violate from real data - a conversation whose
 * stored history begins with an outbound template, or a media message that
 * normalised to an empty string.
 */
export function buildHistory(
  businessId: BusinessId,
  waId: string,
  limit = HISTORY_LIMIT,
): Anthropic.MessageParam[] {
  const rows = listMessages(businessId, waId, 500).slice(-limit);

  const turns: Anthropic.MessageParam[] = [];
  for (const row of rows) {
    const text = row.text.trim();
    if (text === "") continue; // media-only turn: nothing to replay
    turns.push({
      role: row.direction === "in" ? "user" : "assistant",
      content: text,
    });
  }

  // Drop any assistant turns before the first user turn.
  while (turns.length > 0 && turns[0]?.role === "assistant") turns.shift();

  return turns;
}
