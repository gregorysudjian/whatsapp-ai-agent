/**
 * /api/admin/* - the platform owner's view across every client.
 *
 * Mounted behind requireAuth + requireSuperAdmin. Owners get a 404 here, the
 * same as for a path that does not exist.
 */

import { Router, type Request, type Response } from "express";
import { credentialSummary, listBusinesses } from "../store/businesses.ts";
import { listUsers } from "../store/users.ts";

export const adminRouter: Router = Router();

adminRouter.get("/businesses", (_req: Request, res: Response) => {
  res.json(listBusinesses().map((b) => ({
    ...b,
    // Redacted: proof a credential is set, never the credential.
    credentials: credentialSummary(b.id) ?? null,
    owners: listUsers(b.id).map((u) => ({ id: u.id, email: u.email, active: u.active })),
  })));
});
