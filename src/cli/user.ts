/**
 * Manage dashboard accounts from the terminal.
 *
 *   npm run user -- list
 *   npm run user -- create-admin <email>
 *   npm run user -- create-owner <email> --business <id>
 *   npm run user -- reset-password <email>           (issues a one-time password)
 *   npm run user -- deactivate <email> | activate <email>
 *   npm run user -- bootstrap --admin <email>        (first-run accounts, see below)
 *
 * Passwords are prompted for or generated, never taken as arguments (they
 * would land in shell history). A generated password is shown once, and the
 * account must change it at first login.
 */

import fs from "node:fs";
import path from "node:path";
import { prompter } from "./prompt.ts";
import { config } from "../config.ts";
import { generatePassword } from "../auth/passwords.ts";
import { destroyAllSessions } from "../auth/sessions.ts";
import {
  createUser, getUserByEmail, listUsers, setPassword, setUserActive, type User,
} from "../store/users.ts";
import { DEFAULT_BUSINESS_ID, getBusiness, seedDefaultBusiness, ValidationError } from "../store/businesses.ts";
import { audit } from "../store/audit.ts";

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function need(email: string | undefined): User {
  const user = email ? getUserByEmail(email) : undefined;
  if (!user) {
    console.error(`No account for ${email ?? "(missing email)"}. Run: npm run user -- list`);
    process.exit(1);
  }
  return user;
}

async function askNewPassword(): Promise<string> {
  const p = prompter();
  const first = await p.ask("New password (10+ characters; leave empty to generate one): ");
  if (first === "") {
    p.close();
    return "";
  }
  const again = await p.ask("Repeat it: ");
  p.close();
  if (first !== again) throw new ValidationError("The two passwords differ.");
  return first;
}

async function main(): Promise<void> {
  seedDefaultBusiness();

  switch (command) {
    case "list": {
      console.table(listUsers().map((u) => ({
        id: u.id, email: u.email, role: u.role,
        business: u.businessId == null ? "(all)" : `${u.businessId} ${getBusiness(u.businessId)?.name ?? "?"}`,
        active: u.active ? "yes" : "no",
        mustChangePassword: u.mustChangePassword ? "yes" : "no",
        lastLogin: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never",
      })));
      return;
    }

    case "create-admin":
    case "create-owner": {
      const email = rest[0];
      const role = command === "create-admin" ? "super_admin" : "owner";
      const businessId = role === "owner" ? Number(flag("business")) : null;
      if (role === "owner" && (!businessId || !getBusiness(businessId))) {
        throw new ValidationError("An owner needs --business <id> of an existing business.");
      }
      const typed = await askNewPassword();
      const password = typed || generatePassword();
      const user = await createUser({
        email: email ?? "", password, role, businessId, mustChangePassword: typed === "",
      });
      audit({ userId: null, businessId: user.businessId, action: "user_created", target: user.email, detail: { role, via: "cli" } });
      console.log(`Created ${role} ${user.email}${user.businessId ? ` for ${getBusiness(user.businessId)!.name}` : ""}.`);
      if (!typed) console.log(`One-time password (shown once, must be changed at first login): ${password}`);
      return;
    }

    case "reset-password": {
      const user = need(rest[0]);
      const password = generatePassword();
      await setPassword(user.id, password, true);
      destroyAllSessions(user.id);
      audit({ userId: null, businessId: user.businessId, action: "password_reset", target: user.email, detail: { via: "cli" } });
      console.log(`${user.email}: one-time password (shown once, must be changed at login): ${password}`);
      return;
    }

    case "deactivate":
    case "activate": {
      const user = need(rest[0]);
      setUserActive(user.id, command === "activate");
      if (command === "deactivate") destroyAllSessions(user.id);
      audit({ userId: null, businessId: user.businessId, action: `user_${command}d`, target: user.email, detail: { via: "cli" } });
      console.log(`${user.email} is now ${command === "activate" ? "active" : "deactivated (and logged out everywhere)"}.`);
      return;
    }

    /**
     * First-run accounts: the platform owner, plus a demo owner for the
     * default business so the owner-side view can be tried immediately.
     * Generated passwords go to a file under data/ (gitignored, never
     * printed or logged) and must be changed at first login.
     */
    case "bootstrap": {
      const adminEmail = flag("admin");
      if (!adminEmail) throw new ValidationError("Usage: npm run user -- bootstrap --admin <email>");
      const ownerEmail = flag("owner") ?? "owner@ninjaco.test";
      const lines: string[] = [];

      for (const spec of [
        { email: adminEmail, role: "super_admin" as const, businessId: null },
        { email: ownerEmail, role: "owner" as const, businessId: DEFAULT_BUSINESS_ID },
      ]) {
        if (getUserByEmail(spec.email)) {
          console.log(`${spec.email} already exists - left unchanged.`);
          continue;
        }
        const password = generatePassword();
        const user = await createUser({ ...spec, password, mustChangePassword: true });
        audit({ userId: null, businessId: user.businessId, action: "user_created", target: user.email, detail: { role: user.role, via: "bootstrap" } });
        const scope = user.businessId ? `owner of ${getBusiness(user.businessId)!.name}` : "super admin (all businesses)";
        lines.push(`${scope}\n  email:    ${user.email}\n  password: ${password}\n`);
        console.log(`Created ${user.email} (${scope}).`);
      }

      if (lines.length) {
        const file = path.join(path.dirname(config.dbPath), "initial-credentials.txt");
        fs.writeFileSync(file, [
          "First-login passwords. Each must be changed at first login.",
          "Delete this file once you have logged in and changed them.",
          "",
          ...lines,
        ].join("\n"), { encoding: "utf8", mode: 0o600 });
        console.log(`Passwords written to ${file} (not printed here).`);
      }
      return;
    }

    default:
      console.log("Usage: npm run user -- list | create-admin <email> | create-owner <email> --business <id> | reset-password <email> | activate <email> | deactivate <email> | bootstrap --admin <email>");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ValidationError ? `Invalid: ${err.message}` : err);
  process.exit(1);
});
