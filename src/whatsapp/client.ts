import { config, graphBaseUrl } from "../config.ts";
import { log } from "../logger.ts";
import { recordEvent, recordOutbound, windowState } from "../store/db.ts";
import { outboundLimiter } from "../core/throttle.ts";

const MESSAGES_URL = `${graphBaseUrl}/${config.whatsapp.phoneNumberId}/messages`;

/** WhatsApp hard-caps a text body at 4096 chars. */
const MAX_BODY = 4096;

interface GraphError {
  error?: { message: string; type: string; code: number; error_subcode?: number };
}

const MAX_SEND_ATTEMPTS = 3;

/**
 * Retries 429s and 5xx with exponential backoff and jitter; never retries a
 * 4xx, because a malformed request will be just as malformed next time and
 * retrying it only burns quota.
 *
 * Caveat worth knowing: Graph has no idempotency key for text sends, so a
 * retry after a lost response could deliver twice. Retrying only where no
 * success response was seen keeps that window small, but it is not zero.
 */
async function graphPost(url: string, body: unknown): Promise<unknown> {
  let lastError = new Error("no attempt made");

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    await outboundLimiter.take();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.whatsapp.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure: no response at all, so retrying is safe-ish.
      lastError = new Error(`Graph API unreachable: ${String(err)}`);
      log.warn("graph_unreachable", { attempt, err: String(err) });
      if (attempt < MAX_SEND_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      break;
    }

    const json = (await res.json().catch(() => ({}))) as GraphError;
    if (res.ok) return json;

    const err = json.error;
    const fields = {
      status: res.status,
      code: err?.code,
      subcode: err?.error_subcode,
      message: err?.message,
      attempt,
    };

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_SEND_ATTEMPTS) {
      log.error("graph_api_error", fields);
      recordEvent("error", "graph_api_error", fields);
      throw new Error(`Graph API ${res.status}: ${err?.message ?? "unknown error"}`);
    }

    // Meta's own pacing beats our guess when it bothers to send one.
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : backoffMs(attempt);

    log.warn("graph_retrying", { ...fields, waitMs });
    await sleep(waitMs);
    lastError = new Error(`Graph API ${res.status}: ${err?.message ?? "unknown error"}`);
  }

  recordEvent("error", "graph_send_exhausted", { message: lastError.message });
  throw lastError;
}

/** Exponential with jitter, so simultaneous failures do not retry in lockstep. */
function backoffMs(attempt: number): number {
  return 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a plain text reply. Long answers are split - WhatsApp rejects
 * anything over 4096 chars outright rather than truncating.
 *
 * Returns the wamids Graph assigned, so the caller can attach model usage to
 * the reply it paid for.
 */
export async function sendText(to: string, body: string): Promise<string[]> {
  const wamids: string[] = [];

  // Checked here rather than in the handler so every send path is covered.
  // Outside the window Graph rejects free-form text outright, and the reply
  // disappears with only a generic API error to show for it.
  const window = windowState(to);
  if (!window.open) {
    log.warn("window_closed", { to, lastInboundTs: window.lastInboundTs });
    recordEvent("warn", "window_closed", {
      to,
      lastInboundTs: window.lastInboundTs,
      hint: "Outside Meta's 24h window only approved template messages deliver.",
    });
    return wamids;
  }

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
