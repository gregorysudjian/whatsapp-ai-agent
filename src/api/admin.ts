/**
 * /api/admin/* - the platform owner's view across every client.
 *
 * Mounted behind requireAuth + requireSuperAdmin. Owners get a 404 here, the
 * same as for a path that does not exist; authz.test.ts walks this router's
 * stack and proves it for every route, including ones added later.
 *
 * Secrets go in, never out: the credentials form is write-only, and every
 * response carries at most the redacted summary. A temporary password is
 * returned once, by the request that created it, and stored only as a hash.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { clientIp, getAuth } from "../auth/middleware.ts";
import { destroyAllSessions } from "../auth/sessions.ts";
import { generatePassword } from "../auth/passwords.ts";
import {
  createBusiness, credentialSummary, getBusiness, listBusinesses, setBusinessStatus, setWhatsappCredentials,
  updateBusinessProfile, type Business,
} from "../store/businesses.ts";
import { createUser, getUser, listUsers, setPassword, setUserActive } from "../store/users.ts";
import { audit, auditActions, searchAudit } from "../store/audit.ts";
import { usageForMonth } from "../store/usage.ts";
import { wallClockNow } from "../store/bookings.ts";
import { body, handleError, query } from "./validate.ts";
import { toCsv } from "./csv.ts";

export const adminRouter: Router = Router();

function record(req: Request, action: string, businessId: number | null, target?: string, detail?: Record<string, unknown>): void {
  audit({ userId: getAuth(req).user.id, businessId, action, target: target ?? null, detail: detail ?? null, ip: clientIp(req) });
}

const idParam = (req: Request, name = "id") => {
  const raw = req.params[name];
  return typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
};

/** The current month where the platform runs its books (UTC is as good as any). */
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** A client as the admin sees it: redacted credentials, owners, and this month so far. */
function clientView(b: Business, usage?: ReturnType<typeof usageForMonth>[number]) {
  return {
    ...b,
    webhookPath: `/webhook/b/${b.publicId}`,
    credentials: credentialSummary(b.id) ?? null,
    owners: listUsers(b.id).map((u) => ({
      id: u.id, email: u.email, name: u.name, active: u.active, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt,
    })),
    usage: usage ?? usageForMonth(thisMonth(), [b.id])[0] ?? null,
  };
}

function found(res: Response, id: number): Business | undefined {
  const b = Number.isNaN(id) ? undefined : getBusiness(id);
  if (!b) res.status(404).json({ error: "no_such_business" });
  return b;
}

// --- clients --------------------------------------------------------------------

adminRouter.get("/businesses", (_req: Request, res: Response) => {
  const usage = new Map(usageForMonth(thisMonth()).map((u) => [u.businessId, u]));
  res.json({ businesses: listBusinesses().map((b) => clientView(b, usage.get(b.id))), month: thisMonth() });
});

adminRouter.get("/businesses/:id", (req: Request, res: Response) => {
  const b = found(res, idParam(req));
  if (b) res.json({ business: clientView(b) });
});

const NewClient = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().min(1).max(64).default("America/Toronto"),
  defaultLanguage: z.enum(["en", "fr"]).default("en"),
}).strict();

adminRouter.post("/businesses", (req: Request, res: Response) => {
  const input = body(NewClient, req, res);
  if (!input) return;
  try {
    const b = createBusiness(input);
    record(req, "business_created", b.id, String(b.id), { name: b.name });
    res.status(201).json({ business: clientView(b) });
  } catch (err) {
    handleError(err, res);
  }
});

