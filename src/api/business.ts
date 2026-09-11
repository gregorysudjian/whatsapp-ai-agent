/**
 * /api/b/:bid/* - everything an owner does with their own business.
 *
 * Mounted in app.ts behind requireAuth + requireBusinessAccess, so every
 * route added to this router is scoped by construction; authz.test.ts walks
 * this router's stack and proves it for each route, including ones added
 * later. Read the business with businessOf(req), never from the body.
 */

import { Router, type Request, type Response } from "express";
import { businessOf } from "../auth/middleware.ts";
import { getBusiness } from "../store/businesses.ts";
import { stats } from "../store/queries.ts";

// mergeParams: the :bid in the mount path is visible to requireBusinessAccess.
export const businessRouter: Router = Router({ mergeParams: true });

businessRouter.get("/summary", (req: Request, res: Response) => {
  const bid = businessOf(req);
  const business = getBusiness(bid)!;
  res.json({
    business: {
      id: business.id, name: business.name, status: business.status,
      timezone: business.timezone, defaultLanguage: business.defaultLanguage,
      connected: business.hasCredentials,
    },
    stats: stats(bid),
  });
});
