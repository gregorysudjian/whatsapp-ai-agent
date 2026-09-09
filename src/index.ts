import { config, prunedCredentials } from "./config.ts";
import { log } from "./logger.ts";
import { createApp } from "./app.ts";
import { personaIsConfigured } from "./agent/persona.ts";

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
      hint: "Set ANTHROPIC_API_KEY in .env (or run `ant auth login`). Until then every reply is the fallback message.",
      model: config.anthropic.model,
    });
  }

  if (!personaIsConfigured()) {
    log.warn("persona_not_configured", {
      hint: "Edit src/agent/persona.ts - the agent will not state hours, prices or an address it has not been given.",
    });
  }

  const url = `http://localhost:${config.port}/dashboard?token=${config.dashboard.token}`;
  log.info("dashboard_ready", { url });
  if (config.dashboard.tokenWasGenerated) {
    log.warn("dashboard_token_generated", {
      hint: "Set DASHBOARD_TOKEN in .env to keep one URL across restarts.",
    });
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("shutting_down", { signal });
    process.exit(0);
  });
}
