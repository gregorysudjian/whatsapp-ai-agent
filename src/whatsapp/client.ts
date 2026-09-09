import { config, graphBaseUrl } from "../config.ts";
import { log } from "../logger.ts";
import { recordEvent, recordOutbound } from "../store/db.ts";

const MESSAGES_URL = `${graphBaseUrl}/${config.whatsapp.phoneNumberId}/messages`;

/** WhatsApp hard-caps a text body at 4096 chars. */
const MAX_BODY = 4096;

interface GraphError {
  error?: { message: string; type: string; code: number; error_subcode?: number };
}

async function graphPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as GraphError;

  if (!res.ok) {
    const err = json.error;
    const fields = {
      status: res.status,
      code: err?.code,
      subcode: err?.error_subcode,
      message: err?.message,
    };
    log.error("graph_api_error", fields);
    recordEvent("error", "graph_api_error", fields);
    throw new Error(`Graph API ${res.status}: ${err?.message ?? "unknown error"}`);
  }

  return json;
}

/**
 * Send a plain text reply. Long answers are split - WhatsApp rejects
 * anything over 4096 chars outright rather than truncating.
 *
 * Returns the wamids Graph assigned, so the caller can attach model usage to
 * the reply it paid for.
 */
export async function sendText(to: string, body: string): Promise<string[]> {
  const wamids: string[] = [];

  for (const chunk of splitMessage(body)) {
    const result = (await graphPost(MESSAGES_URL, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: chunk },
    })) as { messages?: Array<{ id: string }> };

    // Graph echoes the wamid it assigned. Delivery receipts arrive later keyed
    // by that id, so without storing it now a "failed" status has nothing to
    // attach to and the dashboard shows a send that never resolves.
    const wamid = result.messages?.[0]?.id;
    if (wamid) {
      recordOutbound(wamid, to, chunk);
      wamids.push(wamid);
    } else {
      log.warn("send_missing_wamid", { to });
    }

    log.info("message_sent", { to, chars: chunk.length, id: wamid });
  }

  return wamids;
}

/**
 * Blue ticks + the "typing…" bubble. Purely cosmetic, but without it the
 * user stares at an unread message while Claude thinks.
 */
export async function markReadAndTyping(messageId: string): Promise<void> {
  try {
    await graphPost(MESSAGES_URL, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    // Never let a cosmetic call block the actual reply.
    log.warn("mark_read_failed", { messageId, err: String(err) });
  }
}

/** Two-step download: media id -> short-lived URL -> authenticated GET. */
export async function downloadMedia(
  mediaId: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const auth = { Authorization: `Bearer ${config.whatsapp.accessToken}` };

  const metaRes = await fetch(`${graphBaseUrl}/${mediaId}`, { headers: auth });
  if (!metaRes.ok) throw new Error(`media lookup failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  // The CDN URL still requires the bearer token.
  const fileRes = await fetch(meta.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`media download failed: ${fileRes.status}`);

  return {
    data: Buffer.from(await fileRes.arrayBuffer()),
    mimeType: meta.mime_type,
  };
}

/** Split on paragraph, then line, then hard-cut - keeps replies readable. */
export function splitMessage(text: string, limit = MAX_BODY): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = window.lastIndexOf(" ");
    if (cut < limit * 0.5) cut = limit;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
