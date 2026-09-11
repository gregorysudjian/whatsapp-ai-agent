import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Building2, Check, Copy, Download, KeyRound, Plus, ScrollText } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, cx, EmptyState, Field, Modal, PageHeader, Select, Spinner, Switch } from "../components/ui.tsx";

// --- shapes (mirror src/api/admin.ts) ----------------------------------------------

interface Usage {
  businessId: number; name: string; status: "active" | "inactive";
  inbound: number; aiReplies: number; humanReplies: number; templateSends: number;
  inputTokens: number; outputTokens: number; cachedTokens: number; estimatedCostUsd: number;
}
interface Owner { id: number; email: string; name: string | null; active: boolean; mustChangePassword: boolean; lastLoginAt: number | null }
interface Client {
  id: number; name: string; status: "active" | "inactive"; timezone: string; defaultLanguage: "en" | "fr";
  hasCredentials: boolean; waPhoneNumberId: string | null; webhookPath: string; createdAt: number;
  credentials: Record<string, string | null> | null;
  owners: Owner[];
  usage: Usage | null;
}

const usd = (n: number, locale: string) =>
  new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);

function errorText(t: (k: Key) => string, err: unknown): string {
  if (err instanceof ApiError && err.status === 0) return t("common.offline");
  // Store validation messages are written for people ("That phone number ID is already connected...").
  if (err instanceof ApiError && err.status === 400) return String(err.body["message"] ?? t("admin.checkFields"));
  return t("common.error");
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="secondary" icon={done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? t("admin.copied") : t("admin.copy")}
    </Button>
  );
}

/** A secret shown exactly once - the server keeps only its hash. */
function OneTimePassword({ email, password }: { email: string; password: string }) {
  const { t } = useI18n();
  return (
    <Alert tone="amber">
      <p className="font-medium">{t("admin.tempPasswordFor", { email })}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded bg-white px-2 py-1 font-mono text-sm text-zinc-900 ring-1 ring-amber-200 dark:bg-zinc-900 dark:text-zinc-50 dark:ring-amber-900">{password}</code>
        <CopyButton text={password} />
      </div>
      <p className="mt-2 text-xs">{t("admin.tempPasswordOnce")}</p>
    </Alert>
  );
}

// --- clients -------------------------------------------------------------------------

export function AdminClients() {
  const { t, locale, fmtNumber } = useI18n();
  const { refresh: refreshMe } = useAuth();
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState(false);
  // ?open=<id> links straight to one client's panel.
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState<number | null>(() => Number(params.get("open")) || null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api<{ businesses: Client[] }>("/api/admin/businesses")
      .then((r) => { setClients(r.businesses); setError(false); })
      .catch(() => setError(true));
  }, []);
  useEffect(load, [load]);

  const changed = () => { load(); void refreshMe(); };
  const open = clients?.find((c) => c.id === openId) ?? null;

  return (
    <div>
      <PageHeader title={t("nav.clients")} subtitle={t("admin.clientsSubtitle")}
        actions={<Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>{t("admin.newClient")}</Button>} />
      {error && !clients ? <Alert>{t("common.error")}</Alert> : !clients ? <Spinner label={t("common.loading")} /> : clients.length === 0 ? (
        <Card><EmptyState icon={<Building2 className="size-10" />} title={t("admin.noClients")} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.client")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.whatsapp")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.owners")}</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">{t("admin.col.messagesMonth")}</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">{t("admin.col.costMonth")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {clients.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40" onClick={() => setOpenId(c.id)}>
                    <td className="px-4 py-3">
                      <button type="button" className="font-medium text-zinc-900 hover:underline dark:text-zinc-50" onClick={(e) => { e.stopPropagation(); setOpenId(c.id); }}>{c.name}</button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                        {c.status === "inactive" && <Badge tone="amber">{t("shell.inactive")}</Badge>}
                        <span>{c.timezone}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {c.hasCredentials
                        ? <Badge tone="green">{t("admin.connected")}</Badge>
                        : <Badge tone="red">{t("shell.notConnected")}</Badge>}
                      {c.waPhoneNumberId && <div className="mt-0.5 font-mono text-xs text-zinc-500">{c.waPhoneNumberId}</div>}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                      {c.owners.length ? c.owners.map((o) => <div key={o.id} className={cx("truncate", !o.active && "line-through opacity-60")}>{o.email}</div>) : <span className="text-zinc-400">{t("admin.noOwner")}</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtNumber(c.usage?.inbound ?? 0)} / {fmtNumber(c.usage?.aiReplies ?? 0)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{usd(c.usage?.estimatedCostUsd ?? 0, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">{t("admin.monthKey")}</p>
        </Card>
      )}
      {open && <ClientDrawer key={open.id} client={open} onClose={() => setOpenId(null)} onChanged={changed} />}
      {creating && <NewClient onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); changed(); setOpenId(id); }} />}
    </div>
  );
}

