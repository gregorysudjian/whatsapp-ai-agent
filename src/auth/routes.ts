/**
 * /api/auth - log in, log out, who am I, change my password.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { decoyHash, verifyPassword } from "./passwords.ts";
import { createSession, destroyOtherSessions, destroySession } from "./sessions.ts";
import {
  SESSION_COOKIE, clearLoginFailures, clientIp, cookieOptions, getAuth, loginLocked,
  readCookie, recordLoginFailure, requireAuth,
} from "./middleware.ts";
import {
  accessibleBusinesses, getCredentialsForLogin, getUser, recordLogin, setPassword,
  setUserLocale, type User,
} from "../store/users.ts";
import { audit } from "../store/audit.ts";
import { body, handleError } from "../api/validate.ts";
import { log } from "../logger.ts";

export const authRouter: Router = Router();

/** What the browser learns about the person logged in. No hash, no token. */
function me(user: User) {
  return {
    user: {
      id: user.id, email: user.email, name: user.name, role: user.role,
      businessId: user.businessId, locale: user.locale,
      mustChangePassword: user.mustChangePassword,
    },
    businesses: accessibleBusinesses(user).map((b) => ({
      id: b.id, name: b.name, status: b.status, timezone: b.timezone,
      defaultLanguage: b.defaultLanguage, connected: b.hasCredentials,
    })),
  };
}

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(200),
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const input = body(LoginBody, req, res);
  if (!input) return;
  const ip = clientIp(req);

  // One message for every failure - unknown email, wrong password, locked,
  // disabled - so the form cannot be used to discover which accounts exist.
  const refuse = () => res.status(401).json({ error: "invalid_credentials" });

  if (loginLocked(input.email, ip)) {
    audit({ userId: null, businessId: null, action: "login_throttled", target: input.email, ip });
    refuse();
    return;
  }

  const found = getCredentialsForLogin(input.email);
  // Verify against a decoy when the account is missing, so an unknown email
  // costs the same time as a wrong password.
  const ok = await verifyPassword(input.password, found?.passwordHash ?? (await decoyHash()));

  if (!found || !ok || !found.user.active) {
    recordLoginFailure(input.email, ip);
    audit({ userId: found?.user.id ?? null, businessId: found?.user.businessId ?? null, action: "login_failed", target: input.email, ip });
    log.warn("login_failed", { email: input.email, ip });
    refuse();
    return;
  }

  clearLoginFailures(input.email);
  recordLogin(found.user.id);
  const token = createSession(found.user.id, ip, req.get("user-agent"));
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  audit({ userId: found.user.id, businessId: found.user.businessId, action: "login", ip });
  res.json(me(getUser(found.user.id)!));
});

authRouter.post("/logout", (req: Request, res: Response) => {
  const token = readCookie(req, SESSION_COOKIE);
  const user = token ? getUserFromRequest(req) : undefined;
  destroySession(token);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  if (user) audit({ userId: user.id, businessId: user.businessId, action: "logout", ip: clientIp(req) });
  res.json({ ok: true });
});

function getUserFromRequest(req: Request): User | undefined {
  try {
    return getAuth(req).user;
  } catch {
    return undefined;
  }
}

authRouter.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json(me(getAuth(req).user));
});

const PatchMe = z.object({ locale: z.enum(["en", "fr"]) }).strict();

authRouter.patch("/me", requireAuth, (req: Request, res: Response) => {
  const input = body(PatchMe, req, res);
  if (!input) return;
  const { user } = getAuth(req);
  setUserLocale(user.id, input.locale);
  res.json(me(getUser(user.id)!));
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
}).strict();

authRouter.post("/password", requireAuth, async (req: Request, res: Response) => {
  const input = body(PasswordBody, req, res);
  if (!input) return;
  const { user, token } = getAuth(req);

  const creds = getCredentialsForLogin(user.email);
  if (!creds || !(await verifyPassword(input.currentPassword, creds.passwordHash))) {
    res.status(400).json({ error: "wrong_current_password" });
    return;
  }
  if (input.newPassword === input.currentPassword) {
    res.status(400).json({ error: "invalid_input", message: "Password rejected: same_as_current." });
    return;
  }

  try {
    await setPassword(user.id, input.newPassword, false);
  } catch (err) {
    handleError(err, res);
    return;
  }
  // A changed password must end every other session - that is usually why
  // someone changes it.
  destroyOtherSessions(user.id, token);
  audit({ userId: user.id, businessId: user.businessId, action: "password_changed", ip: clientIp(req) });
  res.json(me(getUser(user.id)!));
});
