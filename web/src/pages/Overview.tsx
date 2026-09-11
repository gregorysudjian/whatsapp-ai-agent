import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, cx, PageHeader, Spinner } from "../components/ui.tsx";
import { ChartCard, ColumnChart, Legend, LineChart, type Series } from "../components/charts.tsx";
import { addDays, fmtWall } from "../lib/wallclock.ts";

// --- shapes (mirror src/store/overview.ts) ---------------------------------------

interface Totals {
  conversationsStarted: number; inbound: number; aiReplies: number; humanReplies: number; systemMessages: number;
  aiShare: number | null; bookingsMade: number; bookingsByAgent: number; handoffs: number; takeovers: number;
  responseMedianMs: number | null; responseP90Ms: number | null; unanswered: number;
}
interface Day { date: string; conversations: number; inbound: number; ai: number; human: number; bookings: number; responseMedianMs: number | null }
interface OverviewData {
  range: { from: string; to: string; timezone: string; days: number };
  totals: Totals; previous: Totals;
  bookingsByStatus: Record<"booked" | "confirmed" | "completed" | "no_show" | "cancelled", number>;
  daily: Day[];
  today: string;
  agentEnabled: boolean;
  business: { id: number; name: string; connected: boolean };
}

type Preset = 7 | 30 | 90;

function useTag() {
  const { locale } = useI18n();
  return locale === "fr" ? "fr-CA" : "en-CA";
}

/** 45 s, 3 min, 1 h 20 min - in the reader's language. */
function useDuration() {
  const tag = useTag();
  return (ms: number | null): string => {
    if (ms === null) return "—";
    const unit = (n: number, u: "second" | "minute" | "hour") =>
      new Intl.NumberFormat(tag, { style: "unit", unit: u, unitDisplay: "short", maximumFractionDigits: 0 }).format(n);
    if (ms < 60_000) return unit(Math.round(ms / 1000), "second");
    if (ms < 3_600_000) return unit(Math.round(ms / 60_000), "minute");
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m ? `${unit(h, "hour")} ${unit(m, "minute")}` : unit(h, "hour");
  };
}

