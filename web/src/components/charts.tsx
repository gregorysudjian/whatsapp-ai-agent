/**
 * Two small SVG charts for the Overview, built to one spec (see the dataviz
 * notes in plan.md): thin marks, a 2px surface gap between stacked
 * segments, 4px rounded data-ends square at the baseline, hairline solid
 * gridlines, one y-axis, text in text colours (never the series colour), a
 * hover/focus tooltip that lists every series at that day, and arrow keys to
 * walk the days. Every value is also in the page's table view.
 *
 * Colours come from CSS custom properties (--series-1, --series-2, ...) set
 * in styles.css for light and dark, validated with the palette checker.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "./ui.tsx";

export interface Series {
  key: string;
  label: string;
  /** A CSS colour, normally var(--series-N). */
  color: string;
}

const PLOT_H = 180;
const AXIS_H = 26;
const RIGHT = 12;
const TOP = 8;

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Round-number ticks from zero: 0, 5, 10, 15 - never 0, 3.7, 7.4. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/** Which day labels to print: at most ~8, always the first and last. */
function labelEvery(n: number, width: number): number {
  const fit = Math.max(2, Math.floor(width / 64));
  return Math.max(1, Math.ceil(n / Math.min(fit, 8)));
}

interface Frame {
  width: number;
  /** The y-axis label gutter, sized to the widest tick label. */
  left: number;
  plotW: number;
  band: number;
  x: (i: number) => number;
  y: (v: number) => number;
  ticks: number[];
}

function frame(width: number, n: number, max: number, formatTick: (v: number) => string): Frame {
  const ticks = niceTicks(max);
  const left = Math.min(96, Math.max(28, Math.ceil(Math.max(...ticks.map((v) => formatTick(v).length)) * 6.6) + 12));
  const plotW = Math.max(10, width - left - RIGHT);
  const band = plotW / Math.max(1, n);
  const top = ticks[ticks.length - 1]!;
  return {
    width, left, plotW, band, ticks,
    x: (i) => left + band * i + band / 2,
    y: (v) => TOP + PLOT_H - (v / top) * PLOT_H,
  };
}

function Axes({ f, labels, formatTick }: { f: Frame; labels: string[]; formatTick: (v: number) => string }) {
  const every = labelEvery(labels.length, f.width);
  return (
    <g>
      {f.ticks.map((v) => (
        <g key={v}>
          <line x1={f.left} x2={f.width - RIGHT} y1={f.y(v)} y2={f.y(v)} stroke={v === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
          <text x={f.left - 8} y={f.y(v)} dy="0.32em" textAnchor="end" className="fill-[var(--chart-muted)] text-[11px] tabular-nums">{formatTick(v)}</text>
        </g>
      ))}
      {labels.map((l, i) => (i % every === 0 || i === labels.length - 1) && (i === labels.length - 1 || labels.length - 1 - i >= every / 2) ? (
        // The last label ends at the plot's edge instead of spilling past it.
        <text key={i} x={i === labels.length - 1 ? f.width - 2 : f.x(i)} y={TOP + PLOT_H + 18} textAnchor={i === labels.length - 1 ? "end" : "middle"}
          className="fill-[var(--chart-muted)] text-[11px]">{l}</text>
      ) : null)}
    </g>
  );
}

/** The readout: every series at the active day. Values lead, labels follow; line keys, not boxes. */
function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { label: string; value: string; color: string }[] }) {
  const w = 176;
  const left = Math.min(Math.max(0, x - w / 2), Math.max(0, width - w));
  return (
    <div className="pointer-events-none absolute top-0 z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
      style={{ left, width: w }}>
      <p className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2">
          <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{r.value}</span>
          <span className="truncate text-zinc-500 dark:text-zinc-400">{r.label}</span>
        </p>
      ))}
    </div>
  );
}

/** Shared pointer + keyboard handling: the active index, snapped to the nearest day. */
function useActive(n: number, f: Frame | null) {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => { setActive(null); }, [n]);
  const fromPointer = (clientX: number, svg: SVGSVGElement) => {
    if (!f) return;
    const rect = svg.getBoundingClientRect();
    const i = Math.floor((clientX - rect.left - f.left) / f.band);
    setActive(i >= 0 && i < n ? i : null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setActive((a) => {
        const cur = a ?? (e.key === "ArrowRight" ? -1 : n);
        return Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") setActive(null);
  };
  return { active, setActive, fromPointer, onKey };
}

export function Legend({ series, extra }: { series: Series[]; extra?: (s: Series) => ReactNode }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
          {s.label}{extra && <span className="font-semibold text-zinc-900 dark:text-zinc-50">{extra(s)}</span>}
        </li>
      ))}
    </ul>
  );
}

// --- stacked columns ----------------------------------------------------------------

