/**
 * /api/b/:bid/* - everything an owner does with their own business.
 *
 * Mounted in app.ts behind requireAuth + requireBusinessAccess, so every
 * route added to this router is scoped by construction; authz.test.ts walks
 * this router's stack and proves it for each route, including ones added
 * later. Read the business with businessOf(req), never from the body.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { businessOf, clientIp, getAuth } from "../auth/middleware.ts";
import { getBusiness, updateBusinessProfile } from "../store/businesses.ts";
import { stats } from "../store/queries.ts";
import { getSchedule, getSettings, LANGUAGE_NAMES, setSchedule, setSettings } from "../store/settings.ts";
import { createService, deactivateService, listServices, updateService } from "../store/services.ts";
import { audit } from "../store/audit.ts";
import { buildContextBlock, buildSystemPrompt } from "../agent/prompt.ts";
import { body, handleError } from "./validate.ts";

// mergeParams: the :bid in the mount path is visible to requireBusinessAccess.
export const businessRouter: Router = Router({ mergeParams: true });

/** Audit a write by the logged-in user, against the scoped business. */
function record(req: Request, action: string, target?: string, detail?: Record<string, unknown>): void {
  audit({
    userId: getAuth(req).user.id, businessId: businessOf(req), action,
    target: target ?? null, detail: detail ?? null, ip: clientIp(req),
  });
}

function profile(bid: number) {
  const b = getBusiness(bid)!;
  return {
    id: b.id, name: b.name, status: b.status, timezone: b.timezone,
    defaultLanguage: b.defaultLanguage, connected: b.hasCredentials,
  };
}

businessRouter.get("/summary", (req: Request, res: Response) => {
  const bid = businessOf(req);
  res.json({ business: profile(bid), stats: stats(bid) });
});

// --- agent settings -----------------------------------------------------------

businessRouter.get("/settings", (req: Request, res: Response) => {
  const bid = businessOf(req);
  res.json({
    business: profile(bid),
    settings: getSettings(bid),
    schedule: getSchedule(bid),
    services: listServices(bid, true),
    languageNames: LANGUAGE_NAMES,
  });
});

const ProfileBody = z.object({
  name: z.string(),
  timezone: z.string(),
  defaultLanguage: z.enum(["en", "fr"]),
}).strict();

const SettingsBody = z.object({
  business: ProfileBody.optional(),
  settings: z.unknown(),
}).strict();

businessRouter.put("/settings", (req: Request, res: Response) => {
  const input = body(SettingsBody, req, res);
  if (!input) return;
  const bid = businessOf(req);
  try {
    // Settings first: if they are invalid, the profile is not half-saved.
    const settings = setSettings(bid, input.settings);
    if (input.business) updateBusinessProfile(bid, input.business);
    record(req, "settings_updated");
    res.json({ business: profile(bid), settings });
  } catch (err) {
    handleError(err, res);
  }
});

businessRouter.put("/schedule", (req: Request, res: Response) => {
  const bid = businessOf(req);
  try {
    const schedule = setSchedule(bid, req.body);
    record(req, "schedule_updated");
    res.json({ schedule });
  } catch (err) {
    handleError(err, res);
  }
});

/** Exactly what the agent is told - so an owner can check it, word for word. */
businessRouter.get("/settings/preview", (req: Request, res: Response) => {
  const bid = businessOf(req);
  const b = getBusiness(bid)!;
  res.json({
    prompt: buildSystemPrompt({
      businessName: b.name, timezone: b.timezone,
      settings: getSettings(bid), schedule: getSchedule(bid), services: listServices(bid),
    }),
    context: buildContextBlock(b.timezone),
  });
});

// --- services -----------------------------------------------------------------

const serviceId = (req: Request) => {
  const raw = req.params["id"];
  return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
};

businessRouter.get("/services", (req: Request, res: Response) => {
  res.json({ services: listServices(businessOf(req), true) });
});

businessRouter.post("/services", (req: Request, res: Response) => {
  try {
    const service = createService(businessOf(req), req.body);
    record(req, "service_created", String(service.id), { name: service.name });
    res.status(201).json({ service });
  } catch (err) {
    handleError(err, res);
  }
});

businessRouter.put("/services/:id", (req: Request, res: Response) => {
  try {
    const service = updateService(businessOf(req), serviceId(req), req.body);
    if (!service) {
      res.status(404).json({ error: "service_not_found" });
      return;
    }
    record(req, "service_updated", String(service.id), { name: service.name });
    res.json({ service });
  } catch (err) {
    handleError(err, res);
  }
});

businessRouter.delete("/services/:id", (req: Request, res: Response) => {
  const id = serviceId(req);
  if (!deactivateService(businessOf(req), id)) {
    res.status(404).json({ error: "service_not_found" });
    return;
  }
  record(req, "service_deactivated", String(id));
  res.json({ ok: true });
});
