import express, { type Request } from "express";
import { config } from "./config.ts";
import { log } from "./logger.ts";
import { webhookRouter } from "./whatsapp/webhook.ts";
import { dashboardRouter } from "./dashboard/router.ts";

const app = express();

// Keep the raw bytes around - the signature is computed over them, and
// JSON.stringify(req.body) is not guaranteed to reproduce them byte for byte.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use(webhookRouter);
app.use(dashboardRouter);

app.listen(config.port, () => {
  log.info("server_started", { port: config.port });

  if (!config.anthropic.hasEnvCredential) {
    log.warn("anthropic_credential_missing", {
      hint: "Set ANTHROPIC_API_KEY in .env (or run `ant auth login`). Until then every reply is the fallback message.",
      model: config.anthropic.model,
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
