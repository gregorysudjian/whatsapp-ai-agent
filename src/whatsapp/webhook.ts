import { Router, type Request, type Response } from "express";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { verifySignature } from "./signature.ts";
import { isDuplicate } from "../core/dedupe.ts";
import { handleMessage } from "../core/handler.ts";
import { recordEvent, recordInbound, recordStatus } from "../store/db.ts";
import type { IncomingMessage, InboundMessage, WebhookPayload } from "./types.ts";

export const webhookRouter: Router = Router();

/** Meta's one-time subscription handshake. */
webhookRouter.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    log.info("webhook_verified");
    recordEvent("info", "webhook_verified");
    res.status(200).type("text/plain").send(String(challenge));
    return;
  }

  log.warn("webhook_verification_failed", { mode });
  recordEvent("warn", "webhook_verification_failed", { mode: String(mode) });
  res.sendStatus(403);
});

webhookRouter.post("/webhook", (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!rawBody || !verifySignature(rawBody, req.get("x-hub-signature-256"))) {
    log.warn("invalid_signature");
    recordEvent("warn", "invalid_signature", { ip: req.socket.remoteAddress });
    res.sendStatus(403);
    return;
  }

  // Ack immediately. Meta retries anything slower than ~20s, and an LLM turn
  // is well past that - so the work happens after the response.
  res.sendStatus(200);

  void processPayload(req.body as WebhookPayload).catch((err: unknown) => {
    log.error("payload_processing_failed", { err: String(err) });
    recordEvent("error", "payload_processing_failed", { err: String(err) });
  });
});

async function processPayload(payload: WebhookPayload): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;

      for (const status of value.statuses ?? []) {
        recordStatus(status);
        if (status.status === "failed") {
          log.warn("delivery_failed", { to: status.recipient_id, errors: status.errors });
          recordEvent("warn", "delivery_failed", {
            to: status.recipient_id,
            errors: status.errors,
          });
        }
      }

      const senderNames = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile.name]),
      );

      for (const message of value.messages ?? []) {
        if (isDuplicate(message.id)) {
          log.debug("duplicate_ignored", { id: message.id });
          recordEvent("debug", "duplicate_ignored", { id: message.id });
          continue;
        }

        const inbound: InboundMessage = {
          id: message.id,
          from: message.from,
          senderName: senderNames.get(message.from),
          timestamp: new Date(Number(message.timestamp) * 1000),
          text: extractText(message),
          raw: message,
        };

        // Persist before handling: if the handler throws, the message that
        // caused it is still on the dashboard to look at.
        recordInbound(inbound);

        // Sequential per payload: keeps one user's messages in order.
        await handleMessage(inbound).catch((err: unknown) => {
          log.error("handler_failed", { id: message.id, err: String(err) });
          recordEvent("error", "handler_failed", {
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
