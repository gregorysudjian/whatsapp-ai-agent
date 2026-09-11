/**
 * Phase 3/4: Claude generates the reply, calling business tools as needed.
 *
 * The channel layer never reaches in here - this takes a conversation id and
 * returns text, so the same agent can sit behind SMS or web chat later.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { recordEvent, type BusinessId } from "../store/db.ts";
import { getBusiness } from "../store/businesses.ts";
import { getSchedule, getSettings } from "../store/settings.ts";
import { listServices } from "../store/services.ts";
import { buildHistory } from "./memory.ts";
import { buildContextBlock, buildSystemPrompt } from "./prompt.ts";
import { TOOLS, executeTool, type ToolContext } from "./tools.ts";

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
  /** True when a tool handed the conversation to a person. */
  handoff: boolean;
}

const RETRYABLE = new Set(["rate_limit", "connection", "server"]);
const MAX_ATTEMPTS = 2;

/**
 * A runaway tool loop is real money, so it is capped rather than trusted to
 * terminate. Five is comfortably more than any flow here needs: check
 * availability, book, confirm.
 */
const MAX_TOOL_ITERATIONS = 5;

export async function generateReply(
  businessId: BusinessId,
  waId: string,
  senderName?: string,
): Promise<ReplyResult> {
  const messages = buildHistory(businessId, waId);
  const ctx: ToolContext = { businessId, waId, senderName };
  // Built once per turn from this business's own saved settings. Byte-stable
  // between edits, so the prompt cache holds per client. The clock goes in a
  // second block after the cache breakpoint: it changes every minute, and it
  // is how the agent turns "tomorrow at 10" into a date.
  const business = getBusiness(businessId);
  const timezone = business?.timezone ?? "America/Toronto";
  const systemPrompt = buildSystemPrompt({
    businessName: business?.name ?? "this business",
    timezone,
    settings: getSettings(businessId),
    schedule: getSchedule(businessId),
    services: listServices(businessId),
  });
  const contextBlock = buildContextBlock(timezone);

  if (messages.length === 0) {
    // Nothing replayable (e.g. the only message was media with no caption).
    return { text: FALLBACK_REPLY, ok: false, usage: undefined, handoff: false };
  }

  let lastKind = "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();

    // Accumulated across the turn: a tool round trip is several calls, and
    // the conversation paid for all of them.
    const total: Usage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, latencyMs: 0,
    };
    let handoff = false;

    try {
      for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
        // Streamed even though WhatsApp cannot render tokens progressively: a
        // large max_tokens on a non-streaming request risks an HTTP timeout.
        const response = await getClient()
          .messages.stream({
            model: config.anthropic.model,
            max_tokens: config.anthropic.maxTokens,
            system: [{
              type: "text",
              text: systemPrompt,
              // Resent on every inbound message, so it is the cheapest win
              // available. Requires the prompt to stay byte-stable.
              cache_control: { type: "ephemeral" },
            }, {
              type: "text",
              text: contextBlock,
            }],
            messages,
            tools: TOOLS,
            // Thinking is on by default on Opus 5 and disabling it has known
            // failure modes. `medium` rather than `low` because tool choice
            // benefits from a step up; plain chat would not.
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
          })
          .finalMessage();

        total.inputTokens += response.usage.input_tokens;
        total.outputTokens += response.usage.output_tokens;
        total.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
        total.latencyMs = Date.now() - started;

        // Guard the stop reason before reading content: on a refusal there
        // may be no content at all, and stop_details is null otherwise.
        if (response.stop_reason === "refusal") {
          log.warn("claude_refused", { businessId, waId, category: response.stop_details?.category });
          recordEvent(businessId, "warn", "claude_refused", {
            waId, category: response.stop_details?.category ?? null,
          });
          return { text: FALLBACK_REPLY, ok: false, usage: total, handoff };
        }

        if (response.stop_reason === "tool_use") {
          const calls = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          // Echo the assistant turn back verbatim, thinking blocks included -
          // stripping them breaks the next request on a thinking model.
          messages.push({ role: "assistant", content: response.content });

          // All results go back in ONE user message. Splitting them across
          // several teaches the model to stop making parallel calls.
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const call of calls) {
            const outcome = executeTool(call.name, call.input, ctx);
            if (outcome.handoff) handoff = true;
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: outcome.content,
            });
          }
          messages.push({ role: "user", content: results });

          log.info("tool_iteration", { waId, iteration, tools: calls.map((c) => c.name) });
          continue;
        }

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();

        log.info("claude_replied", {
          businessId, waId, attempt, iterations: iteration, turns: messages.length,
          stop: response.stop_reason, ...total,
        });

        if (text === "") {
          log.warn("claude_empty_text", { waId, stop: response.stop_reason });
          recordEvent(businessId, "warn", "claude_empty_text", { waId, stop: response.stop_reason });
          return { text: FALLBACK_REPLY, ok: false, usage: total, handoff };
        }

        return { text, ok: true, usage: total, handoff };
      }

      // Fell out of the loop still asking for tools.
      log.warn("tool_loop_exhausted", { waId, cap: MAX_TOOL_ITERATIONS });
      recordEvent(businessId, "warn", "tool_loop_exhausted", { waId, cap: MAX_TOOL_ITERATIONS });
      return { text: FALLBACK_REPLY, ok: false, usage: total, handoff };
    } catch (err) {
      const detail = classifyError(err);
      lastKind = String(detail["kind"]);
      const willRetry = RETRYABLE.has(lastKind) && attempt < MAX_ATTEMPTS;

      log.error("claude_failed", { businessId, waId, attempt, willRetry, ...detail });
      if (!willRetry) {
        recordEvent(businessId, "error", "claude_failed", { waId, ...detail });
        return { text: FALLBACK_REPLY, ok: false, usage: undefined, handoff };
      }
      await delay(attempt * 500);
    }
  }

  recordEvent(businessId, "error", "claude_failed", { waId, kind: lastKind, exhausted: true });
  return { text: FALLBACK_REPLY, ok: false, usage: undefined, handoff: false };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Most specific first. Ordering is load-bearing: every one of these classes
 * extends APIError, so a broad APIError check placed above them would swallow
 * the distinctions that decide whether a retry is even worth attempting.
 */
export function classifyError(err: unknown): Record<string, unknown> {
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", status: err.status, hint: "Credential rejected - check ANTHROPIC_AUTH_TOKEN" };
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
      hint: "No ANTHROPIC_AUTH_TOKEN in .env",
      message: String(err),
    };
  }
  return { kind: "unknown", message: String(err) };
}
