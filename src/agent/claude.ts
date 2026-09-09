/**
 * Phase 3: Claude generates the reply.
 *
 * The channel layer never reaches in here - this takes a conversation id and
 * returns text, so the same agent can sit behind SMS or web chat later.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { recordEvent } from "../store/db.ts";
import { buildHistory } from "./memory.ts";
import { buildSystemPrompt } from "./persona.ts";

/**
 * Constructed lazily and replaceable, which is what makes this testable with
 * no credential on the machine.
 *
 * Zero-arg on purpose: the SDK resolves credentials itself (ANTHROPIC_API_KEY,
 * then ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile). Passing an
 * explicit key would break the profile path.
 */
export type MessagesClient = Pick<Anthropic, "messages">;

let client: MessagesClient | undefined;

export function getClient(): MessagesClient {
  client ??= new Anthropic();
  return client;
}

/** Swap in a fake. Pass undefined to restore the real client. */
export function setClientForTesting(fake: MessagesClient | undefined): void {
  client = fake;
}

/** What the customer sees when the model call fails. */
export const FALLBACK_REPLY =
  "Sorry - I hit a technical problem just then. Please send that again in a moment, or say \"human\" and I'll pass you to someone.";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
}

export interface ReplyResult {
  text: string;
  /** False when the fallback was used - the caller decides how to record it. */
  ok: boolean;
  usage: Usage | undefined;
}

const RETRYABLE = new Set(["rate_limit", "connection", "server"]);
const MAX_ATTEMPTS = 2;

export async function generateReply(waId: string): Promise<ReplyResult> {
  const messages = buildHistory(waId);

  if (messages.length === 0) {
    // Nothing replayable (e.g. the only message was media with no caption).
    return { text: FALLBACK_REPLY, ok: false, usage: undefined };
  }

  let lastKind = "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      // Streamed even though WhatsApp cannot render tokens progressively: a
      // large max_tokens on a non-streaming request risks an HTTP timeout.
      const response = await getClient()
        .messages.stream({
          model: config.anthropic.model,
          max_tokens: config.anthropic.maxTokens,
          system: [{
            type: "text",
            text: buildSystemPrompt(),
            // Resent on every inbound message, so it is the cheapest win
            // available. Requires the prompt to stay byte-stable.
            cache_control: { type: "ephemeral" },
          }],
          messages,
          // Thinking is on by default on Opus 5 and disabling it has known
          // failure modes; `low` effort is the cheap setting for short chat.
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
        })
        .finalMessage();

      const usage: Usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        latencyMs: Date.now() - started,
      };

      // Guard the stop reason before reading content: on a refusal there may
      // be no content at all, and stop_details is null for every other reason.
      if (response.stop_reason === "refusal") {
        log.warn("claude_refused", { waId, category: response.stop_details?.category });
        recordEvent("warn", "claude_refused", {
          waId, category: response.stop_details?.category ?? null,
        });
        return { text: FALLBACK_REPLY, ok: false, usage };
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      log.info("claude_replied", {
        waId, attempt, turns: messages.length, stop: response.stop_reason, ...usage,
      });

      if (text === "") {
        log.warn("claude_empty_text", { waId, stop: response.stop_reason });
        recordEvent("warn", "claude_empty_text", { waId, stop: response.stop_reason });
        return { text: FALLBACK_REPLY, ok: false, usage };
      }

      return { text, ok: true, usage };
    } catch (err) {
      const detail = classifyError(err);
      lastKind = String(detail["kind"]);
      const willRetry = RETRYABLE.has(lastKind) && attempt < MAX_ATTEMPTS;

      log.error("claude_failed", { waId, attempt, willRetry, ...detail });
      if (!willRetry) {
        recordEvent("error", "claude_failed", { waId, ...detail });
        return { text: FALLBACK_REPLY, ok: false, usage: undefined };
      }
      await delay(attempt * 500);
    }
  }

  recordEvent("error", "claude_failed", { waId, kind: lastKind, exhausted: true });
  return { text: FALLBACK_REPLY, ok: false, usage: undefined };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Most specific first. Ordering is load-bearing: every one of these classes
 * extends APIError, so a broad APIError check placed above them would swallow
 * the distinctions that decide whether a retry is even worth attempting.
 */
export function classifyError(err: unknown): Record<string, unknown> {
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", status: err.status, hint: "Credential rejected - check ANTHROPIC_API_KEY" };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", status: err.status };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { kind: "not_found", status: err.status, hint: "Check ANTHROPIC_MODEL" };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: "connection", message: err.message };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return { kind: status >= 500 ? "server" : "api_error", status, message: err.message };
  }
  /**
   * No credential resolves to a plain Error thrown client-side - not any SDK
   * class - so it cannot be matched structurally. Inferred from known config
   * instead of by matching the message text, which would rot on any SDK
   * wording change. Worth distinguishing because it is the single most likely
   * failure on a fresh checkout.
   */
  if (!config.anthropic.hasEnvCredential) {
    return {
      kind: "no_credential",
      hint: "No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and no usable profile",
      message: String(err),
    };
  }
  return { kind: "unknown", message: String(err) };
}
