/**
 * The retention clean-up, run twice a day: each business's conversations
 * past its retention period, expired sessions and OAuth states, old audit
 * rows. Idempotent, so running it more often than needed costs nothing.
 */

import { log } from "../logger.ts";
import { purgeAll } from "../store/privacy.ts";
import { purgeExpiredSessions } from "../auth/sessions.ts";

const EVERY_MS = 12 * 3_600_000;

export function runPrivacyJobs(now: number = Date.now()): void {
  try {
    purgeAll(now);
    purgeExpiredSessions(now);
    log.info("privacy_jobs_ran");
  } catch (err) {
    log.error("privacy_jobs_failed", { err: String(err) });
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Started by index.ts: a first pass shortly after boot, then every 12 hours. */
export function startPrivacyJobs(): void {
  if (timer) return;
  setTimeout(() => runPrivacyJobs(), 2 * 60_000).unref();
  timer = setInterval(() => runPrivacyJobs(), EVERY_MS);
  timer.unref();
}
