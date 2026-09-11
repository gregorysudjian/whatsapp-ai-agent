/**
 * Builds Meta-shaped webhook payloads and signs them with the real HMAC.
 *
 * Signing properly matters: a test that bypasses `verifySignature` proves the
 * handler works for requests that would never reach it. This drives the actual
 * production path, signature check included.
 */

import crypto from "node:crypto";
import { DEFAULT_BUSINESS_ID, getBusiness, getWhatsappCredentials } from "../store/businesses.ts";
import type { BusinessId } from "../store/db.ts";
import type { IncomingMessage, MessageStatus, WebhookPayload } from "../whatsapp/types.ts";

/**
 * Which client a synthesized webhook is for: the URL Meta would call, the
 * number the payload claims, and the secret it is signed with. Tests that
 * probe isolation build mismatched targets on purpose - A's secret on B's
 * URL, B's number in A's payload - so each piece is independently settable.
 */
export interface Target {
  path: string;
  phoneNumberId: string;
  appSecret: string;
}

/** Real per-client route, signed and addressed as that client's Meta app would. */
export function targetFor(businessId: BusinessId): Target {
  const business = getBusiness(businessId);
  const creds = getWhatsappCredentials(businessId);
  if (!business || !creds) throw new Error(`Business ${businessId} is not connected`);
  return {
    path: `/webhook/b/${business.publicId}`,
    phoneNumberId: creds.phoneNumberId,
    appSecret: creds.appSecret,
  };
}

/** The legacy bare `/webhook`, which maps to the default business. */
export function defaultTarget(): Target {
  return { ...targetFor(DEFAULT_BUSINESS_ID), path: "/webhook" };
}

export interface TextMessageOptions {
  id?: string;
  from?: string;
  name?: string;
  /** Seconds since epoch, as Meta sends it. */
  timestamp?: number;
  /** The number the payload claims to be for. Defaults to the default business. */
  phoneNumberId?: string;
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
            phone_number_id: options.phoneNumberId ?? defaultTarget().phoneNumberId,
          },
          contacts: [{ profile: { name: options.name ?? "Test User" }, wa_id: from }],
          messages: [message],
        },
      }],
    }],
  };
}

/** A tap on a template's quick-reply button, as Meta delivers it. */
export function buttonPayload(
  label: string,
  payload: string,
  options: TextMessageOptions = {},
): WebhookPayload {
  const base = textMessagePayload(label, options);
  const message = base.entry![0]!.changes![0]!.value.messages![0]!;
  delete message.text;
  message.type = "button";
  message.button = { text: label, payload };
  return base;
}

export function statusPayload(
  status: MessageStatus,
  phoneNumberId: string = defaultTarget().phoneNumberId,
): WebhookPayload {
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
            phone_number_id: phoneNumberId,
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
export function sign(
  payload: WebhookPayload,
  appSecret: string = defaultTarget().appSecret,
): SignedPayload {
  const body = JSON.stringify(payload);
  const digest = crypto
    .createHmac("sha256", appSecret)
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
  target: Target = defaultTarget(),
): Promise<{ status: number; text: string }> {
  const { body, headers } = sign(payload, target.appSecret);
  const res = await fetch(`${baseUrl}${target.path}`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text() };
}
