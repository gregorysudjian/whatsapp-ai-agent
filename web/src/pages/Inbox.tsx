import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  AlertCircle, ArrowDown, ArrowLeft, Bot, Check, CheckCheck, Clock, Hand, Inbox as InboxIcon,
  MessageSquareText, Search, SendHorizontal, UserRound,
} from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, cx, EmptyState, Spinner } from "../components/ui.tsx";

// --- shapes (mirror src/store/queries.ts) ------------------------------------

type Sender = "customer" | "ai" | "human" | "system";
type Filter = "all" | "needs_human" | "human" | "ai";

interface Conversation {
  waId: string;
  name: string | null;
  lastMessageTs: number | null;
  lastText: string;
  lastDirection: "in" | "out" | null;
  lastSender: Sender | null;
  windowRemainingMs: number;
  needsHuman: boolean;
  handoffReason: string | null;
  control: "ai" | "human";
  takenOverBy: string | null;
  awaitingReply: boolean;
}

interface Message {
  id: string;
  direction: "in" | "out";
  type: string;
  text: string;
  ts: number;
  status: string | null;
  sender: Sender;
  sentBy: string | null;
}

interface Thread {
  conversation: Conversation | null;
  window: { open: boolean; remainingMs: number };
  messages: Message[];
}

const FILTERS: { id: Filter; label: Key }[] = [
  { id: "all", label: "inbox.filter.all" },
  { id: "needs_human", label: "inbox.filter.needsHuman" },
  { id: "human", label: "inbox.filter.human" },
  { id: "ai", label: "inbox.filter.ai" },
];

const MAX_REPLY = 4096;

// --- helpers ------------------------------------------------------------------

const phone = (waId: string) => `+${waId}`;

function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "#";
  return (parts[0]![0]! + (parts.length > 1 ? parts.at(-1)![0]! : "")).toUpperCase();
}

const AVATAR_TONES = [
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
];

function Avatar({ waId, name, size = "md" }: { waId: string; name: string | null; size?: "md" | "lg" }) {
  let h = 0;
  for (const c of waId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span aria-hidden className={cx(
      "grid shrink-0 place-items-center rounded-full font-semibold",
      size === "lg" ? "size-10 text-sm" : "size-11 text-sm",
      AVATAR_TONES[h % AVATAR_TONES.length],
    )}>
      {initials(name)}
    </span>
  );
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

// --- the page -----------------------------------------------------------------

export function Inbox() {
  const { bid, waId } = useParams();
  const { t } = useI18n();
  const { me } = useAuth();
  const connected = me?.businesses.find((b) => String(b.id) === bid)?.connected ?? false;

  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState(false);
  // Bumped by the live stream; every fetch below re-runs when it changes.
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(false);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const ctrl = new AbortController();
    const params = new URLSearchParams({ filter, q });
    api<{ conversations: Conversation[] }>(`/api/b/${bid}/conversations?${params}`, { signal: ctrl.signal })
      .then((r) => { setConversations(r.conversations); setListError(false); })
      .catch((err: unknown) => { if ((err as Error).name !== "AbortError") setListError(true); });
    return () => ctrl.abort();
  }, [bid, filter, q, tick]);

  // Live updates. Events only say "something changed"; the page refetches, so
  // a missed event while disconnected costs nothing - reconnecting refetches too.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((n) => n + 1), 300);
    };
    const es = new EventSource(`/api/b/${bid}/stream`);
    es.onopen = () => { setLive(true); bump(); };
    es.onmessage = bump;
    es.onerror = () => setLive(false);
    return () => { clearTimeout(timer); es.close(); };
  }, [bid]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return (
    // Fills the viewport under the top bar: the list and the thread scroll on
    // their own, like a messaging app, instead of the whole page scrolling.
    <div className="flex h-[calc(100dvh-4rem-3.5rem-env(safe-area-inset-bottom))] overflow-hidden border-zinc-200 bg-white lg:h-[calc(100dvh-4rem-3rem)] lg:rounded-xl lg:border lg:shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <section aria-label={t("inbox.title")}
        className={cx("flex w-full min-w-0 flex-col border-zinc-200 md:w-80 md:border-r lg:w-96 dark:border-zinc-800", waId && "hidden md:flex")}>
        <div className="space-y-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-2 px-1">
            <h1 className="text-lg font-semibold tracking-tight">{t("inbox.title")}</h1>
            <span className={cx("inline-flex items-center gap-1.5 text-xs", live ? "text-brand-700 dark:text-brand-300" : "text-zinc-400")}
              title={live ? t("inbox.liveHint") : t("inbox.reconnecting")}>
              <span className={cx("size-2 rounded-full", live ? "bg-brand-500" : "bg-zinc-300 dark:bg-zinc-600")} aria-hidden />
              {live ? t("inbox.live") : t("inbox.reconnecting")}
            </span>
          </div>
          <label className="relative block">
            <span className="sr-only">{t("common.search")}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100}
              placeholder={t("inbox.searchPlaceholder")}
              className="block h-10 w-full rounded-lg border border-zinc-300 bg-white pl-9 pr-3 text-sm shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-600/40 dark:border-zinc-700 dark:bg-zinc-900" />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("inbox.filterLabel")}>
            {FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                className={cx(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  filter === f.id
                    ? "bg-brand-600 text-white"
                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
                )}>
                {t(f.label)}
              </button>
            ))}
          </div>
        </div>
        <ConversationList conversations={conversations} error={listError} activeWaId={waId} bid={bid!}
          filtered={filter !== "all" || q !== ""} onRetry={refresh} />
      </section>

      <section className={cx("min-w-0 flex-1 flex-col", waId ? "flex" : "hidden md:flex")}>
        {waId
          ? <ThreadView key={waId} bid={bid!} waId={waId} tick={tick} connected={connected} onChanged={refresh} />
          : <div className="grid flex-1 place-items-center bg-zinc-50 dark:bg-zinc-950/40">
              <EmptyState icon={<MessageSquareText className="size-10" />} title={t("inbox.pick")} body={t("inbox.pickBody")} />
            </div>}
      </section>
    </div>
  );
}