function timezones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); } catch { return []; }
}

function NewClient({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ name: "", timezone: "America/Toronto", defaultLanguage: "fr" as "en" | "fr" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(timezones, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ business: Client }>("/api/admin/businesses", { method: "POST", body: form });
      onCreated(r.business.id);
    } catch (err) {
      setError(errorText(t, err));
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={t("admin.newClient")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" form="new-client" loading={saving} disabled={form.name.trim().length < 2}>{t("admin.create")}</Button></>}>
      <form id="new-client" onSubmit={submit} className="space-y-4">
        <Field label={t("settings.name")} value={form.name} maxLength={120} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Field label={t("settings.timezone")} value={form.timezone} list="tz-list" onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
        <Select label={t("settings.dashboardLanguage")} value={form.defaultLanguage} onChange={(e) => setForm({ ...form, defaultLanguage: e.target.value as "en" | "fr" })}>
          <option value="fr">Français</option><option value="en">English</option>
        </Select>
        <p className="text-xs text-zinc-500">{t("admin.newClientHint")}</p>
        {error && <Alert>{error}</Alert>}
      </form>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-zinc-200 pt-4 first:border-t-0 first:pt-0 dark:border-zinc-800">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ClientDrawer({ client: c, onClose, onChanged }: { client: Client; onClose: () => void; onChanged: () => void }) {
  const { t, fmtDate } = useI18n();
  const zones = useMemo(timezones, []);
  const [profile, setProfile] = useState({ name: c.name, timezone: c.timezone, defaultLanguage: c.defaultLanguage, active: c.status === "active" });
  const [creds, setCreds] = useState({ phoneNumberId: c.waPhoneNumberId ?? "", businessAccountId: "", accessToken: "", appSecret: "", verifyToken: "", graphVersion: "" });
  const [showCreds, setShowCreds] = useState(!c.hasCredentials);
  const [owner, setOwner] = useState({ email: "", name: "" });
  const [oneTime, setOneTime] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "red" | "green"; text: string } | null>(null);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ tone: "green", text: ok });
      onChanged();
    } catch (err) {
      setMessage({ tone: "red", text: errorText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  const webhookUrl = `${window.location.origin}${c.webhookPath}`;

  return (
    <Modal open side onClose={onClose} title={c.name}>
      <div className="space-y-5">
        <Link to={`/b/${c.id}/overview`} className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">{t("admin.openDashboard")}</Link>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {oneTime && <OneTimePassword email={oneTime.email} password={oneTime.password} />}

        <Section title={t("admin.details")}>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            void run("profile", async () => {
              await api(`/api/admin/businesses/${c.id}`, { method: "PATCH", body: {
                name: profile.name, timezone: profile.timezone, defaultLanguage: profile.defaultLanguage, status: profile.active ? "active" : "inactive",
              } });
            }, t("common.saved"));
          }}>
            <Field label={t("settings.name")} value={profile.name} maxLength={120} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            <Field label={t("settings.timezone")} value={profile.timezone} list="tz-list-edit" onChange={(e) => setProfile({ ...profile, timezone: e.target.value })} />
            <datalist id="tz-list-edit">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            <Select label={t("settings.dashboardLanguage")} value={profile.defaultLanguage} onChange={(e) => setProfile({ ...profile, defaultLanguage: e.target.value as "en" | "fr" })}>
              <option value="fr">Français</option><option value="en">English</option>
            </Select>
            <Switch checked={profile.active} onChange={(active) => setProfile({ ...profile, active })} label={t("admin.active")} hint={t("admin.activeHint")} />
            <Button type="submit" size="sm" loading={busy === "profile"}>{t("common.save")}</Button>
          </form>
        </Section>

        <Section title={t("admin.whatsapp")}>
          {c.hasCredentials && c.credentials ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-zinc-500">{t("admin.phoneNumberId")}</dt><dd className="font-mono">{c.credentials["phoneNumberId"]}</dd>
              <dt className="text-zinc-500">{t("admin.accessToken")}</dt><dd className="font-mono">{c.credentials["accessToken"]}</dd>
              <dt className="text-zinc-500">{t("admin.appSecret")}</dt><dd className="font-mono">{c.credentials["appSecret"]}</dd>
              <dt className="text-zinc-500">Graph</dt><dd className="font-mono">{c.credentials["graphVersion"]}</dd>
            </dl>
          ) : <Alert tone="amber">{t("admin.notConnectedYet")}</Alert>}
          <div>
            <p className="mb-1 text-sm font-medium">{t("admin.webhookUrl")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">{webhookUrl}</code>
              <CopyButton text={webhookUrl} />
            </div>
            <p className="mt-1 text-xs text-zinc-500">{t("admin.webhookHint")}</p>
          </div>
          {!showCreds ? (
            <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" aria-hidden />} onClick={() => setShowCreds(true)}>{t("admin.replaceCredentials")}</Button>
          ) : (
            <form className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" autoComplete="off" onSubmit={(e) => {
              e.preventDefault();
              void run("creds", async () => {
                await api(`/api/admin/businesses/${c.id}/credentials`, { method: "PUT", body: {
                  phoneNumberId: creds.phoneNumberId, accessToken: creds.accessToken, appSecret: creds.appSecret, verifyToken: creds.verifyToken,
                  ...(creds.businessAccountId ? { businessAccountId: creds.businessAccountId } : {}),
                  ...(creds.graphVersion ? { graphVersion: creds.graphVersion } : {}),
                } });
                // Out of the page's memory as soon as they are stored.
                setCreds({ phoneNumberId: creds.phoneNumberId, businessAccountId: "", accessToken: "", appSecret: "", verifyToken: "", graphVersion: "" });
                setShowCreds(false);
              }, t("admin.credentialsSaved"));
            }}>
              <p className="text-xs text-zinc-500">{t("admin.credentialsHint")}</p>
              <Field label={t("admin.phoneNumberId")} value={creds.phoneNumberId} inputMode="numeric" required onChange={(e) => setCreds({ ...creds, phoneNumberId: e.target.value })} />
              <Field label={t("admin.businessAccountId")} value={creds.businessAccountId} inputMode="numeric" onChange={(e) => setCreds({ ...creds, businessAccountId: e.target.value })} />
              <Field label={t("admin.accessToken")} type="password" autoComplete="new-password" value={creds.accessToken} required onChange={(e) => setCreds({ ...creds, accessToken: e.target.value })} />
              <Field label={t("admin.appSecret")} type="password" autoComplete="new-password" value={creds.appSecret} required onChange={(e) => setCreds({ ...creds, appSecret: e.target.value })} />
              <Field label={t("admin.verifyToken")} hint={t("admin.verifyTokenHint")} type="password" autoComplete="new-password" value={creds.verifyToken} required onChange={(e) => setCreds({ ...creds, verifyToken: e.target.value })} />
              <Field label={t("admin.graphVersion")} placeholder="v23.0" value={creds.graphVersion} onChange={(e) => setCreds({ ...creds, graphVersion: e.target.value })} />
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={busy === "creds"}>{t("admin.saveCredentials")}</Button>
                {c.hasCredentials && <Button size="sm" variant="secondary" onClick={() => setShowCreds(false)}>{t("common.cancel")}</Button>}
              </div>
            </form>
          )}
        </Section>

        <Section title={t("admin.owners")}>
          {c.owners.length === 0 && <p className="text-sm text-zinc-500">{t("admin.noOwner")}</p>}
          <ul className="space-y-2">
            {c.owners.map((o) => (
              <li key={o.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx("font-medium", !o.active && "line-through opacity-60")}>{o.email}</span>
                  {!o.active && <Badge tone="amber">{t("shell.inactive")}</Badge>}
                  {o.mustChangePassword && o.active && <Badge tone="blue">{t("admin.mustChange")}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">{o.lastLoginAt ? t("admin.lastLogin", { when: fmtDate(o.lastLoginAt) }) : t("admin.neverLoggedIn")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === `reset-${o.id}`} onClick={() => {
                    if (!window.confirm(t("admin.resetConfirm", { email: o.email }))) return;
                    void run(`reset-${o.id}`, async () => {
                      const r = await api<{ temporaryPassword: string }>(`/api/admin/users/${o.id}/reset-password`, { method: "POST", body: {} });
                      setOneTime({ email: o.email, password: r.temporaryPassword });
                    });
                  }}>{t("admin.resetPassword")}</Button>
                  <Button size="sm" variant="ghost" loading={busy === `active-${o.id}`} onClick={() => {
                    void run(`active-${o.id}`, async () => { await api(`/api/admin/users/${o.id}`, { method: "PATCH", body: { active: !o.active } }); });
                  }}>{o.active ? t("admin.deactivate") : t("admin.activate")}</Button>
                </div>
              </li>
            ))}
          </ul>
          <form className="space-y-3 rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700" onSubmit={(e) => {
            e.preventDefault();
            void run("owner", async () => {
              const r = await api<{ temporaryPassword: string; user: { email: string } }>(`/api/admin/businesses/${c.id}/owners`, {
                method: "POST", body: { email: owner.email, ...(owner.name ? { name: owner.name } : {}) },
              });
              setOneTime({ email: r.user.email, password: r.temporaryPassword });
              setOwner({ email: "", name: "" });
            });
          }}>
            <p className="text-sm font-medium">{t("admin.addOwner")}</p>
            <Field label={t("auth.email")} type="email" value={owner.email} required autoComplete="off" onChange={(e) => setOwner({ ...owner, email: e.target.value })} />
            <Field label={t("admin.ownerName")} value={owner.name} maxLength={120} onChange={(e) => setOwner({ ...owner, name: e.target.value })} />
            <Button type="submit" size="sm" loading={busy === "owner"} disabled={!owner.email}>{t("admin.createOwner")}</Button>
          </form>
        </Section>
      </div>
    </Modal>
  );
}

