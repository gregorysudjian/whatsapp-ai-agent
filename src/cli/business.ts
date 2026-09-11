/**
 * Manage clients from the terminal until the admin panel exists (step 12).
 *
 *   npm run business -- list
 *   npm run business -- add "Clinic Alpha" [--timezone America/Toronto] [--language fr]
 *   npm run business -- connect <id>          (prompts for the WhatsApp credentials)
 *   npm run business -- show <id>
 *   npm run business -- messages <id>     (that client's conversations)
 *   npm run business -- deactivate <id> | activate <id>
 *
 * Secrets are prompted for, never taken as arguments: an argument lands in
 * your shell history in plain text, which defeats encrypting it at rest.
 */

import { prompter } from "./prompt.ts";
import {
  createBusiness, credentialSummary, getBusiness, getSchedule, listBusinesses,
  seedDefaultBusiness, setBusinessStatus, setWhatsappCredentials, ValidationError,
} from "../store/businesses.ts";
import { config } from "../config.ts";
import { listConversations, listMessages } from "../store/queries.ts";
import { getSettings } from "../store/settings.ts";
import { listServices } from "../store/services.ts";

const [command, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function idArg(): number {
  const id = Number(rest[0]);
  if (!Number.isInteger(id) || !getBusiness(id)) {
    console.error(`No business with id ${rest[0] ?? "(missing)"}. Run: npm run business -- list`);
    process.exit(1);
  }
  return id;
}

const webhookUrl = (publicId: string) =>
  `https://<your-public-host>/webhook/b/${publicId}   (local: http://localhost:${config.port}/webhook/b/${publicId})`;

async function main(): Promise<void> {
  seedDefaultBusiness();

  switch (command) {
    case "list": {
      const rows = listBusinesses().map((b) => ({
        id: b.id, name: b.name, status: b.status, timezone: b.timezone,
        language: b.defaultLanguage, connected: b.hasCredentials ? "yes" : "no",
        webhook: `/webhook/b/${b.publicId}`,
      }));
      console.table(rows);
      return;
    }

    case "add": {
      const name = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--")).join(" ");
      const business = createBusiness({
        name,
        ...(flag("timezone") ? { timezone: flag("timezone")! } : {}),
        ...(flag("language") ? { defaultLanguage: flag("language") as "en" | "fr" } : {}),
      });
      console.log(`Created business ${business.id}: ${business.name} (${business.timezone}, ${business.defaultLanguage})`);
      console.log(`Next: npm run business -- connect ${business.id}`);
      return;
    }

    case "connect": {
      const id = idArg();
      const p = prompter();
      console.log(`Connecting WhatsApp for "${getBusiness(id)!.name}". Values come from Meta > WhatsApp > API Setup.`);
      const phoneNumberId = await p.ask("Phone number ID: ");
      const businessAccountId = await p.ask("WhatsApp Business Account ID (optional): ");
      const accessToken = await p.ask("Access token: ");
      const appSecret = await p.ask("App secret: ");
      const verifyToken = await p.ask("Verify token (any string you choose; paste the same into Meta): ");
      p.close();

      setWhatsappCredentials(id, {
        phoneNumberId, businessAccountId: businessAccountId || undefined,
        accessToken, appSecret, verifyToken,
      });
      const b = getBusiness(id)!;
      console.log("\nSaved, encrypted. In this client's Meta app, set:");
      console.log(`  Callback URL: ${webhookUrl(b.publicId)}`);
      console.log("  Verify token: the one you just entered");
      console.log("  Webhook field: messages");
      return;
    }

    case "show": {
      const id = idArg();
      const b = getBusiness(id)!;
      console.log(JSON.stringify({
        ...b,
        webhook: webhookUrl(b.publicId),
        credentials: credentialSummary(id) ?? "not connected",
        settings: getSettings(id),
        schedule: getSchedule(id),
        services: listServices(id, true),
      }, null, 2));
      return;
    }

    case "messages": {
      // Reads through the same business-scoped queries the dashboard uses, so
      // what this prints is exactly what that client's own view will show.
      const id = idArg();
      const rows = listConversations(id).flatMap((c) =>
        listMessages(id, c.waId).map((m) => ({
          contact: c.name ? `${c.name} (${c.waId})` : c.waId,
          direction: m.direction === "in" ? "customer ->" : "<- agent",
          text: m.text.length > 60 ? m.text.slice(0, 57) + "..." : m.text,
          time: new Date(m.ts).toLocaleString(),
        })),
      );
      console.log(`Messages for ${getBusiness(id)!.name}:`);
      if (rows.length) console.table(rows);
      else console.log("  (none yet)");
      return;
    }

    case "deactivate":
    case "activate": {
      const id = idArg();
      setBusinessStatus(id, command === "activate" ? "active" : "inactive");
      console.log(`${getBusiness(id)!.name} is now ${command === "activate" ? "active" : "inactive"}.`);
      return;
    }

    default:
      console.log("Usage: npm run business -- list | add <name> [--timezone TZ] [--language en|fr] | connect <id> | show <id> | messages <id> | activate <id> | deactivate <id>");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof ValidationError ? `Invalid: ${err.message}` : err);
  process.exit(1);
});
