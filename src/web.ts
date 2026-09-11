/**
 * Serves the built dashboard (web/dist) and hands every other browser route
 * to it, so deep links like /b/1/inbox work on reload.
 *
 * Hashed assets are cached for a year - their names change when their
 * content does. index.html is never cached, or a deploy would keep serving
 * the old app to anyone who had it open.
 */

import express, { type Request, type Response, type NextFunction, type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/web.ts and dist/web.js both sit one level below the project root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const webDist = path.join(root, "web", "dist");

/** Paths that belong to the server, never to the single-page app. */
const SERVER_PATHS = /^\/(api|webhook|health|dashboard)(\/|$)/;

export function webApp(): Router {
  const router = express.Router();

  router.use("/assets", express.static(path.join(webDist, "assets"), {
    immutable: true, maxAge: "365d", index: false, fallthrough: false,
  }));
  router.use(express.static(webDist, { index: false, maxAge: "1h" }));

  router.get(/.*/, (req: Request, res: Response, next: NextFunction) => {
    if (SERVER_PATHS.test(req.path)) return next();
    const index = path.join(webDist, "index.html");
    if (!fs.existsSync(index)) {
      res.status(503).type("text/plain").send(
        "The dashboard has not been built yet. Run `npm run build:web`, then reload.",
      );
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(index);
  });

  return router;
}