const EditClient = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  defaultLanguage: z.enum(["en", "fr"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).strict();

adminRouter.patch("/businesses/:id", (req: Request, res: Response) => {
  const input = body(EditClient, req, res);
  if (!input) return;
  const b = found(res, idParam(req));
  if (!b) return;
  try {
    if (input.name !== undefined || input.timezone !== undefined || input.defaultLanguage !== undefined) {
      updateBusinessProfile(b.id, {
        name: input.name ?? b.name, timezone: input.timezone ?? b.timezone, defaultLanguage: input.defaultLanguage ?? b.defaultLanguage,
      });
    }
    if (input.status && input.status !== b.status) {
      setBusinessStatus(b.id, input.status);
      record(req, input.status === "active" ? "business_activated" : "business_deactivated", b.id, String(b.id));
    }
    record(req, "business_updated", b.id, String(b.id), { fields: Object.keys(input) });
    res.json({ business: clientView(getBusiness(b.id)!) });
  } catch (err) {
    handleError(err, res);
  }
});

const Credentials = z.object({
  phoneNumberId: z.string().trim().min(1).max(40),
  businessAccountId: z.string().trim().max(40).optional(),
  accessToken: z.string().trim().min(1).max(1024),
  appSecret: z.string().trim().min(1).max(1024),
  verifyToken: z.string().trim().min(1).max(1024),
  graphVersion: z.string().trim().max(10).optional(),
}).strict();

/** Write-only: the response proves what was stored without repeating it. */
adminRouter.put("/businesses/:id/credentials", (req: Request, res: Response) => {
  const input = body(Credentials, req, res);
  if (!input) return;
  const b = found(res, idParam(req));
  if (!b) return;
  try {
    setWhatsappCredentials(b.id, { ...input, businessAccountId: input.businessAccountId || undefined, graphVersion: input.graphVersion || undefined });
    // The phone number id is not a secret; the tokens never enter the audit log.
    record(req, "credentials_updated", b.id, String(b.id), { phoneNumberId: input.phoneNumberId });
    res.json({ business: clientView(getBusiness(b.id)!) });
  } catch (err) {
    handleError(err, res);
  }
});

// --- owners ------------------------------------------------------------------------

const NewOwner = z.object({
  email: z.email().max(254),
  name: z.string().trim().max(120).optional(),
  locale: z.enum(["en", "fr"]).optional(),
}).strict();

adminRouter.post("/businesses/:id/owners", async (req: Request, res: Response) => {
  const input = body(NewOwner, req, res);
  if (!input) return;
  const b = found(res, idParam(req));
  if (!b) return;
  const temporaryPassword = generatePassword();
  try {
    const user = await createUser({
      email: input.email, password: temporaryPassword, role: "owner", businessId: b.id,
      name: input.name ?? null, locale: input.locale ?? b.defaultLanguage, mustChangePassword: true,
    });
    record(req, "owner_created", b.id, String(user.id), { email: user.email });
    // Shown once, here. The owner must replace it at first sign-in.
    res.status(201).json({ user: { id: user.id, email: user.email }, temporaryPassword });
  } catch (err) {
    handleError(err, res);
  }
});

function ownerOr404(req: Request, res: Response) {
  const user = getUser(idParam(req));
  // Super admins are managed from the command line, not here.
  if (!user || user.role !== "owner") {
    res.status(404).json({ error: "no_such_user" });
    return undefined;
  }
  return user;
}

adminRouter.post("/users/:id/reset-password", async (req: Request, res: Response) => {
  const user = ownerOr404(req, res);
  if (!user) return;
  const temporaryPassword = generatePassword();
  await setPassword(user.id, temporaryPassword, true);
  destroyAllSessions(user.id);
  record(req, "password_reset", user.businessId, String(user.id), { email: user.email });
  res.json({ user: { id: user.id, email: user.email }, temporaryPassword });
});

adminRouter.patch("/users/:id", (req: Request, res: Response) => {
  const input = body(z.object({ active: z.boolean() }).strict(), req, res);
  if (!input) return;
  const user = ownerOr404(req, res);
  if (!user) return;
  setUserActive(user.id, input.active);
  if (!input.active) destroyAllSessions(user.id);
  record(req, input.active ? "user_activated" : "user_deactivated", user.businessId, String(user.id), { email: user.email });
  res.json({ user: { id: user.id, email: user.email, active: input.active } });
});

// --- usage and billing ------------------------------------------------------------------

const MonthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month like 2030-09").optional() });

adminRouter.get("/usage", (req: Request, res: Response) => {
  const input = query(MonthQuery, req, res);
  if (!input) return;
  const month = input.month ?? thisMonth();
  const rows = usageForMonth(month);
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + Number(r[k]), 0);
  res.json({
    month,
    rows,
    totals: {
      inbound: sum("inbound"), aiReplies: sum("aiReplies"), humanReplies: sum("humanReplies"), templateSends: sum("templateSends"),
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedTokens: sum("cachedTokens"),
      estimatedCostUsd: Number(sum("estimatedCostUsd").toFixed(4)),
    },
  });
});

adminRouter.get("/usage.csv", (req: Request, res: Response) => {
  const input = query(MonthQuery, req, res);
  if (!input) return;
  const month = input.month ?? thisMonth();
  const rows = usageForMonth(month);
  const csv = toCsv(
    ["Month", "Client", "Status", "Messages received", "Agent replies", "Team replies", "Template sends", "Input tokens", "Output tokens", "Cached tokens", "Estimated model cost (USD)"],
    rows.map((r) => [month, r.name, r.status, r.inbound, r.aiReplies, r.humanReplies, r.templateSends, r.inputTokens, r.outputTokens, r.cachedTokens, r.estimatedCostUsd.toFixed(2)]),
  );
  record(req, "usage_exported", null, month);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="usage-${month}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(csv);
});

// --- audit ----------------------------------------------------------------------------

const AuditQuery = z.object({
  businessId: z.coerce.number().int().positive().optional(),
  action: z.string().regex(/^[a-z_]{1,60}$/).optional(),
  before: z.coerce.number().int().positive().optional(),
});

adminRouter.get("/audit", (req: Request, res: Response) => {
  const input = query(AuditQuery, req, res);
  if (!input) return;
  const rows = searchAudit({ businessId: input.businessId ?? null, action: input.action ?? null, before: input.before ?? null, limit: 100 });
  res.json({
    entries: rows,
    actions: auditActions(),
    businesses: listBusinesses().map((b) => ({ id: b.id, name: b.name })),
    // Where the next page starts; null at the end.
    next: rows.length === 100 ? rows[rows.length - 1]!.id : null,
    now: wallClockNow("UTC"),
  });
});
