import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, List, MessageSquareText, Plus,
} from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, cx, EmptyState, Field, Modal, PageHeader, Select, Spinner, TextArea } from "../components/ui.tsx";
import { addDays, clockMinutes, dayOf, fmtWall, hhmm, minutesOf, weekdayOf, weekStart, type Day, type Wall } from "../lib/wallclock.ts";

// --- shapes (mirror src/store/bookings.ts) -----------------------------------------

type Status = "booked" | "confirmed" | "cancelled" | "completed" | "no_show";

interface Booking {
  id: number;
  waId: string | null;
  customerName: string | null;
  serviceId: number | null;
  serviceName: string | null;
  start: Wall;
  end: Wall;
  durationMin: number;
  partySize: number;
  status: Status;
  source: "agent" | "owner";
  notes: string;
  createdAt: number;
}

interface Service { id: number; name: string; durationMin: number; active: boolean }
type DayHours = { open: string; close: string };
type Schedule = Partial<Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours>>;

interface BookingsResponse { bookings: Booking[]; now: Wall; timezone: string; schedule: Schedule }

const STATUSES: Status[] = ["booked", "confirmed", "completed", "no_show", "cancelled"];
const STATUS_TONE: Record<Status, "blue" | "green" | "neutral" | "red"> = {
  booked: "blue", confirmed: "green", completed: "neutral", no_show: "red", cancelled: "neutral",
};
const STATUS_BLOCK: Record<Status, string> = {
  booked: "border-sky-500 bg-sky-50 text-sky-950 dark:bg-sky-950/60 dark:text-sky-50",
  confirmed: "border-brand-600 bg-brand-50 text-brand-950 dark:bg-brand-900/50 dark:text-brand-50",
  completed: "border-zinc-400 bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  no_show: "border-red-500 bg-red-50 text-red-900 dark:bg-red-950/50 dark:text-red-100",
  cancelled: "border-zinc-300 bg-zinc-50 text-zinc-500 line-through dark:bg-zinc-900",
};

const statusKey = (s: Status) => `bookings.status.${s}` as Key;
const HOUR_PX = 56;

/** What each refusal from the server means to the person using the page. */
function errorText(t: (k: Key) => string, err: unknown): string {
  const code = err instanceof ApiError ? err.code : "";
  const known: Record<string, Key> = {
    taken: "bookings.err.taken", past: "bookings.err.past", closed: "bookings.err.closed",
    malformed: "bookings.err.malformed", no_service: "bookings.err.noService", not_found: "bookings.err.notFound",
    off_grid: "bookings.err.malformed", invalid_input: "bookings.err.malformed",
  };
  if (err instanceof ApiError && err.status === 0) return t("common.offline");
  return t(known[code] ?? "common.error");
}

function useLocaleTag() {
  const { locale } = useI18n();
  return locale === "fr" ? "fr-CA" : "en-CA";
}

// --- the page ----------------------------------------------------------------------

type View = "week" | "list";
type ListMode = "upcoming" | "past" | "cancelled";

function storedView(): View {
  try { return localStorage.getItem("bookings.view") === "list" ? "list" : "week"; } catch { return "week"; }
}

