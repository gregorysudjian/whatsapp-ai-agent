/**
 * Usage per client per calendar month - the numbers the platform owner
 * bills from. A client's month is its own: "September" for a business in
 * Beirut starts at midnight in Beirut.
 */

import { db, type BusinessId } from "./db.ts";
import { listBusinesses } from "./businesses.ts";
import { startOfDay } from "./overview.ts";
import { estimateCostUsd } from "./queries.ts";

export interface UsageRow {
  businessId: BusinessId;
  name: string;
  status: "active" | "inactive";
  inbound: number;
  aiReplies: number;
  humanReplies: number;
  /** Reminders and other templates: Meta bills these per conversation. */
  templateSends: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Indicative model cost; Meta's own charges are not included. */
  estimatedCostUsd: number;
}

const usageStmt = db.prepare(`
  SELECT
    SUM(direction = 'in') AS inbound,
    SUM(direction = 'out' AND COALESCE(sender, 'ai') = 'ai' AND type != 'template') AS ai,
    SUM(direction = 'out' AND sender = 'human') AS human,
    SUM(direction = 'out' AND type = 'template') AS templates,
    COALESCE(SUM(input_tokens), 0) AS input,
    COALESCE(SUM(output_tokens), 0) AS output,
    COALESCE(SUM(cache_read_tokens), 0) AS cached
  FROM messages WHERE business_id = ? AND ts >= ? AND ts < ?
`);

/** The first day of the month after `month` ("2030-12" -> "2031-01-01"). */
function nextMonthStart(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function usageForMonth(month: string, businessIds?: BusinessId[]): UsageRow[] {
  const wanted = businessIds ? new Set(businessIds) : null;
  return listBusinesses()
    .filter((b) => !wanted || wanted.has(b.id))
    .map((b) => {
      const from = startOfDay(`${month}-01`, b.timezone);
      const to = startOfDay(nextMonthStart(month), b.timezone);
      const r = usageStmt.get(b.id, from, to) as Record<string, number | bigint | null>;
      const n = (k: string) => Number(r[k] ?? 0);
      return {
        businessId: b.id, name: b.name, status: b.status,
        inbound: n("inbound"), aiReplies: n("ai"), humanReplies: n("human"), templateSends: n("templates"),
        inputTokens: n("input"), outputTokens: n("output"), cachedTokens: n("cached"),
        estimatedCostUsd: estimateCostUsd(n("input"), n("output"), n("cached")),
      };
    });
}