export function Overview() {
  const { bid } = useParams();
  const { t, fmtNumber } = useI18n();
  const tag = useTag();
  const duration = useDuration();

  const [preset, setPreset] = useState<Preset | "custom">(30);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [toggling, setToggling] = useState(false);

  // The range is asked of the server in the business's days; "today" comes back with the data.
  const query = preset === "custom" && custom ? `from=${custom.from}&to=${custom.to}`
    : data ? `from=${addDays(data.today, -((preset === "custom" ? 30 : preset) - 1))}&to=${data.today}`
    : "";

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    api<OverviewData>(`/api/b/${bid}/overview${query ? `?${query}` : ""}`, { signal: ctrl.signal })
      .then((r) => { setData(r); setError(null); })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof ApiError && err.status === 0 ? t("common.offline")
          : err instanceof ApiError && err.code === "invalid_range" ? t("overview.badRange") : t("common.error"));
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, query, tick]);

  const setAgent = async (enabled: boolean) => {
    if (!enabled && !window.confirm(t("overview.pauseConfirm"))) return;
    setToggling(true);
    try {
      const r = await api<{ agentEnabled: boolean }>(`/api/b/${bid}/agent`, { method: "PUT", body: { enabled } });
      setData((d) => d && { ...d, agentEnabled: r.agentEnabled });
    } catch {
      setError(t("common.error"));
    } finally {
      setToggling(false);
    }
  };

  if (!data) {
    return error
      ? <div className="space-y-3"><Alert>{error}</Alert><Button variant="secondary" onClick={() => setTick((n) => n + 1)}>{t("common.retry")}</Button></div>
      : <Spinner label={t("common.loading")} />;
  }

  const { totals: c, previous: p, daily } = data;
  const short = daily.map((d) => fmtWall(tag, d.date, { day: "numeric", month: "short" }));
  const long = daily.map((d) => fmtWall(tag, d.date, { weekday: "long", day: "numeric", month: "long" }));
  const replies: Series[] = [
    { key: "ai", label: t("overview.series.ai"), color: "var(--series-1)" },
    { key: "human", label: t("overview.series.human"), color: "var(--series-2)" },
  ];
  const percent = (v: number | null) => (v === null ? "—" : fmtNumber(v, { style: "percent", maximumFractionDigits: 0 }));
  const count = (v: number) => fmtNumber(v, { notation: v >= 10_000 ? "compact" : "standard" });
  const s = data.bookingsByStatus;
  const appointments = s.booked + s.confirmed + s.completed + s.no_show + s.cancelled;

  return (
    <div>
      <PageHeader
        title={t("overview.title")}
        subtitle={t("overview.rangeSubtitle", {
          from: fmtWall(tag, data.range.from, { day: "numeric", month: "long" }),
          to: fmtWall(tag, data.range.to, { day: "numeric", month: "long", year: "numeric" }),
          tz: data.range.timezone,
        })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data.agentEnabled
              ? <Badge tone="green">● {t("overview.agentOn")}</Badge>
              : <Badge tone="amber">● {t("overview.agentOff")}</Badge>}
            <Button size="sm" variant={data.agentEnabled ? "secondary" : "primary"} loading={toggling}
              onClick={() => void setAgent(!data.agentEnabled)}>
              {data.agentEnabled ? t("overview.pauseAgent") : t("overview.resumeAgent")}
            </Button>
          </div>
        }
      />

      {!data.business.connected && (
        <div className="mb-4"><Alert tone="amber"><span className="inline-flex items-center gap-2"><AlertCircle className="size-4" aria-hidden />{t("shell.notConnected")}</span></Alert></div>
      )}

      {/* One filter row, above everything it scopes */}
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800" role="group" aria-label={t("overview.rangeLabel")}>
          {([7, 30, 90] as const).map((n) => (
            <button key={n} type="button" aria-pressed={preset === n} onClick={() => { setPreset(n); setCustom(null); }}
              className={cx("min-h-8 rounded-md px-3 text-sm font-medium",
                preset === n ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-50" : "text-zinc-600 dark:text-zinc-400")}>
              {t("overview.lastDays", { n })}
            </button>
          ))}
          <button type="button" aria-pressed={preset === "custom"}
            onClick={() => { setPreset("custom"); setCustom(custom ?? { from: data.range.from, to: data.range.to }); }}
            className={cx("min-h-8 rounded-md px-3 text-sm font-medium",
              preset === "custom" ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-50" : "text-zinc-600 dark:text-zinc-400")}>
            {t("overview.custom")}
          </button>
        </div>
        {preset === "custom" && custom && <CustomRange value={custom} max={data.today} onApply={setCustom} />}
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>

      {/* Refetching keeps the frame: the last numbers dim, nothing jumps. */}
      <div className={cx("space-y-5 transition-opacity", loading && "opacity-60")} aria-busy={loading}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Tile label={t("overview.tile.conversations")} value={count(c.conversationsStarted)} delta={delta(c.conversationsStarted, p.conversationsStarted)} goodWhenUp />
          <Tile label={t("overview.tile.inbound")} value={count(c.inbound)} delta={delta(c.inbound, p.inbound)} goodWhenUp />
          <Tile label={t("overview.tile.aiShare")} value={percent(c.aiShare)}
            note={c.aiReplies + c.humanReplies > 0 ? t("overview.tile.aiShareNote", { ai: fmtNumber(c.aiReplies), all: fmtNumber(c.aiReplies + c.humanReplies) }) : t("overview.noReplies")} />
          <Tile label={t("overview.tile.bookings")} value={count(c.bookingsMade)} delta={delta(c.bookingsMade, p.bookingsMade)} goodWhenUp
            note={t("overview.tile.bookingsNote", { n: fmtNumber(c.bookingsByAgent) })} />
          <Tile label={t("overview.tile.handoffs")} value={count(c.handoffs)}
            note={t("overview.tile.handoffsNote", { n: fmtNumber(c.takeovers) })} />
          <Tile label={t("overview.tile.response")} value={duration(c.responseMedianMs)} delta={delta(c.responseMedianMs, p.responseMedianMs)}
            note={c.responseP90Ms !== null ? t("overview.tile.responseNote", { p90: duration(c.responseP90Ms) }) : undefined} />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <ChartCard title={t("overview.chart.replies")} subtitle={t("overview.chart.repliesSub")}
            legend={<Legend series={replies} extra={(sr) => ` ${fmtNumber(sr.key === "ai" ? c.aiReplies : c.humanReplies)}`} />}>
            <ColumnChart labels={short} titles={long} series={replies} values={daily.map((d) => [d.ai, d.human])}
              formatValue={(v) => fmtNumber(v)} ariaLabel={t("overview.chart.repliesAria", { ai: c.aiReplies, human: c.humanReplies })} />
          </ChartCard>
          <ChartCard title={t("overview.chart.bookings")} subtitle={t("overview.chart.bookingsSub")}>
            <ColumnChart labels={short} titles={long} series={[{ key: "b", label: t("overview.chart.bookings"), color: "var(--series-1)" }]}
              values={daily.map((d) => [d.bookings])} formatValue={(v) => fmtNumber(v)}
              ariaLabel={t("overview.chart.bookingsAria", { n: c.bookingsMade })} />
          </ChartCard>
          <ChartCard title={t("overview.chart.response")} subtitle={t("overview.chart.responseSub")}>
            {/* Charted in minutes, so the axis gets round minute ticks rather than round milliseconds. */}
            <LineChart labels={short} titles={long} values={daily.map((d) => (d.responseMedianMs === null ? null : d.responseMedianMs / 60_000))} color="var(--series-1)"
              label={t("overview.chart.responseSeries")} formatValue={(v) => duration(v * 60_000)}
              ariaLabel={t("overview.chart.responseAria", { median: duration(c.responseMedianMs) })} />
          </ChartCard>
          <ChartCard title={t("overview.appointments")} subtitle={t("overview.appointmentsSub", { n: appointments })}>
            {/* Five counts are read as numbers, not compared as shapes: no chart. */}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {(["booked", "confirmed", "completed", "no_show", "cancelled"] as const).map((k) => (
                <div key={k} className="rounded-lg bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800/60">
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">{t(`bookings.status.${k}` as Key)}</dt>
                  <dd className="mt-0.5 text-xl font-semibold text-zinc-900 dark:text-zinc-50">{fmtNumber(s[k])}</dd>
                </div>
              ))}
              <div className="flex items-end px-1 pb-1">
                <Link to={`/b/${bid}/bookings`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">{t("overview.seeBookings")}</Link>
              </div>
            </dl>
            {c.unanswered > 0 && (
              <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">
                {t("overview.unanswered", { n: c.unanswered })}{" "}
                <Link to={`/b/${bid}/inbox`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">{t("overview.openInbox")}</Link>
              </p>
            )}
          </ChartCard>
        </div>

        <DailyTable daily={daily} labels={long} duration={duration} />
      </div>
    </div>
  );
}

/** Signed change vs the previous period; null when there is nothing to compare. */
function delta(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return (now - before) / before;
}

function Tile({ label, value, delta: d, goodWhenUp, note }: {
  label: string; value: string; delta?: number | null; goodWhenUp?: boolean; note?: string | undefined;
}) {
  const { t, fmtNumber } = useI18n();
  const flat = d == null || Math.abs(d) < 0.005;
  // Up is good for counts; for the reply time, down is good.
  const good = flat ? null : (d! > 0) === Boolean(goodWhenUp);
  const Icon = flat ? Minus : d! > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
      {d != null && (
        <p className={cx("mt-1 inline-flex items-center gap-0.5 text-xs font-medium",
          good === null ? "text-zinc-500" : good ? "text-[#006300] dark:text-[#0ca30c]" : "text-[#d03b3b] dark:text-[#e66767]")}>
          <Icon className="size-3.5" aria-hidden />
          {fmtNumber(Math.abs(d), { style: "percent", maximumFractionDigits: 0 })}
          <span className="font-normal text-zinc-500 dark:text-zinc-400">&nbsp;{t("overview.vsPrevious")}</span>
        </p>
      )}
      {note && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{note}</p>}
    </div>
  );
}

function CustomRange({ value, max, onApply }: { value: { from: string; to: string }; max: string; onApply: (v: { from: string; to: string }) => void }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const valid = Boolean(from && to && from <= to);
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) onApply({ from, to }); }}>
      <label className="text-xs text-zinc-600 dark:text-zinc-300">
        <span className="mb-1 block">{t("overview.from")}</span>
        <input type="date" value={from} max={to || max} onChange={(e) => setFrom(e.target.value)}
          className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      </label>
      <label className="text-xs text-zinc-600 dark:text-zinc-300">
        <span className="mb-1 block">{t("overview.to")}</span>
        <input type="date" value={to} min={from} max={max} onChange={(e) => setTo(e.target.value)}
          className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      </label>
      <Button type="submit" size="sm" variant="secondary" disabled={!valid}>{t("overview.apply")}</Button>
    </form>
  );
}