export function Bookings() {
  const { bid } = useParams();
  const { t } = useI18n();
  const tag = useLocaleTag();

  // ?view=list, ?open=<id> and ?new=1 make any state linkable.
  const [params] = useSearchParams();
  const [view, setViewState] = useState<View>(() => {
    const v = params.get("view");
    return v === "list" || v === "week" ? v : storedView();
  });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem("bookings.view", v); } catch { /* blocked */ } };

  // Until the server says what day it is where the business is, the
  // browser's own date is the best guess; the first response corrects it.
  const browserToday = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const [today, setToday] = useState<Day>(browserToday);
  const [anchor, setAnchor] = useState<Day>(weekStart(browserToday));
  const navigated = useRef(false);
  const [listMode, setListMode] = useState<ListMode>("upcoming");

  const [data, setData] = useState<BookingsResponse | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const [selectedId, setSelectedId] = useState<number | null>(() => Number(params.get("open")) || null);
  const [creating, setCreating] = useState<{ day: Day; time?: string } | null>(() => params.get("new") ? { day: browserToday } : null);

  const range = useMemo(() => {
    if (view === "week") return { from: anchor, to: addDays(anchor, 6) };
    if (listMode === "upcoming") return { from: today, to: addDays(today, 180), status: "active" };
    if (listMode === "past") return { from: addDays(today, -90), to: addDays(today, -1) };
    return { from: addDays(today, -90), to: addDays(today, 180), status: "cancelled" };
  }, [view, anchor, listMode, today]);

  // A string, so a new object with the same values does not refetch.
  const rangeKey = new URLSearchParams(range as Record<string, string>).toString();

  useEffect(() => {
    const ctrl = new AbortController();
    const params = rangeKey;
    api<BookingsResponse>(`/api/b/${bid}/bookings?${params}`, { signal: ctrl.signal })
      .then((r) => {
        setData(r);
        setError(false);
        const bizToday = dayOf(r.now);
        setToday(bizToday);
        if (!navigated.current && weekStart(bizToday) !== anchor) setAnchor(weekStart(bizToday));
      })
      .catch((err: unknown) => { if ((err as Error).name !== "AbortError") setError(true); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, rangeKey, tick]);

  useEffect(() => {
    api<{ services: Service[] }>(`/api/b/${bid}/services`).then((r) => setServices(r.services)).catch(() => setServices([]));
  }, [bid]);

  // Someone may book from WhatsApp while this tab sits open: coming back to it refetches.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const go = (days: number) => { navigated.current = true; setAnchor((a) => addDays(a, days)); };
  const goToday = () => { navigated.current = true; setAnchor(weekStart(today)); };

  const selected = data?.bookings.find((b) => b.id === selectedId) ?? null;
  const activeServices = services.filter((s) => s.active);

  const rangeLabel = `${fmtWall(tag, anchor, { day: "numeric", month: "short" })} – ${fmtWall(tag, addDays(anchor, 6), { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div>
      <PageHeader
        title={t("nav.bookings")}
        subtitle={data ? t("bookings.subtitle", { tz: data.timezone }) : undefined}
        actions={
          <>
            <div className="inline-flex rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800" role="group" aria-label={t("bookings.viewLabel")}>
              {([["week", CalendarDays, "bookings.view.week"], ["list", List, "bookings.view.list"]] as const).map(([v, Icon, label]) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                  className={cx("inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
                    view === v ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-50" : "text-zinc-600 dark:text-zinc-400")}>
                  <Icon className="size-4" aria-hidden />{t(label)}
                </button>
              ))}
            </div>
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating({ day: today })} disabled={activeServices.length === 0}>
              {t("bookings.new")}
            </Button>
          </>
        }
      />

      {data && activeServices.length === 0 ? (
        <div className="mb-4">
          <Alert tone="amber">
            {t("bookings.noServices")} <Link to={`/b/${bid}/settings?tab=services`} className="font-medium underline">{t("bookings.noServicesLink")}</Link>
          </Alert>
        </div>
      ) : null}

      {view === "week" ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex">
            <Button variant="secondary" size="sm" className="rounded-r-none" onClick={() => go(-7)} aria-label={t("bookings.prevWeek")}>
              <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
            </Button>
            <Button variant="secondary" size="sm" className="-ml-px rounded-l-none" onClick={() => go(7)} aria-label={t("bookings.nextWeek")}>
              <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
            </Button>
          </div>
          <Button variant="secondary" size="sm" onClick={goToday}>{t("inbox.today")}</Button>
          <h2 className="ml-1 text-sm font-semibold tabular-nums">{rangeLabel}</h2>
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label={t("bookings.listLabel")}>
          {(["upcoming", "past", "cancelled"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={listMode === m} onClick={() => setListMode(m)}
              className={cx("rounded-full px-3 py-1 text-xs font-medium",
                listMode === m ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700")}>
              {t(`bookings.list.${m}` as Key)}
            </button>
          ))}
        </div>
      )}

      {error && !data ? (
        <div className="space-y-3"><Alert>{t("common.error")}</Alert><Button variant="secondary" onClick={refresh}>{t("common.retry")}</Button></div>
      ) : !data ? (
        <Spinner label={t("common.loading")} />
      ) : view === "week" ? (
        <>
          <WeekGrid anchor={anchor} data={data} onOpen={setSelectedId}
            onCreate={activeServices.length ? (day, time) => setCreating({ day, time }) : undefined} />
          <Agenda className="md:hidden" days={Array.from({ length: 7 }, (_, i) => addDays(anchor, i))} data={data} onOpen={setSelectedId} showEmptyDays />
        </>
      ) : (
        <Agenda days={[...new Set(data.bookings.map((b) => dayOf(b.start)))].sort(listMode === "past" ? (a, b) => b.localeCompare(a) : undefined)}
          data={data} onOpen={setSelectedId}
          empty={<EmptyState icon={<CalendarDays className="size-10" />} title={t(`bookings.empty.${listMode}` as Key)} />} />
      )}

      {selected && (
        <BookingDrawer key={selected.id} bid={bid!} booking={selected} services={services} now={data!.now}
          onClose={() => setSelectedId(null)} onChanged={refresh} />
      )}
      {creating && (
        <NewBooking bid={bid!} services={activeServices} initialDay={creating.day} initialTime={creating.time} today={today}
          onClose={() => setCreating(null)}
          onCreated={(b) => { setCreating(null); refresh(); navigated.current = true; if (view === "week") setAnchor(weekStart(dayOf(b.start))); }} />
      )}
    </div>
  );
}

// --- the week grid (desktop) ----------------------------------------------------------

function WeekGrid({ anchor, data, onOpen, onCreate }: {
  anchor: Day; data: BookingsResponse; onOpen: (id: number) => void; onCreate?: ((day: Day, time: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const tag = useLocaleTag();
  const days = Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  const visible = data.bookings.filter((b) => b.status !== "cancelled");

  // The rows span opening hours, widened to fit any booking outside them.
  const hours = Object.values(data.schedule).filter(Boolean) as DayHours[];
  let first = hours.length ? Math.min(...hours.map((h) => clockMinutes(h.open))) : 8 * 60;
  let last = hours.length ? Math.max(...hours.map((h) => clockMinutes(h.close))) : 18 * 60;
  for (const b of visible) { first = Math.min(first, minutesOf(b.start)); last = Math.max(last, minutesOf(b.end)); }
  const startHour = Math.max(0, Math.floor(first / 60));
  const endHour = Math.min(24, Math.max(startHour + 1, Math.ceil(last / 60)));
  const rows = endHour - startHour;
  const y = (m: number) => ((m - startHour * 60) / 60) * HOUR_PX;

  const nowDay = dayOf(data.now);
  const nowMin = minutesOf(data.now);

  return (
    <Card className="hidden overflow-hidden md:block">
      <div className="overflow-x-auto">
        <div className="grid min-w-[760px]" style={{ gridTemplateColumns: "3.5rem repeat(7, minmax(0, 1fr))" }}>
          <div className="border-b border-zinc-200 dark:border-zinc-800" />
          {days.map((d) => (
            <div key={d} className={cx("border-b border-l border-zinc-200 px-2 py-2 text-center dark:border-zinc-800", d === nowDay && "bg-brand-50/60 dark:bg-brand-900/20")}>
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{fmtWall(tag, d, { weekday: "short" })}</div>
              <div className={cx("mx-auto mt-0.5 grid size-8 place-items-center rounded-full text-sm font-semibold tabular-nums",
                d === nowDay ? "bg-brand-600 text-white" : "text-zinc-900 dark:text-zinc-100")}>
                {fmtWall(tag, d, { day: "numeric" })}
              </div>
            </div>
          ))}

          {/* hour labels */}
          <div className="relative" style={{ height: rows * HOUR_PX }}>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className={cx("absolute right-2 text-[11px] tabular-nums text-zinc-400", i > 0 && "-translate-y-1/2")} style={{ top: i === 0 ? 2 : i * HOUR_PX }}>
                {hhmm((startHour + i) * 60)}
              </div>
            ))}
          </div>

          {days.map((d) => {
            const open = data.schedule[String(weekdayOf(d)) as keyof Schedule];
            const dayBookings = visible.filter((b) => dayOf(b.start) === d);
            return (
              <div key={d}
                className={cx("relative border-l border-zinc-200 dark:border-zinc-800", onCreate && "cursor-copy")}
                style={{
                  height: rows * HOUR_PX,
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, var(--grid-line) ${HOUR_PX - 1}px, var(--grid-line) ${HOUR_PX}px)`,
                }}
                onClick={(e) => {
                  if (!onCreate || e.target !== e.currentTarget) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const m = startHour * 60 + Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30;
                  onCreate(d, hhmm(Math.min(m, 23 * 60 + 30)));
                }}
                title={onCreate ? t("bookings.clickToBook") : undefined}>
                {/* closed time is shaded, so a booking there stands out as the exception it is */}
                {!open ? <div className="pointer-events-none absolute inset-0 bg-zinc-100/70 dark:bg-zinc-950/50" /> : (
                  <>
                    <div className="pointer-events-none absolute inset-x-0 top-0 bg-zinc-100/70 dark:bg-zinc-950/50" style={{ height: Math.max(0, y(clockMinutes(open.open))) }} />
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-zinc-100/70 dark:bg-zinc-950/50" style={{ top: y(clockMinutes(open.close)) }} />
                  </>
                )}
                {d === nowDay && nowMin >= startHour * 60 && nowMin <= endHour * 60 && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: y(nowMin) }}>
                    <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-red-500" />
                  </div>
                )}
                {dayBookings.map((b) => {
                  const top = y(minutesOf(b.start));
                  const height = Math.max(22, y(minutesOf(b.end)) - top - 2);
                  return (
                    <button key={b.id} type="button" onClick={() => onOpen(b.id)}
                      className={cx("absolute inset-x-1 z-20 overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-left text-xs shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600",
                        STATUS_BLOCK[b.status])}
                      style={{ top, height }}>
                      <span className="block truncate font-semibold" dir="auto">{b.customerName ?? t("bookings.noName")}</span>
                      {height > 34 && <span className="block truncate tabular-nums opacity-80">{b.start.slice(11)}–{b.end.slice(11)} · {b.serviceName ?? ""}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// --- day-by-day list (phones, and the list view) ------------------------------------------

function Agenda({ days, data, onOpen, className, showEmptyDays, empty }: {
  days: Day[]; data: BookingsResponse; onOpen: (id: number) => void; className?: string; showEmptyDays?: boolean; empty?: ReactNode;
}) {
  const { t } = useI18n();
  const tag = useLocaleTag();
  const nowDay = dayOf(data.now);
  const byDay = (d: Day) => data.bookings.filter((b) => dayOf(b.start) === d && (showEmptyDays ? b.status !== "cancelled" : true));

  if (days.length === 0 && empty) return <Card className={className}>{empty}</Card>;

  return (
    <div className={cx("space-y-4", className)}>
      {days.map((d) => {
        const list = byDay(d);
        if (!showEmptyDays && list.length === 0) return null;
        const closed = !data.schedule[String(weekdayOf(d)) as keyof Schedule];
        return (
          <section key={d}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              {fmtWall(tag, d, { weekday: "long", day: "numeric", month: "long" })}
              {d === nowDay && <Badge tone="green">{t("inbox.today")}</Badge>}
              {closed && <span className="text-xs font-normal text-zinc-400">{t("settings.closed")}</span>}
            </h3>
            {list.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-3 text-sm text-zinc-400 dark:border-zinc-800">{t("bookings.nothing")}</p>
            ) : (
              <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {list.map((b) => <BookingRow key={b.id} b={b} onOpen={onOpen} />)}
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}

function BookingRow({ b, onOpen }: { b: Booking; onOpen: (id: number) => void }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => onOpen(b.id)}
      className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-zinc-50 focus:outline-none focus-visible:bg-zinc-50 sm:px-4 dark:hover:bg-zinc-800/50 dark:focus-visible:bg-zinc-800/50">
      <div className="w-24 shrink-0 text-sm tabular-nums">
        <div className="font-semibold">{b.start.slice(11)}</div>
        <div className="text-xs text-zinc-500">{t("settings.minutes", { n: b.durationMin })}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className={cx("truncate text-sm font-medium", b.status === "cancelled" && "text-zinc-500 line-through")} dir="auto">
          {b.customerName ?? t("bookings.noName")}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {b.serviceName ?? t("bookings.noService")}{b.waId ? ` · +${b.waId}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge tone={STATUS_TONE[b.status]}>{t(statusKey(b.status))}</Badge>
        <span className="text-[11px] text-zinc-400">{t(b.source === "agent" ? "bookings.byAgent" : "bookings.byOwner")}</span>
      </div>
    </button>
  );
}

// --- one booking -------------------------------------------------------------------------

function BookingDrawer({ bid, booking: b, services, now, onClose, onChanged }: {
  bid: string; booking: Booking; services: Service[]; now: Wall; onClose: () => void; onChanged: () => void;
}) {
  const { t } = useI18n();
  const tag = useLocaleTag();
  const [form, setForm] = useState({
    customerName: b.customerName ?? "", serviceId: b.serviceId ?? 0, date: dayOf(b.start), time: b.start.slice(11), notes: b.notes, status: b.status,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const dirty = form.customerName !== (b.customerName ?? "") || form.serviceId !== (b.serviceId ?? 0) ||
    `${form.date}T${form.time}` !== b.start || form.notes !== b.notes || form.status !== b.status;
  const past = b.start <= now;

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/b/${bid}/bookings/${b.id}`, { method: "PATCH", body });
      setNotice(t("common.saved"));
      onChanged();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setSaving(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (form.customerName !== (b.customerName ?? "")) body["customerName"] = form.customerName;
    if (form.serviceId !== (b.serviceId ?? 0) && form.serviceId) body["serviceId"] = form.serviceId;
    if (`${form.date}T${form.time}` !== b.start) body["start"] = `${form.date}T${form.time}`;
    if (form.notes !== b.notes) body["notes"] = form.notes;
    if (form.status !== b.status) body["status"] = form.status;
    void patch(body);
  };

  const quick = (status: Status) => { setForm((f) => ({ ...f, status })); void patch({ status }); };

  // Services offered now, plus this booking's own if it has since been retired.
  const serviceOptions = services.filter((s) => s.active || s.id === b.serviceId);

  return (
    <Modal open side onClose={onClose} title={b.customerName ?? t("bookings.noName")}
      footer={
        <>
          {b.status !== "cancelled" && (
            <Button variant="ghost" className="mr-auto !text-red-600 dark:!text-red-400" onClick={() => setCancelling(true)}>{t("bookings.cancelBooking")}</Button>
          )}
          <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
          <Button type="submit" form="booking-form" loading={saving} disabled={!dirty}>{t("common.save")}</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[b.status]}>{t(statusKey(b.status))}</Badge>
          <span className="text-sm text-zinc-600 dark:text-zinc-300">
            {fmtWall(tag, b.start, { weekday: "long", day: "numeric", month: "long" })} · <span className="tabular-nums">{b.start.slice(11)}–{b.end.slice(11)}</span>
          </span>
        </div>
        <p className="text-xs text-zinc-500">
          {t(b.source === "agent" ? "bookings.madeByAgent" : "bookings.madeByOwner")}
          {b.waId && <> · <span dir="ltr">+{b.waId}</span></>}
        </p>
        {b.waId && (
          <Link to={`/b/${bid}/inbox/${b.waId}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
            <MessageSquareText className="size-4" aria-hidden />{t("bookings.openConversation")}
          </Link>
        )}

        {b.status !== "cancelled" && (
          <div className="flex flex-wrap gap-2">
            {!past && b.status === "booked" && <Button size="sm" variant="secondary" disabled={saving} onClick={() => quick("confirmed")}>{t("bookings.markConfirmed")}</Button>}
            {past && b.status !== "completed" && <Button size="sm" variant="secondary" disabled={saving} onClick={() => quick("completed")}>{t("bookings.markCompleted")}</Button>}
            {past && b.status !== "no_show" && <Button size="sm" variant="secondary" disabled={saving} onClick={() => quick("no_show")}>{t("bookings.markNoShow")}</Button>}
          </div>
        )}

        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}

        {cancelling ? (
          <CancelPanel bid={bid} booking={b} onDone={(msg) => { setCancelling(false); setNotice(msg); onChanged(); }} onBack={() => setCancelling(false)} />
        ) : (
          <form id="booking-form" onSubmit={save} className="space-y-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <Field label={t("bookings.customerName")} value={form.customerName} maxLength={120}
              onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
            <Select label={t("bookings.service")} value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: Number(e.target.value) })}>
              {serviceOptions.length === 0 && <option value={0}>{t("bookings.noService")}</option>}
              {serviceOptions.map((s) => <option key={s.id} value={s.id}>{s.name} · {t("settings.minutes", { n: s.durationMin })}{s.active ? "" : ` (${t("settings.retired")})`}</option>)}
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("bookings.date")} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
              <Field label={t("bookings.time")} type="time" step={300} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} required />
            </div>
            <Select label={t("bookings.statusLabel")} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>
              {STATUSES.map((s) => <option key={s} value={s}>{t(statusKey(s))}</option>)}
            </Select>
            <TextArea label={t("bookings.notes")} value={form.notes} maxLength={1000} rows={3}
              onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </form>
        )}
      </div>
    </Modal>
  );
}

function CancelPanel({ bid, booking: b, onDone, onBack }: {
  bid: string; booking: Booking; onDone: (message: string) => void; onBack: () => void;
}) {
  const { t } = useI18n();
  const tag = useLocaleTag();
  const [notify, setNotify] = useState(Boolean(b.waId));
  const [message, setMessage] = useState(() => t("bookings.cancelTemplate", {
    name: b.customerName ?? "", service: b.serviceName ?? "",
    date: fmtWall(tag, b.start, { weekday: "long", day: "numeric", month: "long" }), time: b.start.slice(11),
  }).replace(/\s+,/g, ","));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ notified: boolean; notifyError: string | null }>(`/api/b/${bid}/bookings/${b.id}/cancel`, {
        method: "POST", body: { notify, message },
      });
      const reasons: Record<string, Key> = {
        window_closed: "bookings.notify.windowClosed", not_connected: "inbox.notConnected",
        no_whatsapp: "bookings.notify.noWhatsapp", send_failed: "inbox.sendFailed", empty_message: "bookings.notify.empty",
      };
      onDone(!notify ? t("bookings.cancelledOk")
        : r.notified ? t("bookings.cancelledNotified")
        : `${t("bookings.cancelledNotNotified")} ${t(reasons[r.notifyError ?? ""] ?? "common.error")}`);
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900/50 dark:bg-red-950/20">
      <p className="text-sm font-medium">{t("bookings.cancelConfirm")}</p>
      <label className={cx("flex items-start gap-2 text-sm", !b.waId && "opacity-60")}>
        <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={notify} disabled={!b.waId} onChange={(e) => setNotify(e.target.checked)} />
        <span>{t("bookings.notifyCustomer")}{!b.waId && <span className="block text-xs text-zinc-500">{t("bookings.notify.noWhatsapp")}</span>}</span>
      </label>
      {notify && <TextArea label={t("bookings.notifyMessage")} hint={t("bookings.notifyHint")} value={message} rows={4} maxLength={1000} onChange={(e) => setMessage(e.target.value)} />}
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" loading={busy} onClick={() => void confirm()}>{t("bookings.confirmCancel")}</Button>
        <Button variant="secondary" disabled={busy} onClick={onBack}>{t("bookings.keepBooking")}</Button>
      </div>
    </div>
  );
}

// --- a new booking ---------------------------------------------------------------------------

function NewBooking({ bid, services, initialDay, initialTime, today, onClose, onCreated }: {
  bid: string; services: Service[]; initialDay: Day; initialTime?: string | undefined; today: Day;
  onClose: () => void; onCreated: (b: Booking) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    customerName: "", waId: "", serviceId: services[0]?.id ?? 0, date: initialDay < today ? today : initialDay, time: initialTime ?? "", notes: "",
  });
  const [slots, setSlots] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opened before the services arrived (a ?new=1 link): pick the first once they do.
  const firstService = services[0]?.id ?? 0;
  useEffect(() => {
    if (!form.serviceId && firstService) setForm((f) => ({ ...f, serviceId: firstService }));
  }, [firstService, form.serviceId]);

  useEffect(() => {
    if (!form.serviceId || !form.date) return;
    const ctrl = new AbortController();
    setSlots(null);
    api<{ slots: string[] }>(`/api/b/${bid}/bookings/slots?date=${form.date}&serviceId=${form.serviceId}`, { signal: ctrl.signal })
      .then((r) => setSlots(r.slots.map((s) => s.slice(11))))
      .catch(() => setSlots([]));
    return () => ctrl.abort();
  }, [bid, form.serviceId, form.date]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ booking: Booking }>(`/api/b/${bid}/bookings`, {
        method: "POST",
        body: {
          customerName: form.customerName, serviceId: form.serviceId, start: `${form.date}T${form.time}`,
          ...(form.waId ? { waId: form.waId.replace(/\D/g, "") } : {}),
          ...(form.notes ? { notes: form.notes } : {}),
        },
      });
      onCreated(r.booking);
    } catch (err) {
      setError(errorText(t, err));
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t("bookings.new")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="new-booking" loading={saving} icon={<CalendarPlus className="size-4" aria-hidden />}
            disabled={!form.customerName.trim() || !form.time || !form.serviceId}>
            {t("bookings.create")}
          </Button>
        </>
      }>
      <form id="new-booking" onSubmit={submit} className="space-y-4">
        <Field label={t("bookings.customerName")} value={form.customerName} maxLength={120} required autoComplete="off"
          onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
        <Field label={t("bookings.whatsapp")} hint={t("bookings.whatsappHint")} value={form.waId} inputMode="tel" maxLength={24} autoComplete="off"
          onChange={(e) => setForm({ ...form, waId: e.target.value })} />
        <Select label={t("bookings.service")} value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: Number(e.target.value) })}>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name} · {t("settings.minutes", { n: s.durationMin })}</option>)}
        </Select>
        <Field label={t("bookings.date")} type="date" min={today} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value, time: "" })} required />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("bookings.time")}</legend>
          {slots === null ? (
            <p className="text-sm text-zinc-500">{t("common.loading")}</p>
          ) : slots.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("bookings.noSlots")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {slots.map((s) => (
                <button key={s} type="button" aria-pressed={form.time === s} onClick={() => setForm({ ...form, time: s })}
                  className={cx("min-h-8 rounded-lg px-2.5 text-sm tabular-nums ring-1 ring-inset",
                    form.time === s ? "bg-brand-600 text-white ring-brand-600" : "ring-zinc-300 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800")}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-end sm:gap-3">
            <Field className="w-40 shrink-0" label={t("bookings.otherTime")} type="time" step={300} value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })} />
            <p className="text-xs text-zinc-500 sm:pb-2">{t("bookings.otherTimeHint")}</p>
          </div>
        </fieldset>

        <TextArea label={t("bookings.notes")} value={form.notes} rows={2} maxLength={1000} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        {error && <Alert>{error}</Alert>}
      </form>
    </Modal>
  );
}

