/**
 * /api/google/callback - where Google sends the browser back after consent.
 *
 * Not behind requireAuth: the session cookie is SameSite=Strict, so the
 * browser does not send it on this cross-site redirect. The single-use state
 * created by "Connect" (see calendar/google.ts) is what identifies the
 * business and the person, and the owner lands back on the settings page,
 * signed in as before.
 */

import { Router, type Request, type Response } from "express";
import { CalendarError, finishConnect } from "../calendar/google.ts";
import { readCookie } from "../auth/middleware.ts";
import { OAUTH_COOKIE, oauthCookieOptions } from "./oauth-cookie.ts";
import { audit } from "../store/audit.ts";
import { clientIp } from "../auth/middleware.ts";
import { log } from "../logger.ts";

export const googleRouter: Router = Router();

googleRouter.get("/callback", async (req: Request, res: Response) => {
  const q = req.query;
  const state = typeof q["state"] === "string" ? q["state"] : "";
  const code = typeof q["code"] === "string" ? q["code"] : "";
  // Single use, like the state it vouches for.
  const binding = readCookie(req, OAUTH_COOKIE);
  res.clearCookie(OAUTH_COOKIE, oauthCookieOptions());
  const back = (bid: number | null, outcome: string) =>
    res.redirect(303, bid ? `/b/${bid}/settings?tab=calendar&google=${encodeURIComponent(outcome)}` : `/?google=${encodeURIComponent(outcome)}`);

  if (typeof q["error"] === "string") {
    // The owner pressed Cancel on Google's screen. The state is left to expire.
    back(null, "cancelled");
    return;
  }
  try {
    const { businessId, userId } = await finishConnect(code, state, binding);
    audit({ userId, businessId, action: "calendar_connected", target: null, detail: null, ip: clientIp(req) });
    back(businessId, "connected");
  } catch (err) {
    const reason = err instanceof CalendarError ? err.code : "error";
    log.warn("calendar_connect_failed", { reason });
    back(null, reason);
  }
});
