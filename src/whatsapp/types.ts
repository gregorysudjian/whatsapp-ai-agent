/**
 * The slice of Meta's webhook payload we actually consume.
 * Meta sends far more than this; anything unmodelled is ignored on purpose.
 */

export interface WebhookPayload {
  object: string;
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field: string;
  value: WebhookValue;
}

export interface WebhookValue {
  messaging_product: "whatsapp";
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ profile: { name: string }; wa_id: string }>;
  messages?: IncomingMessage[];
  /** Delivery receipts (sent/delivered/read/failed) - not user messages. */
  statuses?: MessageStatus[];
}

export interface IncomingMessage {
  id: string;
  from: string;
  timestamp: string;
  type:
    | "text"
    | "image"
    | "audio"
    | "video"
    | "document"
    | "sticker"
    | "location"
    | "contacts"
    | "button"
    | "interactive"
    | "reaction"
    | "order"
    | "system"
    | "unsupported";
  text?: { body: string };
  image?: MediaRef;
  audio?: MediaRef;
  video?: MediaRef;
  document?: MediaRef & { filename?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text: string; payload: string };
  context?: { from: string; id: string };
  errors?: Array<{ code: number; title: string; message?: string }>;
}

export interface MediaRef {
  id: string;
  mime_type: string;
  sha256?: string;
  caption?: string;
  voice?: boolean;
}

export interface MessageStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

/** Normalized form the agent layer works with - channel details stop here. */
export interface InboundMessage {
  id: string;
  from: string;
  senderName: string | undefined;
  timestamp: Date;
  /** Best-effort plain text: body, caption, or button/list title. */
  text: string;
  raw: IncomingMessage;
}
