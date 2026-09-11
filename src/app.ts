/**
 * Builds the Express app without binding a port, so tests can drive the real
 * routing, signature check and handler over a socket of their own choosing.
 * Bootstrapping lives in index.ts.
 */

import express, { type Request } from "express";
import { log } from "./logger.ts";
import { webhookRouter } from "./whatsapp/webhook.ts";
import { dashboardRouter } from "./dashboard/router.ts";
import {
  originCheck, requireAuth, requireBusinessAccess, requireSuperAdmin, securityHeaders, session,
} from "./auth/middleware.ts";
import { authRouter } from "./auth/routes.ts";
import { businessRouter } from "./api/business.ts";
import { adminRouter } from "./api/admin.ts";
import { webApp } from "./web.ts";

export function createApp(): express.Express {
  const app = express();

  // Behind a reverse proxy in production (TRUST_PROXY=1) so req.ip is the
  // client, not the proxy - which the login throttle depends on.
  if (process.env["TRUST_PROXY"] === "1") app.set("trust proxy", 1);

  app.use(securityHeaders);

  // Keep the raw bytes around - the signature is computed over them, and
  // JSON.stringify(req.body) is not guaranteed to reproduce them byte for byte.
  app.use(
    express.json({
      limit: "256kb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.use(webhookRouter);

  // --- the dashboard API ----------------------------------------------------
  app.use("/api", session, originCheck);
  app.use("/api/auth", authRouter);
  // Every client-data route is mounted here and nowhere else: scope is
  // decided once, by the middleware, before any handler runs.
  app.use("/api/b/:bid", requireAuth, requireBusinessAccess, businessRouter);
  app.use("/api/admin", requireAuth, requireSuperAdmin, adminRouter);

  app.use(dashboardRouter);
  // After every real /api route (the legacy dashboard's included): an unknown
  // /api path is a JSON 404, not the app's HTML shell.
  app.use("/api", (_req, res) => { res.status(404).json({ error: "not_found" }); });
  // Last: the built dashboard, and its client-side routes.
  app.use(webApp());

  log.debug("app_created");
  return app;
}