// --- usage and billing --------------------------------------------------------------------

export function AdminUsage() {
  const { t, locale, fmtNumber } = useI18n();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<{ rows: Usage[]; totals: Omit<Usage, "businessId" | "name" | "status"> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    api<{ rows: Usage[]; totals: Omit<Usage, "businessId" | "name" | "status"> }>(`/api/admin/usage?month=${month}`, { signal: ctrl.signal })
      .then((r) => { setData(r); setError(false); })
      .catch((err: unknown) => { if ((err as Error).name !== "AbortError") setError(true); })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [month]);

  const n = (v: number) => fmtNumber(v);
  const tokens = (v: number) => fmtNumber(v, { notation: "compact", maximumFractionDigits: 1 });
  const cols: { k: keyof Usage; label: Key; fmt: (v: number) => string }[] = [
    { k: "inbound", label: "overview.tile.inbound", fmt: n },
    { k: "aiReplies", label: "admin.col.aiReplies", fmt: n },
    { k: "humanReplies", label: "admin.col.humanReplies", fmt: n },
    { k: "templateSends", label: "admin.col.templates", fmt: n },
    { k: "inputTokens", label: "admin.col.inputTokens", fmt: tokens },
    { k: "outputTokens", label: "admin.col.outputTokens", fmt: tokens },
    { k: "cachedTokens", label: "admin.col.cachedTokens", fmt: tokens },
    { k: "estimatedCostUsd", label: "admin.col.cost", fmt: (v) => usd(v, locale) },
  ];

  return (
    <div>
      <PageHeader title={t("nav.usage")} subtitle={t("admin.usageSubtitle")}
        actions={
          <a href={`/api/admin/usage.csv?month=${month}`} download
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-800 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800">
            <Download className="size-4" aria-hidden />{t("contacts.export")}
          </a>
        } />
      <div className="mb-4 flex items-end gap-3">
        <Field className="w-44" label={t("admin.month")} type="month" value={month} max={new Date().toISOString().slice(0, 7)}
          onChange={(e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value); }} />
      </div>
      {error && !data ? <Alert>{t("common.error")}</Alert> : !data ? <Spinner label={t("common.loading")} /> : (
        <Card className={cx("overflow-hidden transition-opacity", loading && "opacity-60")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.client")}</th>
                  {cols.map((c) => <th key={c.k} scope="col" className="px-4 py-2.5 text-right font-medium">{t(c.label)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 tabular-nums dark:divide-zinc-800">
                {data.rows.map((r) => (
                  <tr key={r.businessId}>
                    <th scope="row" className="px-4 py-2.5 text-left font-medium">
                      {r.name}{r.status === "inactive" && <Badge tone="amber" className="ml-2">{t("shell.inactive")}</Badge>}
                    </th>
                    {cols.map((c) => <td key={c.k} className="px-4 py-2.5 text-right">{c.fmt(Number(r[c.k]))}</td>)}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-zinc-200 font-semibold tabular-nums dark:border-zinc-700">
                <tr>
                  <th scope="row" className="px-4 py-2.5 text-left">{t("admin.total")}</th>
                  {cols.map((c) => <td key={c.k} className="px-4 py-2.5 text-right">{c.fmt(Number((data.totals as Record<string, number>)[c.k] ?? 0))}</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">{t("admin.costNote")}</p>
        </Card>
      )}
    </div>
  );
}

// --- audit log -------------------------------------------------------------------------------

interface AuditEntry { id: number; ts: number; userEmail: string | null; businessId: number | null; action: string; target: string | null; detail: string | null }

export function AdminAudit() {
  const { t, fmtDate } = useI18n();
  const [businessId, setBusinessId] = useState("");
  const [action, setAction] = useState("");
  const [data, setData] = useState<{ entries: AuditEntry[]; actions: string[]; businesses: { id: number; name: string }[]; next: number | null } | null>(null);
  const [more, setMore] = useState<AuditEntry[]>([]);
  const [error, setError] = useState(false);

  const params = (before?: number) => new URLSearchParams({
    ...(businessId ? { businessId } : {}), ...(action ? { action } : {}), ...(before ? { before: String(before) } : {}),
  }).toString();

  useEffect(() => {
    setMore([]);
    api<NonNullable<typeof data>>(`/api/admin/audit?${params()}`)
      .then((r) => { setData(r); setError(false); })
      .catch(() => setError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, action]);

  const [next, setNext] = useState<number | null>(null);
  useEffect(() => { setNext(data?.next ?? null); }, [data]);
  const loadMore = async () => {
    if (!next) return;
    const r = await api<NonNullable<typeof data>>(`/api/admin/audit?${params(next)}`);
    setMore((m) => [...m, ...r.entries]);
    setNext(r.next);
  };

  const names = new Map(data?.businesses.map((b) => [b.id, b.name]));
  const rows = [...(data?.entries ?? []), ...more];

  return (
    <div>
      <PageHeader title={t("nav.audit")} subtitle={t("admin.auditSubtitle")} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select className="w-56" label={t("admin.col.client")} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
          <option value="">{t("admin.allClients")}</option>
          {data?.businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <Select className="w-56" label={t("admin.action")} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">{t("admin.allActions")}</option>
          {data?.actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
      </div>
      {error && !data ? <Alert>{t("common.error")}</Alert> : !data ? <Spinner label={t("common.loading")} /> : rows.length === 0 ? (
        <Card><EmptyState icon={<ScrollText className="size-10" />} title={t("admin.noAudit")} /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-400">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.when")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.who")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.client")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.action")}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t("admin.col.detail")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-zinc-600 dark:text-zinc-300">{fmtDate(e.ts)}</td>
                    <td className="px-4 py-2">{e.userEmail ?? "—"}</td>
                    <td className="px-4 py-2">{e.businessId ? names.get(e.businessId) ?? `#${e.businessId}` : "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs">{e.action}</td>
                    <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-zinc-500" title={e.detail ?? ""}>{[e.target, e.detail].filter(Boolean).join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {next && <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800"><Button size="sm" variant="secondary" onClick={() => void loadMore()}>{t("admin.loadMore")}</Button></div>}
        </Card>
      )}
    </div>
  );
}
