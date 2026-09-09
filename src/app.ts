/**
 * Builds the Express app without binding a port, so tests can drive the real
 * routing, signature check and handler over a socket of their own choosing.
 * Bootstrapping lives in index.ts.
 */

import express, { type Request } from "express";
import { log } from "./logger.ts";
import { webhookRouter } from "./whatsapp/webhook.ts";
import { dashboardRouter } from "./dashboard/router.ts";

export function createApp(): express.Express {
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

  log.debug("app_created");
  return app;
}
