/**
 * Dashboard: a read-only view of the agent, served by the agent itself.
 *
 * Every route here is gated by a token. See config.dashboard for why an
 * "only allow localhost" guard would be actively dangerous behind a tunnel.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import { subscribe } from "../core/events.ts";
import {
  listConversations, listEvents, listMessages, listRecentMessages, stats,
} from "../store/queries.ts";
import { agentEnabled, clearHandoff, setAgentEnabled } from "../store/db.ts";

export const dashboardRouter: Router = Router();

const COOKIE = "wa_dash";

function tokenOk(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.dashboard.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(header: string | undefined): string | undefined {
  return header
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE)?.[1];
}

/**
 * Accepts the token from a query param (the link you click), a header
 * (programmatic use), or a cookie set on first visit - EventSource can't send
 * custom headers, so the cookie is what keeps the live stream authenticated.
 */
function guard(req: Request, res: Response, next: NextFunction): void {
  const supplied =
    (typeof req.query["token"] === "string" ? req.query["token"] : undefined) ??
    req.get("x-dashboard-token") ??
    readCookie(req.get("cookie"));

  if (!tokenOk(supplied)) {
    log.warn("dashboard_denied", { path: req.path, ip: req.socket.remoteAddress });
    res.status(401).type("text/plain").send("Unauthorized - append ?token=<DASHBOARD_TOKEN>");
    return;
  }

  if (typeof req.query["token"] === "string") {
    // HttpOnly would break nothing here, but SameSite=Strict matters: it stops
    // another site from silently pulling your conversation list.
    res.cookie?.(COOKIE, config.dashboard.token, {
      httpOnly: true, sameSite: "strict", maxAge: 12 * 60 * 60 * 1000,
    });
  }
  next();
}

dashboardRouter.use("/dashboard", guard);
dashboardRouter.use("/api", guard);

const here = path.dirname(fileURLToPath(import.meta.url));

dashboardRouter.get("/dashboard", (_req, res) => {
  // Read per request so editing the UI needs no restart.
  const file = path.join(here, "ui.html");
  fs.readFile(file, "utf8", (err, html) => {
    if (err) {
      log.error("dashboard_ui_missing", { file, err: String(err) });
      res.sendStatus(500);
      return;
    }
    res.type("html").send(html);
  });
});

dashboardRouter.get("/api/stats", (_req, res) => {
  res.json({
    ...stats(),
    phoneNumberId: config.whatsapp.phoneNumberId,
    graphVersion: config.whatsapp.graphVersion,
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
  });
});

dashboardRouter.get("/api/conversations", (_req, res) => {
  res.json(listConversations());
});

dashboardRouter.get("/api/conversations/:waId/messages", (req, res) => {
  res.json(listMessages(req.params.waId));
});

dashboardRouter.get("/api/recent", (_req, res) => {
  res.json(listRecentMessages(50));
});

dashboardRouter.get("/api/events", (_req, res) => {
  res.json(listEvents(150));
});

/**
 * The only two writes on an otherwise read-only surface, both behind the same
 * token guard. The kill switch has to be reachable from the dashboard - a
 * stop button you have to SSH in to press is not a stop button.
 */
dashboardRouter.post("/api/agent/toggle", (req, res) => {
  const body = req.body as { enabled?: unknown } | undefined;
  const next = typeof body?.enabled === "boolean" ? body.enabled : !agentEnabled();

  setAgentEnabled(next);
  log.warn("agent_toggled", { enabled: next, via: "dashboard" });
  res.json({ agentEnabled: next });
});

dashboardRouter.post("/api/conversations/:waId/clear-handoff", (req, res) => {
  clearHandoff(req.params.waId);
  log.info("handoff_cleared", { waId: req.params.waId, via: "dashboard" });
  res.json({ ok: true, waId: req.params.waId });
});

/** Server-sent events: one line per agent event, so the UI never polls. */
dashboardRouter.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Without this, a proxy can sit on the stream waiting for a buffer to fill.
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Comment frames keep idle connections from being reaped by intermediaries.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
