import { sendText, markReadAndTyping } from "../whatsapp/client.ts";
import { generateReply } from "../agent/claude.ts";
import { log } from "../logger.ts";
import { agentEnabled, humanTookOverSince, isPaused, recordEvent, recordUsage, type BusinessId } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";
import { handleBookingButton } from "./reminders.ts";

/**
 * Phase 3: load history -> ask Claude -> send.
 *
 * The inbound message is already in the store by the time this runs (the
 * webhook records it first), so history is read back rather than passed in -
 * one source of truth for what the conversation actually contains.
 *
 * The outbound reply is stored by sendText, keyed by the wamid Graph returns.
 */
export async function handleMessage(businessId: BusinessId, msg: InboundMessage): Promise<void> {
  log.info("message_received", {
    businessId,
    from: msg.from,
    name: msg.senderName,
    type: msg.raw.type,
    chars: msg.text.length,
  });

  // A Confirm / Cancel tap on a reminder is answered here, deterministically,
  // and never reaches the model - whoever has the conversation.
  if (await handleBookingButton(businessId, msg)) return;

  // Checked before the model call, not after: a paused conversation should
  // cost nothing. The message is already stored, so nothing is lost - the
  // dashboard shows it and a human can answer.
  if (!agentEnabled(businessId)) {
    log.warn("reply_suppressed", { businessId, reason: "agent_disabled", from: msg.from });
    recordEvent(businessId, "warn", "reply_suppressed", { reason: "agent_disabled", from: msg.from });
    return;
  }

  if (isPaused(businessId, msg.from)) {
    log.info("reply_suppressed", { businessId, reason: "handed_to_human", from: msg.from });
    recordEvent(businessId, "info", "reply_suppressed", { reason: "handed_to_human", from: msg.from });
    return;
  }

  await markReadAndTyping(businessId, msg.id);

  if (msg.text.trim() === "") {
    await sendText(
      businessId,
      msg.from,
      `I can only read text right now - I got a "${msg.raw.type}" message. Media support is coming.`,
      { sender: "system" },
    );
    return;
  }

  const started = Date.now();
  const reply = await generateReply(businessId, msg.from, msg.senderName);

  // The model takes seconds; the world moves meanwhile. A person who took the
  // conversation over, or an owner who hit the kill switch, wins over a reply
  // that was already being written. (The agent handing off by itself is
  // different: its "a colleague will follow up" message should still go.)
  if (humanTookOverSince(businessId, msg.from, started) || !agentEnabled(businessId)) {
    log.info("reply_dropped", { businessId, from: msg.from, reason: "control_changed" });
    recordEvent(businessId, "info", "reply_dropped", { from: msg.from, reason: "control_changed" });
    return;
  }

  if (!reply.ok) {
    recordEvent(businessId, "warn", "fallback_reply_sent", { to: msg.from, id: msg.id });
  }

  const wamids = await sendText(businessId, msg.from, reply.text);

  // Attached to the first chunk: a split reply is one model call, and
  // duplicating its cost across chunks would overstate spend.
  const first = wamids[0];
  if (first && reply.usage) recordUsage(businessId, first, reply.usage);
}