export function ColumnChart({ labels, titles, series, values, formatValue, ariaLabel }: {
  labels: string[];
  /** Long form of each day, for the tooltip. */
  titles: string[];
  series: Series[];
  /** values[day][series] */
  values: number[][];
  formatValue: (v: number) => string;
  ariaLabel: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const max = Math.max(0, ...values.map((d) => d.reduce((a, b) => a + b, 0)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const f = useMemo(() => (width ? frame(width, labels.length, max, formatValue) : null), [width, labels.length, max]);
  const { active, setActive, fromPointer, onKey } = useActive(labels.length, f);
  const svgRef = useRef<SVGSVGElement>(null);
  const descId = useId();

  return (
    <div ref={box} className="relative">
      {f && (
        <svg ref={svgRef} width={f.width} height={TOP + PLOT_H + AXIS_H} role="img" aria-label={ariaLabel} aria-describedby={descId}
          tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}
          onPointerMove={(e) => fromPointer(e.clientX, e.currentTarget)} onPointerLeave={() => setActive(null)}
          className="block touch-pan-y rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/50">
          <Axes f={f} labels={labels} formatTick={(v) => formatValue(v)} />
          {values.map((day, i) => {
            const colW = Math.max(2, Math.min(24, f.band * 0.62));
            const x0 = f.x(i) - colW / 2;
            let acc = 0;
            const segs = day.map((v, s) => ({ v, s })).filter((d) => d.v > 0);
            return (
              <g key={i} opacity={active === null || active === i ? 1 : 0.55}>
                {segs.map(({ v, s }, k) => {
                  const yTop = f.y(acc + v);
                  const yBottom = f.y(acc);
                  acc += v;
                  const isTop = k === segs.length - 1;
                  // The 2px surface gap sits on top of every segment but the last.
                  const h = Math.max(0, yBottom - yTop - (isTop ? 0 : 2));
                  const r = isTop ? Math.min(4, colW / 2, h) : 0;
                  const top = yBottom - h;
                  const d = `M${x0},${yBottom} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + colW - r} Q${x0 + colW},${top} ${x0 + colW},${top + r} V${yBottom} Z`;
                  return <path key={s} d={d} fill={series[s]!.color} />;
                })}
              </g>
            );
          })}
          {active !== null && (
            <rect x={f.left + f.band * active} y={TOP} width={f.band} height={PLOT_H} fill="var(--chart-hover)" className="pointer-events-none" />
          )}
        </svg>
      )}
      <p id={descId} className="sr-only">{ariaLabel}</p>
      {f && active !== null && (
        <Tooltip x={f.x(active)} width={f.width} title={titles[active] ?? ""}
          rows={series.map((s, k) => ({ label: s.label, value: formatValue(values[active]?.[k] ?? 0), color: s.color }))} />
      )}
    </div>
  );
}

// --- a single line ----------------------------------------------------------------------

export function LineChart({ labels, titles, values, color, label, formatValue, ariaLabel }: {
  labels: string[]; titles: string[];
  /** One value per day; null where there is nothing to plot (the line breaks). */
  values: (number | null)[];
  color: string; label: string;
  formatValue: (v: number) => string;
  ariaLabel: string;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const f = useMemo(() => (width ? frame(width, labels.length, max, formatValue) : null), [width, labels.length, max]);
  const { active, setActive, fromPointer, onKey } = useActive(labels.length, f);

  const path = useMemo(() => {
    if (!f) return "";
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${f.x(i)},${f.y(v)} `;
      pen = true;
    });
    return d;
  }, [f, values]);

  const lastIdx = values.map((v, i) => (v === null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
  // Lone points (a value with empty days either side) would vanish as a line: draw them as dots.
  const lone = values.map((v, i) => v !== null && values[i - 1] == null && values[i + 1] == null ? i : -1).filter((i) => i >= 0);

  return (
    <div ref={box} className="relative">
      {f && (
        <svg width={f.width} height={TOP + PLOT_H + AXIS_H} role="img" aria-label={ariaLabel} tabIndex={0}
          onKeyDown={onKey} onBlur={() => setActive(null)}
          onPointerMove={(e) => fromPointer(e.clientX, e.currentTarget)} onPointerLeave={() => setActive(null)}
          className="block touch-pan-y rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/50">
          <Axes f={f} labels={labels} formatTick={formatValue} />
          {active !== null && (
            <line x1={f.x(active)} x2={f.x(active)} y1={TOP} y2={TOP + PLOT_H} stroke="var(--chart-axis)" strokeWidth={1} className="pointer-events-none" />
          )}
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {[...new Set([...lone, lastIdx, ...(active !== null && values[active] != null ? [active] : [])])].filter((i) => i >= 0).map((i) => (
            <circle key={i} cx={f.x(i)} cy={f.y(values[i]!)} r={4} fill={color} stroke="var(--chart-surface)" strokeWidth={2} />
          ))}
        </svg>
      )}
      {f && active !== null && (
        <Tooltip x={f.x(active)} width={f.width} title={titles[active] ?? ""}
          rows={[{ label, value: values[active] == null ? "—" : formatValue(values[active]!), color }]} />
      )}
    </div>
  );
}

export function ChartCard({ title, subtitle, legend, children, className }: {
  title: string; subtitle?: string; legend?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cx("rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900", className)}>
      <div className="mb-3 space-y-1.5">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
        {subtitle && <p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
        {legend}
      </div>
      {children}
    </section>
  );
}
