import { config, prunedCredentials } from "./config.ts";
import { log } from "./logger.ts";
import { createApp } from "./app.ts";
import { listBusinesses, seedDefaultBusiness } from "./store/businesses.ts";
import { getSettings, isConfigured } from "./store/settings.ts";

// Before the app starts taking webhooks: carries a pre-multi-tenancy install's
// env credentials and hardcoded facts into business #1.
seedDefaultBusiness();

const app = createApp();

app.listen(config.port, () => {
  log.info("server_started", { port: config.port });

  if (prunedCredentials.length > 0) {
    log.warn("empty_credential_vars_pruned", {
      vars: prunedCredentials,
      why: "A present-but-empty value shadows every later source in the SDK credential chain.",
    });
  }

  if (!config.anthropic.hasEnvCredential) {
    log.warn("anthropic_credential_missing", {
      hint: "Set ANTHROPIC_AUTH_TOKEN in .env. Until then every reply is the fallback message.",
      model: config.anthropic.model,
    });
  }

  // One line per client: the URL to paste into that client's Meta app, and
  // anything that would stop its agent working.
  for (const b of listBusinesses()) {
    log.info("business", {
      id: b.id,
      name: b.name,
      status: b.status,
      webhook: `/webhook/b/${b.publicId}`,
      connected: b.hasCredentials,
      ...(isConfigured(getSettings(b.id)) ? {} : { warning: "settings not filled in - the agent does not know what this business does" }),
    });
  }

  log.info("dashboard_ready", { url: `http://localhost:${config.port}/` });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("shutting_down", { signal });
    process.exit(0);
  });
}
