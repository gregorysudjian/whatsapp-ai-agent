/**
 * Environment config. Fails loudly at boot rather than at the first webhook -
 * a missing token should not look like "the bot just doesn't reply".
 */

import crypto from "node:crypto";

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

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),
  logLevel: optional("LOG_LEVEL", "info"),
  dbPath: optional("DB_PATH", "./data/agent.db"),

  dashboard: {
    /**
     * Never unauthenticated. A loopback-only check would be worthless here:
     * cloudflared runs on this machine, so tunnelled requests also arrive from
     * 127.0.0.1 - an "is local" guard would admit the whole internet. When no
     * token is configured we mint one per boot and log it.
     */
    token: optional("DASHBOARD_TOKEN", crypto.randomBytes(16).toString("hex")),
    tokenWasGenerated: !process.env["DASHBOARD_TOKEN"]?.trim(),
  },

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

  whatsapp: {
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    appSecret: required("WHATSAPP_APP_SECRET"),
    graphVersion: optional("GRAPH_API_VERSION", "v23.0"),
  },
} as const;

/**
 * Overridable so the suite can point the client at a local mock and exercise
 * sending, chunking, wamid capture and retry over a real socket. Unset in
 * production, where it resolves to the real Graph host.
 */
export const graphBaseUrl = optional(
  "GRAPH_BASE_URL",
  `https://graph.facebook.com/${config.whatsapp.graphVersion}`,
);
