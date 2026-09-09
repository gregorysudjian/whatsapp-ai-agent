/**
 * Builds Meta-shaped webhook payloads and signs them with the real HMAC.
 *
 * Signing properly matters: a test that bypasses `verifySignature` proves the
 * handler works for requests that would never reach it. This drives the actual
 * production path, signature check included.
 */

import crypto from "node:crypto";
import { config } from "../config.ts";
import type { IncomingMessage, MessageStatus, WebhookPayload } from "../whatsapp/types.ts";

export interface TextMessageOptions {
  id?: string;
  from?: string;
  name?: string;
  /** Seconds since epoch, as Meta sends it. */
  timestamp?: number;
}

let counter = 0;
/**
 * Unique per process. Each test file runs in its own process, so a plain
 * counter restarts at 1 in every file and collides in the shared database -
 * where dedupe then correctly treats the second file's first message as one
 * of Meta's retries and silently drops it.
 */
const runId = Math.random().toString(36).slice(2, 8);

export function textMessagePayload(
  text: string,
  options: TextMessageOptions = {},
): WebhookPayload {
  const from = options.from ?? "15550001111";
  const message: IncomingMessage = {
    id: options.id ?? `wamid.TEST_${runId}_${++counter}`,
    from,
    timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    type: "text",
    text: { body: text },
  };

  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550000000",
            phone_number_id: config.whatsapp.phoneNumberId,
          },
          contacts: [{ profile: { name: options.name ?? "Test User" }, wa_id: from }],
          messages: [message],
        },
      }],
    }],
  };
}

export function statusPayload(status: MessageStatus): WebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550000000",
            phone_number_id: config.whatsapp.phoneNumberId,
          },
          statuses: [status],
        },
      }],
    }],
  };
}

export interface SignedPayload {
  body: string;
  signature: string;
  headers: Record<string, string>;
}

/** Serialise once and sign those exact bytes - re-stringifying breaks the HMAC. */
export function sign(payload: WebhookPayload): SignedPayload {
  const body = JSON.stringify(payload);
  const digest = crypto
    .createHmac("sha256", config.whatsapp.appSecret)
    .update(Buffer.from(body))
    .digest("hex");
  const signature = `sha256=${digest}`;

  return {
    body,
    signature,
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
  };
}

/** POST a signed payload at a running server, as Meta would. */
export async function deliver(
  baseUrl: string,
  payload: WebhookPayload,
): Promise<{ status: number; text: string }> {
  const { body, headers } = sign(payload);
  const res = await fetch(`${baseUrl}/webhook`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}
