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
import { SYSTEM_PROMPT } from "./prompt.ts";

/**
 * Zero-arg constructor on purpose: the SDK resolves credentials itself
 * (ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an `ant auth login`
 * profile). Passing an explicit key here would break the profile path.
 */
const client = new Anthropic();

/** What the customer sees when the model call fails. */
export const FALLBACK_REPLY =
  "Sorry - I hit a technical problem just then. Please send that again in a moment, or say \"human\" and I'll pass you to someone.";

export interface ReplyResult {
  text: string;
  /** False when the fallback was used - the caller decides whether to store it. */
  ok: boolean;
}

export async function generateReply(waId: string): Promise<ReplyResult> {
  const messages = buildHistory(waId);

  if (messages.length === 0) {
    // Nothing replayable (e.g. the only message was media with no caption).
    return { text: FALLBACK_REPLY, ok: false };
  }

  const started = Date.now();

  try {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: SYSTEM_PROMPT,
      messages,
      // Thinking is on by default on Opus 5 and disabling it has real failure
      // modes; `low` effort is the cheap, fast setting for short support chat.
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });

    if (response.stop_reason === "refusal") {
      log.warn("claude_refused", { waId, category: response.stop_details?.category });
      recordEvent("warn", "claude_refused", {
        waId,
        category: response.stop_details?.category ?? null,
      });
      return { text: FALLBACK_REPLY, ok: false };
    }

    // content is a union - narrow before touching .text, and join in case the
    // model emits several text blocks.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    log.info("claude_replied", {
      waId,
      ms: Date.now() - started,
      turns: messages.length,
      in: response.usage.input_tokens,
      out: response.usage.output_tokens,
      cached: response.usage.cache_read_input_tokens ?? 0,
      stop: response.stop_reason,
    });

    if (text === "") {
      // Possible when the response is all thinking and max_tokens truncated it.
      log.warn("claude_empty_text", { waId, stop: response.stop_reason });
      recordEvent("warn", "claude_empty_text", { waId, stop: response.stop_reason });
      return { text: FALLBACK_REPLY, ok: false };
    }

    return { text, ok: true };
  } catch (err) {
    const detail = describe(err);
    log.error("claude_failed", { waId, ...detail });
    recordEvent("error", "claude_failed", { waId, ...detail });
    return { text: FALLBACK_REPLY, ok: false };
  }
}

/** Most specific error class first - the distinctions drive what you fix. */
function describe(err: unknown): Record<string, unknown> {
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", hint: "No valid ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN", status: err.status };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", status: err.status };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { kind: "not_found", hint: "Check ANTHROPIC_MODEL", status: err.status };
  }
  if (err instanceof Anthropic.APIError) {
    return { kind: "api_error", status: err.status, message: err.message };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: "connection", message: err.message };
  }
  return { kind: "unknown", message: String(err) };
}
