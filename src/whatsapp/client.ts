import { graphBaseFor } from "../config.ts";
import { log } from "../logger.ts";
import { recordEvent, recordOutbound, windowState, type BusinessId, type OutboundSender } from "../store/db.ts";
import { getWhatsappCredentials, type WhatsappCredentials } from "../store/businesses.ts";
import { outboundLimiter } from "../core/throttle.ts";

export class NotConnectedError extends Error {}

/**
 * Credentials are looked up per call, not cached at module load: a client
 * whose token the admin just rotated must use the new one on the very next
 * send, and a module-level constant is exactly how one client ends up sending
 * on another client's number.
 */
function credentialsFor(businessId: BusinessId): WhatsappCredentials {
  const creds = getWhatsappCredentials(businessId);
  if (!creds) throw new NotConnectedError(`Business ${businessId} has no WhatsApp credentials`);
  return creds;
}

const messagesUrl = (c: WhatsappCredentials) =>
  `${graphBaseFor(c.graphVersion)}/${c.phoneNumberId}/messages`;

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
async function graphPost(
  businessId: BusinessId,
  creds: WhatsappCredentials,
  url: string,
  body: unknown,
): Promise<unknown> {
  let lastError = new Error("no attempt made");

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    await outboundLimiter.take();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
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
      recordEvent(businessId, "error", "graph_api_error", fields);
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

  recordEvent(businessId, "error", "graph_send_exhausted", { message: lastError.message });
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
export interface SendOptions {
  /** Who is speaking: the agent (default), a person on the dashboard, or an automated notice. */
  sender?: OutboundSender;
  /** The dashboard user, when sender is "human" - kept for the audit trail and the thread label. */
  userId?: number | null;
}

export async function sendText(
  businessId: BusinessId,
  to: string,
  body: string,
  opts: SendOptions = {},
): Promise<string[]> {
  const wamids: string[] = [];

  // Checked here rather than in the handler so every send path is covered.
  // Outside the window Graph rejects free-form text outright, and the reply
  // disappears with only a generic API error to show for it.
  const window = windowState(businessId, to);
  if (!window.open) {
    log.warn("window_closed", { businessId, to, lastInboundTs: window.lastInboundTs });
    recordEvent(businessId, "warn", "window_closed", {
      to,
      lastInboundTs: window.lastInboundTs,
      hint: "Outside Meta's 24h window only approved template messages deliver.",
    });
    return wamids;
  }

  const creds = credentialsFor(businessId);

  for (const chunk of splitMessage(body)) {
    const result = (await graphPost(businessId, creds, messagesUrl(creds), {
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
      recordOutbound(businessId, wamid, to, chunk, opts.sender ?? "ai", opts.userId ?? null);
      wamids.push(wamid);
    } else {
      log.warn("send_missing_wamid", { businessId, to });
    }

    log.info("message_sent", { businessId, to, chars: chunk.length, id: wamid });
  }

  return wamids;
}

/** One parameterised part of an approved template (Meta's component shape). */
export interface TemplateComponent {
  type: "body" | "header" | "button";
  sub_type?: "quick_reply" | "url";
  index?: string;
  parameters: Array<{ type: "text"; text: string } | { type: "payload"; payload: string }>;
}

/**
 * Send a pre-approved template. Deliberately NOT behind the 24h window check
 * that guards sendText: reaching a customer who has not written in a day is
 * exactly what templates are for, and the only thing Meta allows then.
 *
 * `preview` is what the inbox shows for it - the template's text lives in
 * Meta, not here.
 */
export async function sendTemplate(
  businessId: BusinessId,
  to: string,
  template: { name: string; language: string; components: TemplateComponent[] },
  preview: string,
): Promise<string | null> {
  const creds = credentialsFor(businessId);
  const result = (await graphPost(businessId, creds, messagesUrl(creds), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name: template.name, language: { code: template.language }, components: template.components },
  })) as { messages?: Array<{ id: string }> };

  const wamid = result.messages?.[0]?.id ?? null;
  if (wamid) recordOutbound(businessId, wamid, to, preview, "system", null, "template");
  else log.warn("send_missing_wamid", { businessId, to, template: template.name });
  log.info("template_sent", { businessId, to, template: template.name, id: wamid });
  return wamid;
}

/**
 * Blue ticks + the "typing…" bubble. Purely cosmetic, but without it the
 * user stares at an unread message while Claude thinks.
 */
export async function markReadAndTyping(
  businessId: BusinessId,
  messageId: string,
): Promise<void> {
  try {
    const creds = credentialsFor(businessId);
    await graphPost(businessId, creds, messagesUrl(creds), {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    // Never let a cosmetic call block the actual reply.
    log.warn("mark_read_failed", { businessId, messageId, err: String(err) });
  }
}

/** Two-step download: media id -> short-lived URL -> authenticated GET. */
export async function downloadMedia(
  businessId: BusinessId,
  mediaId: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const creds = credentialsFor(businessId);
  const auth = { Authorization: `Bearer ${creds.accessToken}` };

  const metaRes = await fetch(`${graphBaseFor(creds.graphVersion)}/${mediaId}`, { headers: auth });
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
