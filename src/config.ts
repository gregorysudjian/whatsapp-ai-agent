/**
 * Environment config. Fails loudly at boot rather than at the first webhook -
 * a missing token should not look like "the bot just doesn't reply".
 */

import { parseKey } from "./security/crypto.ts";

/**
 * Credential env vars that are present but empty are worse than absent.
 *
 * The Anthropic SDK resolves credentials in a fixed order - ANTHROPIC_API_KEY,
 * then ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk. An
 * empty string still occupies its slot: the SDK authenticates with "" and the
 * profile behind it is never consulted. `.env` files invite exactly this,
 * because a commented-out key is usually left as `KEY=`.
 *
 * Scoped deliberately to the credential chain rather than every empty var -
 * elsewhere "" can be a legitimate value.
 */
export function pruneEmptyCredentials(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const pruned: string[] = [];
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ]) {
    if (env[key] !== undefined && env[key]?.trim() === "") {
      delete env[key];
      pruned.push(key);
    }
  }
  return pruned;
}

/** Runs at import, before any SDK client is constructed. */
export const prunedCredentials = pruneEmptyCredentials();

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),
  logLevel: optional("LOG_LEVEL", "info"),
  dbPath: optional("DB_PATH", "./data/agent.db"),

  anthropic: {
    model: optional("ANTHROPIC_MODEL", "claude-opus-5"),
    // Thinking tokens count against max_tokens, so a WhatsApp-sized cap
    // would risk truncating mid-thought. Brevity comes from the prompt.
    maxTokens: Number(optional("ANTHROPIC_MAX_TOKENS", "8192")),
    /**
     * Not `required()`: the SDK also accepts an `ant auth login` profile that
     * lives on disk with no env var set, so absence here is a warning at boot,
     * not a crash. A truly missing credential surfaces as an auth error on the
     * first message, with the customer getting the fallback reply.
     */
    hasEnvCredential: Boolean(
      process.env["ANTHROPIC_API_KEY"]?.trim() ||
        process.env["ANTHROPIC_AUTH_TOKEN"]?.trim(),
    ),
  },

  security: {
    /**
     * Required, and parsed at boot: every stored WhatsApp credential is
     * encrypted with it, so running without one would either fail on the
     * first message or tempt a plaintext fallback. Neither is acceptable.
     */
    encryptionKey: parseKey(process.env["APP_ENCRYPTION_KEY"]),
  },

  /**
   * Seed for the DEFAULT business only, and optional.
   *
   * Credentials now live per business in the database, encrypted. These env
   * vars exist so an install that predates multi-tenancy keeps working: at
   * boot they create or refresh the default business. New clients are added
   * through the admin panel (or `npm run business`), never through env.
   */
  seedWhatsapp: {
    phoneNumberId: optional("WHATSAPP_PHONE_NUMBER_ID", ""),
    businessAccountId: optional("WHATSAPP_BUSINESS_ACCOUNT_ID", ""),
    accessToken: optional("WHATSAPP_ACCESS_TOKEN", ""),
    verifyToken: optional("WHATSAPP_VERIFY_TOKEN", ""),
    appSecret: optional("WHATSAPP_APP_SECRET", ""),
    graphVersion: optional("GRAPH_API_VERSION", "v23.0"),
  },
} as const;

/**
 * Overridable so the suite can point the client at a local mock and exercise
 * sending, chunking, wamid capture and retry over a real socket. Unset in
 * production, where each business's own Graph version is used.
 */
export const graphBaseOverride: string | undefined =
  process.env["GRAPH_BASE_URL"]?.trim() || undefined;

export function graphBaseFor(graphVersion: string): string {
  return graphBaseOverride ?? `https://graph.facebook.com/${graphVersion}`;
}
