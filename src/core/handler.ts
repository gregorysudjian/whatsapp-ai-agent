import { sendText, markReadAndTyping } from "../whatsapp/client.ts";
import { generateReply } from "../agent/claude.ts";
import { log } from "../logger.ts";
import { recordEvent } from "../store/db.ts";
import type { InboundMessage } from "../whatsapp/types.ts";

/**
 * Phase 3: load history -> ask Claude -> send.
 *
 * The inbound message is already in the store by the time this runs (the
 * webhook records it first), so history is read back rather than passed in -
 * one source of truth for what the conversation actually contains.
 *
 * The outbound reply is stored by sendText, keyed by the wamid Graph returns.
 */
export async function handleMessage(msg: InboundMessage): Promise<void> {
  log.info("message_received", {
    from: msg.from,
    name: msg.senderName,
    type: msg.raw.type,
    chars: msg.text.length,
  });

  await markReadAndTyping(msg.id);

  if (msg.text.trim() === "") {
    await sendText(
      msg.from,
      `I can only read text right now - I got a "${msg.raw.type}" message. Media support is coming.`,
    );
    return;
  }

  const reply = await generateReply(msg.from);

  if (!reply.ok) {
    recordEvent("warn", "fallback_reply_sent", { to: msg.from, id: msg.id });
  }

  await sendText(msg.from, reply.text);
}
