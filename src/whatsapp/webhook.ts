import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { log } from "../logger.ts";
import { verifySignature } from "./signature.ts";
import { isDuplicate } from "../core/dedupe.ts";
import { runSerial } from "../core/queue.ts";
import { handleMessage } from "../core/handler.ts";
import { recordEvent, recordInbound, recordStatus } from "../store/db.ts";
import {
  DEFAULT_BUSINESS_ID, getBusiness, getBusinessByPublicId, getWhatsappCredentials,
  type Business,
} from "../store/businesses.ts";
import type { IncomingMessage, InboundMessage, WebhookPayload } from "./types.ts";

export const webhookRouter: Router = Router();

/**
 * Routing: each client has its own webhook URL, `/webhook/b/<publicId>`, so
 * the business is known before the body is trusted. That matters because the
 * signature has to be checked with *that client's* app secret - resolving the
 * business from the unverified body instead would let a forged payload choose
 * which secret it is checked against.
 *
 * The bare `/webhook` is the pre-multi-tenancy URL and maps to the default
 * business, so a Meta app already pointed at it keeps working untouched.
 */
function resolve(req: Request): Business | undefined {
  const publicId = req.params["publicId"];
  if (typeof publicId === "string") return getBusinessByPublicId(publicId);
  return getBusiness(DEFAULT_BUSINESS_ID);
}

function tokensMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Meta's one-time subscription handshake. */
function verifyHandshake(req: Request, res: Response): void {
  const business = resolve(req);
  const creds = business ? getWhatsappCredentials(business.id) : undefined;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    business && creds?.verifyToken &&
    mode === "subscribe" && typeof token === "string" &&
    tokensMatch(token, creds.verifyToken)
  ) {
    log.info("webhook_verified", { businessId: business.id });
    recordEvent(business.id, "info", "webhook_verified");
    res.status(200).type("text/plain").send(String(challenge));
    return;
  }

  log.warn("webhook_verification_failed", { businessId: business?.id ?? null });
  recordEvent(business?.id ?? null, "warn", "webhook_verification_failed", { mode: String(mode) });
  // Same response whether the business exists or not: a distinct 404 would
  // let anyone enumerate which webhook URLs belong to real clients.
  res.sendStatus(403);
}

function receive(req: Request, res: Response): void {
  const business = resolve(req);
  const creds = business ? getWhatsappCredentials(business.id) : undefined;
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!business || !creds || !rawBody ||
      !verifySignature(rawBody, req.get("x-hub-signature-256"), creds.appSecret)) {
    log.warn("invalid_signature", { businessId: business?.id ?? null });
    recordEvent(business?.id ?? null, "warn", "invalid_signature", {
      ip: req.socket.remoteAddress,
    });
    res.sendStatus(403);
    return;
  }

  // Ack immediately. Meta retries anything slower than ~20s, and an LLM turn
  // is well past that - so the work happens after the response.
  res.sendStatus(200);

  if (business.status !== "active") {
    // Acked so Meta stops retrying, but neither stored nor answered: holding
    // customers' messages for a client who is no longer active would be
    // retention with no purpose, which Law 25 does not allow.
    log.info("business_inactive_dropped", { businessId: business.id });
    recordEvent(business.id, "info", "business_inactive_dropped");
    return;
  }

  void processPayload(business, creds.phoneNumberId, req.body as WebhookPayload).catch((err: unknown) => {
    log.error("payload_processing_failed", { businessId: business.id, err: String(err) });
    recordEvent(business.id, "error", "payload_processing_failed", { err: String(err) });
  });
}

webhookRouter.get("/webhook", verifyHandshake);
webhookRouter.post("/webhook", receive);
webhookRouter.get("/webhook/b/:publicId", verifyHandshake);
webhookRouter.post("/webhook/b/:publicId", receive);

async function processPayload(
  business: Business,
  expectedPhoneNumberId: string,
  payload: WebhookPayload,
): Promise<void> {
  const businessId = business.id;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;

      // A valid signature proves the payload came from this client's Meta
      // app; it does not prove the app is sending for this client's number.
      // One Meta app can own several numbers, so the number is checked too.
      if (value.metadata?.phone_number_id !== expectedPhoneNumberId) {
        log.warn("phone_number_mismatch", {
          businessId, got: value.metadata?.phone_number_id ?? null,
        });
        recordEvent(businessId, "warn", "phone_number_mismatch", {
          got: value.metadata?.phone_number_id ?? null,
        });
        continue;
      }

      for (const status of value.statuses ?? []) {
        recordStatus(businessId, status);
        if (status.status === "failed") {
          log.warn("delivery_failed", { businessId, to: status.recipient_id, errors: status.errors });
          recordEvent(businessId, "warn", "delivery_failed", {
            to: status.recipient_id,
            errors: status.errors,
          });
        }
      }

      const senderNames = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile.name]),
      );

      for (const message of value.messages ?? []) {
        const inbound: InboundMessage = {
          id: message.id,
          from: message.from,
          senderName: senderNames.get(message.from),
          timestamp: new Date(Number(message.timestamp) * 1000),
          text: extractText(message),
          raw: message,
        };

        // The dedupe check, the write and the reply are one critical section
        // per conversation. Meta delivers webhooks concurrently, so checking
        // outside the queue lets two copies of the same message both pass the
        // check before either has been recorded. Keyed by business as well:
        // one person texting two clients is two independent conversations.
        await runSerial(`${businessId}:${inbound.from}`, async () => {
          if (isDuplicate(businessId, inbound.id)) {
            log.debug("duplicate_ignored", { businessId, id: inbound.id });
            recordEvent(businessId, "debug", "duplicate_ignored", { id: inbound.id });
            return;
          }

          // Persist before handling: if the handler throws, the message that
          // caused it is still on the dashboard to look at.
          recordInbound(businessId, inbound);
          await handleMessage(businessId, inbound);
        }).catch((err: unknown) => {
          log.error("handler_failed", { businessId, id: message.id, err: String(err) });
          recordEvent(businessId, "error", "handler_failed", {
            id: message.id,
            err: String(err),
          });
        });
      }
    }
  }
}

function extractText(message: IncomingMessage): string {
  return (
    message.text?.body ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    message.button?.text ??
    message.image?.caption ??
    message.video?.caption ??
    message.document?.caption ??
    ""
  );
}
