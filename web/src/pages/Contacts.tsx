import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowDown, Download, Search, Trash2, Users } from "lucide-react";
import { api } from "../lib/api.ts";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, cx, EmptyState, Modal, PageHeader, Spinner } from "../components/ui.tsx";

interface Contact {
  waId: string;
  name: string | null;
  firstSeen: number;
  lastMessageTs: number | null;
  inbound: number;
  outbound: number;
  bookings: number;
  control: "ai" | "human";
  needsHuman: boolean;
}

type Sort = "recent" | "name" | "first_seen" | "messages";
const SORTS: { id: Sort; label: Key }[] = [
  { id: "recent", label: "contacts.sort.recent" },
  { id: "name", label: "contacts.sort.name" },
  { id: "first_seen", label: "contacts.sort.firstSeen" },
  { id: "messages", label: "contacts.sort.messages" },
];

export function Contacts() {
  const { bid } = useParams();
  const { t, locale, fmtDate, fmtNumber } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [erasing, setErasing] = useState<Contact | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    api<{ contacts: Contact[] }>(`/api/b/${bid}/contacts?${new URLSearchParams({ q, sort })}`, { signal: ctrl.signal })
      .then((r) => { setContacts(r.contacts); setError(false); })
      .catch((err: unknown) => { if ((err as Error).name !== "AbortError") setError(true); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [bid, q, sort, tick]);

  const exportHref = `/api/b/${bid}/contacts.csv?${new URLSearchParams({ q, sort, lang: locale })}`;
  const when = (ms: number | null) => (ms ? fmtDate(ms, { dateStyle: "medium" }) : "—");
  const status = (c: Contact) =>
    c.needsHuman ? <Badge tone="amber">{t("inbox.badge.needsHuman")}</Badge>
    : c.control === "human" ? <Badge tone="blue">{t("inbox.badge.human")}</Badge>
    : <Badge>{t("contacts.withAgent")}</Badge>;
  const open = (c: Contact) => navigate(`/b/${bid}/inbox/${c.waId}`);

  const SortHeader = ({ id, children, right }: { id: Sort; children: string; right?: boolean }) => (
    <th scope="col" aria-sort={sort === id ? (id === "name" ? "ascending" : "descending") : "none"}
      className={cx("px-4 py-2.5 font-medium", right && "text-right")}>
      <button type="button" onClick={() => setSort(id)} className={cx("inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100", sort === id && "text-zinc-900 dark:text-zinc-100")}>
        {children}{sort === id && <ArrowDown className={cx("size-3.5", id === "name" && "rotate-180")} aria-hidden />}
      </button>
    </th>
  );

  return (
    <div>
      <PageHeader title={t("nav.contacts")} subtitle={t("contacts.subtitle")}
        actions={
          // A plain link: the browser downloads the file with the session cookie.
          <a href={exportHref} download
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-800 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800">
            <Download className="size-4" aria-hidden />{t("contacts.export")}
          </a>
        } />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative block w-full sm:w-auto sm:min-w-0 sm:max-w-sm sm:flex-1">
          <span className="sr-only">{t("common.search")}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100}
            placeholder={t("inbox.searchPlaceholder")}
            className="block h-10 w-full rounded-lg border border-zinc-300 bg-white pl-9 pr-3 text-sm shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-600/40 dark:border-zinc-700 dark:bg-zinc-900" />
        </label>
        <label className="flex items-center gap-2 text-sm md:hidden">
          <span className="text-zinc-500">{t("contacts.sortBy")}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
            className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}
          </select>
        </label>
        {contacts && <p className="text-sm text-zinc-500" aria-live="polite">{t("contacts.count", { n: fmtNumber(contacts.length) })}</p>}
      </div>

      <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{t("contacts.exportNote")}</p>

      {error && !contacts ? <Alert>{t("common.error")}</Alert>
        : !contacts ? <Spinner label={t("common.loading")} />
        : contacts.length === 0 ? (
          <Card>{q
            ? <EmptyState icon={<Search className="size-8" />} title={t("inbox.noMatches")} />
            : <EmptyState icon={<Users className="size-10" />} title={t("contacts.empty")} body={t("contacts.emptyBody")} />}</Card>
        ) : (
          <div className={cx("transition-opacity", loading && "opacity-60")}>
            {/* Desktop: a table */}
            <Card className="hidden overflow-hidden md:block">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
                    <tr>
                      <SortHeader id="name">{t("contacts.col.name")}</SortHeader>
                      <SortHeader id="first_seen">{t("contacts.col.firstSeen")}</SortHeader>
                      <SortHeader id="recent">{t("contacts.col.lastMessage")}</SortHeader>
                      <SortHeader id="messages" right>{t("contacts.col.messages")}</SortHeader>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">{t("nav.bookings")}</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">{t("contacts.col.status")}</th>
                      <th scope="col" className="px-2 py-2.5"><span className="sr-only">{t("contacts.erase")}</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {contacts.map((c) => (
                      <tr key={c.waId} onClick={() => open(c)} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                        <td className="px-4 py-2.5">
                          {/* The real link, for keyboards and "open in new tab"; the row click is a convenience. */}
                          <Link to={`/b/${bid}/inbox/${c.waId}`} onClick={(e) => e.stopPropagation()}
                            className="font-medium text-zinc-900 hover:underline dark:text-zinc-50" dir="auto">
                            {c.name ?? `+${c.waId}`}
                          </Link>
                          {c.name && <div className="text-xs tabular-nums text-zinc-500" dir="ltr">+{c.waId}</div>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600 dark:text-zinc-300">{when(c.firstSeen)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600 dark:text-zinc-300">{when(c.lastMessageTs)}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                          {fmtNumber(c.inbound)} <span className="text-zinc-400">/</span> {fmtNumber(c.outbound)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{fmtNumber(c.bookings)}</td>
                        <td className="px-4 py-2.5">{status(c)}</td>
                        <td className="px-2 py-2.5 text-right">
                          <button type="button" onClick={(e) => { e.stopPropagation(); setErasing(c); }}
                            className="grid size-8 place-items-center rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                            aria-label={t("contacts.eraseWho", { who: c.name ?? `+${c.waId}` })} title={t("contacts.erase")}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">{t("contacts.messagesKey")}</p>
            </Card>

            {/* Phones: cards */}
            <ul className="space-y-2 md:hidden">
              {contacts.map((c) => (
                <li key={c.waId} className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/b/${bid}/inbox/${c.waId}`} className="min-w-0 flex-1">
                      <p className="truncate font-medium" dir="auto">{c.name ?? `+${c.waId}`}</p>
                      {c.name && <p className="text-xs tabular-nums text-zinc-500" dir="ltr">+{c.waId}</p>}
                    </Link>
                    {status(c)}
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <p className="text-xs text-zinc-500">
                      {t("contacts.cardLine", { last: when(c.lastMessageTs), messages: fmtNumber(c.inbound + c.outbound), bookings: fmtNumber(c.bookings) })}
                    </p>
                    <button type="button" onClick={() => setErasing(c)}
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                      aria-label={t("contacts.eraseWho", { who: c.name ?? `+${c.waId}` })}>
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      {contacts && contacts.length >= 2000 && <p className="mt-3 text-xs text-zinc-500">{t("contacts.capped")}</p>}
      {erasing && <EraseDialog bid={bid!} contact={erasing} onClose={() => setErasing(null)} onErased={() => { setErasing(null); setTick((n) => n + 1); }} />}
    </div>
  );
}

/**
 * Erasure is permanent, so it asks twice: the dialog, and a box to tick
 * saying so. The server also insists on an explicit confirmation.
 */
function EraseDialog({ bid, contact, onClose, onErased }: { bid: string; contact: Contact; onClose: () => void; onErased: () => void }) {
  const { t } = useI18n();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const who = contact.name ?? `+${contact.waId}`;
  const erase = async () => {
    setBusy(true);
    setError(false);
    try {
      const r = await api<{ calendarEventsLeft: number }>(`/api/b/${bid}/contacts/${contact.waId}/erase`, { method: "POST", body: { confirm: true } });
      if (r.calendarEventsLeft > 0) window.alert(t("contacts.eraseCalendarLeft", { n: r.calendarEventsLeft }));
      onErased();
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("contacts.eraseTitle", { who })}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={busy} disabled={!sure} onClick={() => void erase()}>{t("contacts.eraseConfirm")}</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <p>{t("contacts.eraseBody")}</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 size-4 accent-red-600" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>{t("contacts.eraseSure")}</span>
        </label>
        {error && <Alert>{t("common.error")}</Alert>}
      </div>
    </Modal>
  );
}