// --- the list -------------------------------------------------------------------

function ConversationList({ conversations, error, activeWaId, bid, filtered, onRetry }: {
  conversations: Conversation[] | null; error: boolean; activeWaId: string | undefined; bid: string;
  filtered: boolean; onRetry: () => void;
}) {
  const { t, fmtDate } = useI18n();

  if (error && !conversations) {
    return <div className="space-y-3 p-4"><Alert>{t("common.error")}</Alert><Button variant="secondary" onClick={onRetry}>{t("common.retry")}</Button></div>;
  }
  if (!conversations) return <Spinner label={t("common.loading")} />;
  if (conversations.length === 0) {
    return filtered
      ? <EmptyState icon={<Search className="size-8" />} title={t("inbox.noMatches")} />
      : <EmptyState icon={<InboxIcon className="size-10" />} title={t("inbox.empty")} body={t("inbox.emptyBody")} />;
  }

  const now = Date.now();
  const when = (ms: number | null) => {
    if (!ms) return "";
    if (sameDay(ms, now)) return fmtDate(ms, { timeStyle: "short" });
    if (sameDay(ms, now - 86_400_000)) return t("inbox.yesterday");
    if (now - ms < 6 * 86_400_000) return fmtDate(ms, { weekday: "short" });
    return fmtDate(ms, { dateStyle: "short" });
  };
  const prefix = (c: Conversation) =>
    c.lastDirection !== "out" ? "" :
    c.lastSender === "human" ? t("inbox.preview.human") :
    c.lastSender === "system" ? t("inbox.preview.system") : t("inbox.preview.ai");

  return (
    <ul className="flex-1 overflow-y-auto">
      {conversations.map((c) => {
        const active = c.waId === activeWaId;
        return (
          <li key={c.waId}>
            <Link to={`/b/${bid}/inbox/${c.waId}`} aria-current={active ? "page" : undefined}
              className={cx(
                "flex gap-3 border-b border-zinc-100 px-3 py-3 transition-colors dark:border-zinc-800/70",
                active ? "bg-brand-50 dark:bg-brand-900/25" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
              )}>
              <Avatar waId={c.waId} name={c.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className={cx("truncate text-sm", c.awaitingReply ? "font-semibold text-zinc-900 dark:text-zinc-50" : "font-medium text-zinc-800 dark:text-zinc-200")}
                    dir="auto">
                    {c.name ?? phone(c.waId)}
                  </p>
                  <span className={cx("shrink-0 text-xs tabular-nums", c.awaitingReply ? "font-medium text-brand-700 dark:text-brand-300" : "text-zinc-400")}>
                    {when(c.lastMessageTs)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400" dir="auto">
                    {prefix(c) && <span className="text-zinc-400 dark:text-zinc-500">{prefix(c)} </span>}
                    {c.lastText || t("inbox.nonText")}
                  </p>
                  {c.awaitingReply && <span className="size-2.5 shrink-0 rounded-full bg-brand-500" aria-label={t("inbox.awaiting")} />}
                </div>
                {(c.needsHuman || c.control === "human") && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {c.needsHuman && <Badge tone="amber"><Hand className="size-3" aria-hidden />{t("inbox.badge.needsHuman")}</Badge>}
                    {c.control === "human" && !c.needsHuman && <Badge tone="blue"><UserRound className="size-3" aria-hidden />{t("inbox.badge.human")}</Badge>}
                  </div>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// --- one conversation -------------------------------------------------------------

function ThreadView({ bid, waId, tick, connected, onChanged }: {
  bid: string; waId: string; tick: number; connected: boolean; onChanged: () => void;
}) {
  const { t, fmtDate } = useI18n();
  const { me } = useAuth();
  const navigate = useNavigate();
  const [thread, setThread] = useState<Thread | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  // Follow new messages only if the reader is already at the bottom; someone
  // scrolled up reading history must not be yanked down by a new message.
  const stick = useRef(true);
  const lastCount = useRef(0);

  const nearBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const ctrl = new AbortController();
    api<Thread>(`/api/b/${bid}/conversations/${waId}/messages`, { signal: ctrl.signal })
      .then((r) => {
        stick.current = state === "loading" || nearBottom();
        setThread(r);
        setState("ready");
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setState(err instanceof ApiError && err.status === 404 ? "missing" : "error");
      });
    return () => ctrl.abort();
    // `state` is read only to know whether this is the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bid, waId, tick]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !thread) return;
    const grew = thread.messages.length > lastCount.current;
    lastCount.current = thread.messages.length;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (grew) {
      setShowJump(true);
    }
  }, [thread]);

  const act = async (path: "takeover" | "handback") => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await api<Pick<Thread, "conversation" | "window">>(`/api/b/${bid}/conversations/${waId}/${path}`, { method: "POST" });
      setThread((prev) => prev && { ...prev, ...r });
      onChanged();
    } catch {
      setActionError(t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <Spinner label={t("common.loading")} />;
  if (state === "missing" || state === "error" || !thread) {
    return (
      <div className="grid flex-1 place-items-center">
        <EmptyState icon={<AlertCircle className="size-10" />}
          title={state === "missing" ? t("inbox.missing") : t("common.error")}
          action={<Button variant="secondary" onClick={() => navigate(`/b/${bid}/inbox`)}>{t("inbox.backToList")}</Button>} />
      </div>
    );
  }

  const c = thread.conversation;
  const human = c?.control === "human";
  const mine = human && c?.takenOverBy === me?.user.email;
  const hoursLeft = Math.floor(thread.window.remainingMs / 3_600_000);
  const minutesLeft = Math.max(1, Math.round(thread.window.remainingMs / 60_000));

  return (
    <>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 px-3 py-2.5 sm:flex-nowrap sm:px-4 dark:border-zinc-800">
        <Link to={`/b/${bid}/inbox`} className="grid size-9 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-100 md:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label={t("inbox.backToList")}>
          <ArrowLeft className="size-5 rtl:rotate-180" aria-hidden />
        </Link>
        <Avatar waId={waId} name={c?.name ?? null} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" dir="auto">{c?.name ?? phone(waId)}</h2>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
            {c?.name && <span className="tabular-nums" dir="ltr">{phone(waId)}</span>}
            <span className={cx("inline-flex items-center gap-1", thread.window.open ? "" : "text-red-600 dark:text-red-400")}>
              <Clock className="size-3" aria-hidden />
              {thread.window.open
                ? t("inbox.windowOpen", { time: hoursLeft >= 1 ? t("inbox.hours", { n: hoursLeft }) : t("inbox.minutes", { n: minutesLeft }) })
                : t("inbox.windowClosed")}
            </span>
          </p>
        </div>
        {/* On a phone the actions get their own row, so a long label (French
            runs long) never squeezes the customer's name to nothing. */}
        <div className="flex basis-full items-center gap-2 sm:basis-auto sm:shrink-0 [&>button:first-child]:flex-1 sm:[&>button:first-child]:flex-none">
          {/* Escalated or someone else's: claiming it is the main action.
              Mine: handing it back is. */}
          {!mine && (
            <Button size="sm" disabled={busy} onClick={() => act("takeover")} icon={<Hand className="size-4" aria-hidden />}>
              {t("inbox.takeOver")}
            </Button>
          )}
          {human && (
            <Button size="sm" variant={mine ? "secondary" : "ghost"} disabled={busy} onClick={() => act("handback")}
              icon={<Bot className="size-4" aria-hidden />} aria-label={t("inbox.handBack")} title={t("inbox.handBack")}>
              <span className={mine ? "hidden sm:inline" : "hidden xl:inline"}>{t("inbox.handBack")}</span>
              {mine && <span className="sm:hidden">{t("inbox.handBackShort")}</span>}
            </Button>
          )}
        </div>
      </header>

      {(human || c?.needsHuman) && (
        <div className={cx("flex items-start gap-2 border-b px-4 py-2 text-sm",
          c?.needsHuman && !c.takenOverBy
            ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
            : "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200")}
          role="status">
          <Hand className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="min-w-0">
            {c?.needsHuman && !c.takenOverBy
              ? (c.handoffReason ? t("inbox.bannerNeeds", { reason: c.handoffReason }) : t("inbox.bannerNeedsNoReason"))
              : mine ? t("inbox.bannerYou") : t("inbox.bannerOther", { who: c?.takenOverBy ?? "" })}
          </p>
        </div>
      )}
      {actionError && <div className="px-4 pt-3"><Alert>{actionError}</Alert></div>}

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={() => { if (nearBottom()) setShowJump(false); }}
          className="h-full overflow-y-auto bg-zinc-50 px-3 py-4 sm:px-6 dark:bg-zinc-950/40"
          role="log" aria-live="polite" aria-label={t("inbox.thread")}>
          <Messages messages={thread.messages} myEmail={me?.user.email ?? null} fmtDate={fmtDate} />
        </div>
        {showJump && (
          <button type="button" onClick={() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; setShowJump(false); }}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
            <ArrowDown className="size-3.5" aria-hidden />{t("inbox.newMessages")}
          </button>
        )}
      </div>

      <Composer bid={bid} waId={waId} canSend={connected && thread.window.open} connected={connected}
        takesOver={!human} onSent={(r) => { stick.current = true; setThread((prev) => prev && { ...prev, ...r }); onChanged(); }} />
    </>
  );
}

function Messages({ messages, myEmail, fmtDate }: {
  messages: Message[]; myEmail: string | null; fmtDate: (ms: number, o?: Intl.DateTimeFormatOptions) => string;
}) {
  const { t } = useI18n();
  const now = Date.now();
  const dayLabel = (ms: number) =>
    sameDay(ms, now) ? t("inbox.today") :
    sameDay(ms, now - 86_400_000) ? t("inbox.yesterday") :
    fmtDate(ms, { weekday: "long", day: "numeric", month: "long" });

  const who = (m: Message) =>
    m.sender === "human" ? (m.sentBy && m.sentBy === myEmail ? t("inbox.you") : m.sentBy ?? t("inbox.team")) :
    m.sender === "system" ? t("inbox.system") : t("inbox.agent");

  if (messages.length === 0) return <p className="py-10 text-center text-sm text-zinc-500">{t("inbox.noMessages")}</p>;

  return (
    <ol className="mx-auto max-w-3xl space-y-1.5">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || !sameDay(prev.ts, m.ts);
        const out = m.direction === "out";
        // A run of messages from the same author shows its label once.
        const firstOfRun = newDay || !prev || prev.direction !== m.direction || prev.sender !== m.sender || prev.sentBy !== m.sentBy;
        return (
          <li key={m.id}>
            {newDay && (
              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-zinc-500 shadow-sm dark:bg-zinc-800 dark:text-zinc-400">{dayLabel(m.ts)}</span>
              </div>
            )}
            <div className={cx("flex", out ? "justify-end" : "justify-start", firstOfRun && i > 0 && !newDay && "pt-2")}>
              <div className={cx(
                "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[75%]",
                out
                  ? m.sender === "human"
                    ? "rounded-br-md bg-sky-100 text-sky-950 dark:bg-sky-900/50 dark:text-sky-50"
                    : "rounded-br-md bg-brand-100 text-zinc-900 dark:bg-brand-900/50 dark:text-zinc-50"
                  : "rounded-bl-md bg-white text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
              )}>
                {out && firstOfRun && (
                  <p className={cx("mb-0.5 flex items-center gap-1 text-xs font-semibold",
                    m.sender === "human" ? "text-sky-700 dark:text-sky-300" : "text-brand-700 dark:text-brand-300")}>
                    {m.sender === "human" ? <UserRound className="size-3" aria-hidden /> : <Bot className="size-3" aria-hidden />}
                    {who(m)}
                  </p>
                )}
                <p className="whitespace-pre-wrap break-words" dir="auto">
                  {m.text || <span className="italic text-zinc-500">{t("inbox.nonTextType", { type: m.type })}</span>}
                </p>
                <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <time dateTime={new Date(m.ts).toISOString()}>{fmtDate(m.ts, { timeStyle: "short" })}</time>
                  {out && <Ticks status={m.status} />}
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Ticks({ status }: { status: string | null }) {
  const { t } = useI18n();
  if (status === "failed") {
    return <span className="inline-flex items-center gap-0.5 font-medium text-red-600 dark:text-red-400"><AlertCircle className="size-3.5" aria-hidden />{t("inbox.status.failed")}</span>;
  }
  if (status === "read") return <CheckCheck className="size-3.5 text-sky-500" aria-label={t("inbox.status.read")} />;
  if (status === "delivered") return <CheckCheck className="size-3.5" aria-label={t("inbox.status.delivered")} />;
  return <Check className="size-3.5" aria-label={t("inbox.status.sent")} />;
}

// --- the reply box ---------------------------------------------------------------

function Composer({ bid, waId, canSend, connected, takesOver, onSent }: {
  bid: string; waId: string; canSend: boolean; connected: boolean; takesOver: boolean;
  onSent: (r: Pick<Thread, "conversation" | "window">) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const over = text.length > MAX_REPLY;
  const empty = text.trim() === "";

  const send = async () => {
    if (empty || over || sending || !canSend) return;
    setSending(true);
    setError(null);
    try {
      const r = await api<Pick<Thread, "conversation" | "window">>(`/api/b/${bid}/conversations/${waId}/reply`, { method: "POST", body: { text } });
      setText("");
      onSent(r);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "window_closed" ? t("inbox.windowClosedBody")
        : code === "not_connected" ? t("inbox.notConnected")
        : err instanceof ApiError && err.status === 0 ? t("common.offline")
        : t("inbox.sendFailed"));
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line; never mid-composition (IME input).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const blocked = !connected ? t("inbox.notConnected") : !canSend ? t("inbox.windowClosedBody") : null;
  const counter = useMemo(() => text.length > MAX_REPLY - 500, [text]);

  return (
    <div className="border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      {error && <div className="mb-2"><Alert>{error}</Alert></div>}
      {blocked ? (
        <p className="flex items-start gap-2 rounded-lg bg-zinc-100 px-3 py-2.5 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />{blocked}
        </p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">{t("inbox.composerLabel")}</span>
              <textarea ref={box} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
                placeholder={t("inbox.composerPlaceholder")} dir="auto"
                aria-invalid={over || undefined}
                className={cx(
                  "block max-h-[200px] min-h-10 w-full resize-none rounded-2xl border bg-white px-4 py-2 text-sm leading-6 shadow-sm",
                  "placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-600/40 dark:bg-zinc-900",
                  over ? "border-red-500" : "border-zinc-300 dark:border-zinc-700",
                )} />
            </label>
            <Button onClick={() => void send()} loading={sending} disabled={empty || over}
              className="size-10 shrink-0 rounded-full !p-0" aria-label={t("inbox.send")}>
              {!sending && <SendHorizontal className="size-4 rtl:rotate-180" aria-hidden />}
            </Button>
          </div>
          <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 px-1 text-xs text-zinc-400">
            {takesOver
              ? <span>{t("inbox.replyTakesOver")}</span>
              : <span className="hidden sm:inline">{t("inbox.composerHint")}</span>}
            {counter && <span className={cx("tabular-nums", over && "font-medium text-red-600")}>{text.length} / {MAX_REPLY}</span>}
          </div>
        </>
      )}
    </div>
  );
}