/** The table view: every number the charts show, readable without a chart. */
function DailyTable({ daily, labels, duration }: { daily: Day[]; labels: string[]; duration: (ms: number | null) => string }) {
  const { t, fmtNumber } = useI18n();
  const head = (k: Key, right = true): ReactNode => <th scope="col" className={cx("px-3 py-2 font-medium", right && "text-right")}>{t(k)}</th>;
  return (
    <details className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold marker:text-zinc-400">{t("overview.table")}</summary>
      <div className="overflow-x-auto border-t border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
            <tr>
              {head("overview.col.day", false)}{head("overview.col.conversations")}{head("overview.col.inbound")}
              {head("overview.series.ai")}{head("overview.series.human")}{head("overview.chart.bookings")}{head("overview.chart.responseSeries")}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
            {[...daily].reverse().map((d, i) => (
              <tr key={d.date}>
                <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal">{labels[daily.length - 1 - i]}</th>
                <td className="px-3 py-1.5 text-right">{fmtNumber(d.conversations)}</td>
                <td className="px-3 py-1.5 text-right">{fmtNumber(d.inbound)}</td>
                <td className="px-3 py-1.5 text-right">{fmtNumber(d.ai)}</td>
                <td className="px-3 py-1.5 text-right">{fmtNumber(d.human)}</td>
                <td className="px-3 py-1.5 text-right">{fmtNumber(d.bookings)}</td>
                <td className="px-3 py-1.5 text-right">{duration(d.responseMedianMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
