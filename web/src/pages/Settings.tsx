import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Select, Spinner, Switch, TextArea, cx } from "../components/ui.tsx";

// --- shapes (mirror src/store/settings.ts and services.ts) ------------------

type Tone = "friendly" | "professional" | "concise";
interface AgentSettings {
  about: string; address: string; contact: string; tone: Tone; customToneNotes: string;
  languages: string[]; faqs: { q: string; a: string }[];
  handoff: { keywords: string[]; onAnger: boolean; onAccountChange: boolean; rules: string };
  neverDo: string[];
  reminders: { enabled: boolean; hoursBefore: number; templateName: string; templateLanguage: string };
}
interface DayHours { open: string; close: string }
type Schedule = Partial<Record<string, DayHours>>;
interface Service { id: number; name: string; description: string; durationMin: number; priceCents: number | null; currency: string; active: boolean; sort: number }
interface Profile { name: string; timezone: string; defaultLanguage: "en" | "fr" }
interface SettingsResponse {
  business: Profile & { id: number };
  settings: AgentSettings; schedule: Schedule; services: Service[]; languageNames: Record<string, string>;
}
interface Draft { business: Profile; settings: AgentSettings; schedule: Schedule }

const TABS = ["business", "hours", "services", "faqs", "tone", "handoff", "reminders", "preview"] as const;
type Tab = (typeof TABS)[number];
/** Monday first, as the week is read; values are JS weekdays (0 = Sunday). */
const WEEK = ["1", "2", "3", "4", "5", "6", "0"];

function pickDraft(r: SettingsResponse): Draft {
  return {
    business: { name: r.business.name, timezone: r.business.timezone, defaultLanguage: r.business.defaultLanguage },
    settings: r.settings,
    schedule: r.schedule,
  };
}

export function Settings() {
  const { bid } = useParams();
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "business";

  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const r = await api<SettingsResponse>(`/api/b/${bid}/settings`);
    setData(r);
    setDraft(pickDraft(r));
  };
  useEffect(() => { void load().catch(() => setError(t("common.error"))); }, [bid]); // reload per business

  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(pickDraft(data)) !== JSON.stringify(draft), [data, draft]);

  // Closing or reloading the tab with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!data || !draft) return error ? <Alert>{error}</Alert> : <Spinner label={t("common.loading")} />;

  const setS = (patch: Partial<AgentSettings>) => { setSaved(false); setDraft({ ...draft, settings: { ...draft.settings, ...patch } }); };
  const setB = (patch: Partial<Profile>) => { setSaved(false); setDraft({ ...draft, business: { ...draft.business, ...patch } }); };
  const setSchedule = (schedule: Schedule) => { setSaved(false); setDraft({ ...draft, schedule }); };

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/b/${bid}/settings`, { method: "PUT", body: { business: draft.business, settings: draft.settings } });
      await api(`/api/b/${bid}/schedule`, { method: "PUT", body: draft.schedule });
      await load();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? String(err.body["message"] ?? t("common.error")) : t("common.error"));
    } finally {
      setSaving(false);
    }
  }

  const tabLabel: Record<Tab, Key> = {
    business: "settings.tab.business", hours: "settings.tab.hours", services: "settings.tab.services",
    faqs: "settings.tab.faqs", tone: "settings.tab.tone", handoff: "settings.tab.handoff",
    reminders: "settings.tab.reminders", preview: "settings.tab.preview",
  };

  return (
    <div className="pb-24">
      <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />

      {/* Tabs: a scrollable row on phones, a wrapped row on desktop */}
      <div role="tablist" aria-label={t("settings.title")}
        className="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 sm:mx-0 sm:flex-wrap sm:px-0 dark:border-zinc-800">
        {TABS.map((id) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id}
            onClick={() => setParams({ tab: id }, { replace: true })}
            className={cx(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              tab === id
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
            )}>
            {t(tabLabel[id])}
          </button>
        ))}
      </div>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}
      {saved && !dirty && <div className="mb-4"><Alert tone="green">{t("settings.savedOk")}</Alert></div>}

      <div className="max-w-3xl">
        {tab === "business" && <BusinessTab draft={draft} setB={setB} setS={setS} />}
        {tab === "hours" && <HoursTab schedule={draft.schedule} onChange={setSchedule} />}
        {tab === "services" && <ServicesTab bid={String(bid)} services={data.services} reload={load} />}
        {tab === "faqs" && <FaqsTab faqs={draft.settings.faqs} onChange={(faqs) => setS({ faqs })} />}
        {tab === "tone" && <ToneTab settings={draft.settings} setS={setS} languageNames={data.languageNames} />}
        {tab === "handoff" && <HandoffTab settings={draft.settings} setS={setS} />}
        {tab === "reminders" && <RemindersTab settings={draft.settings} setS={setS} />}
        {tab === "preview" && <PreviewTab bid={String(bid)} version={JSON.stringify(data)} />}
      </div>

      {/* Sticky save bar, only while there is something to save */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-auto lg:right-0 lg:w-[calc(100%-16rem)] dark:border-zinc-800 dark:bg-zinc-900/95">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("settings.unsaved")}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => { setDraft(pickDraft(data)); setError(null); }}>{t("settings.discard")}</Button>
              <Button onClick={() => void save()} loading={saving}>{t("settings.saveChanges")}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, intro, children }: { title?: string; intro?: string; children: ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      {title && <h2 className="text-base font-semibold">{title}</h2>}
      {intro && <p className="mb-5 mt-1 text-sm text-zinc-500 dark:text-zinc-400">{intro}</p>}
      <div className="space-y-5">{children}</div>
    </Card>
  );
}

// --- Business -----------------------------------------------------------------

function BusinessTab({ draft, setB, setS }: { draft: Draft; setB: (p: Partial<Profile>) => void; setS: (p: Partial<AgentSettings>) => void }) {
  const { t } = useI18n();
  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf("timeZone"); } catch { return [draft.business.timezone]; }
  }, [draft.business.timezone]);
  return (
    <Section>
      <Field label={t("settings.name")} value={draft.business.name} maxLength={120} onChange={(e) => setB({ name: e.target.value })} />
      <TextArea label={t("settings.about")} hint={t("settings.aboutHint")} value={draft.settings.about} maxLength={2000}
        onChange={(e) => setS({ about: e.target.value })} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Select label={t("settings.timezone")} hint={t("settings.timezoneHint")} value={draft.business.timezone}
          onChange={(e) => setB({ timezone: e.target.value })}>
          {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
        </Select>
        <Select label={t("settings.dashboardLanguage")} value={draft.business.defaultLanguage}
          onChange={(e) => setB({ defaultLanguage: e.target.value as "en" | "fr" })}>
          <option value="en">English</option>
          <option value="fr">Français</option>
        </Select>
      </div>
      <Field label={t("settings.address")} hint={t("settings.addressHint")} value={draft.settings.address} maxLength={300}
        onChange={(e) => setS({ address: e.target.value })} />
      <Field label={t("settings.contact")} hint={t("settings.contactHint")} value={draft.settings.contact} maxLength={200}
        onChange={(e) => setS({ contact: e.target.value })} />
    </Section>
  );
}

// --- Hours ----------------------------------------------------------------------

function HoursTab({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const { t } = useI18n();
  const set = (day: string, hours: DayHours | undefined) => {
    const next = { ...schedule };
    if (hours) next[day] = hours; else delete next[day];
    onChange(next);
  };
  const copyMonday = () => {
    const mon = schedule["1"];
    const next = { ...schedule };
    for (const d of ["2", "3", "4", "5"]) { if (mon) next[d] = { ...mon }; else delete next[d]; }
    onChange(next);
  };
  const invalid = WEEK.filter((d) => { const h = schedule[d]; return h && h.open >= h.close; });

  return (
    <Section intro={t("settings.hoursIntro")}>
      {invalid.map((d) => <Alert key={d}>{t("settings.hoursInvalid", { day: t(`settings.day.${d}` as Key) })}</Alert>)}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {WEEK.map((d) => {
          const h = schedule[d];
          return (
            <div key={d} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="w-32 shrink-0"><Switch checked={!!h} onChange={(on) => set(d, on ? { open: "09:00", close: "17:00" } : undefined)} label={t(`settings.day.${d}` as Key)} /></div>
              {h ? (
                <div className="flex items-center gap-2 text-sm">
                  <label className="sr-only" htmlFor={`o${d}`}>{t("settings.from")}</label>
                  <input id={`o${d}`} type="time" value={h.open} onChange={(e) => set(d, { ...h, open: e.target.value })}
                    className="h-10 rounded-lg border border-zinc-300 bg-white px-2 dark:border-zinc-700 dark:bg-zinc-900" />
                  <span className="text-zinc-400">–</span>
                  <label className="sr-only" htmlFor={`c${d}`}>{t("settings.to")}</label>
                  <input id={`c${d}`} type="time" value={h.close} onChange={(e) => set(d, { ...h, close: e.target.value })}
                    className="h-10 rounded-lg border border-zinc-300 bg-white px-2 dark:border-zinc-700 dark:bg-zinc-900" />
                </div>
              ) : (
                <span className="text-sm text-zinc-400">{t("settings.closed")}</span>
              )}
            </div>
          );
        })}
      </div>
      <Button variant="secondary" size="sm" icon={<Copy className="size-4" aria-hidden />} onClick={copyMonday}>{t("settings.copyMonday")}</Button>
    </Section>
  );
}

// --- Services (saved immediately, each on its own) ----------------------------

function ServicesTab({ bid, services, reload }: { bid: string; services: Service[]; reload: () => Promise<void> }) {
  const { t, fmtNumber } = useI18n();
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retire = async (s: Service) => {
    if (!confirm(t("settings.retireConfirm", { name: s.name }))) return;
    await api(`/api/b/${bid}/services/${s.id}`, { method: "DELETE" });
    await reload();
  };

  const price = (s: Service) => s.priceCents == null ? t("settings.noPrice")
    : `${s.currency} ${fmtNumber(s.priceCents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <Section intro={t("settings.servicesIntro")}>
      {error && <Alert>{error}</Alert>}
      {services.length === 0 && editing === null && <EmptyState title={t("settings.noServices")} />}
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {services.map((s) => editing !== "new" && editing?.id === s.id ? (
          <li key={s.id} className="py-3"><ServiceForm bid={bid} initial={s} onDone={async () => { setEditing(null); await reload(); }} onError={setError} /></li>
        ) : (
          <li key={s.id} className={cx("flex flex-wrap items-center justify-between gap-3 py-3", !s.active && "opacity-60")}>
            <div className="min-w-0">
              <p className="font-medium">{s.name} {!s.active && <Badge>{t("settings.retired")}</Badge>}</p>
              <p className="text-sm text-zinc-500">{t("settings.minutes", { n: s.durationMin })} · {price(s)}</p>
            </div>
            {s.active && (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>{t("common.edit")}</Button>
                <Button size="sm" variant="ghost" onClick={() => void retire(s)}>{t("settings.retire")}</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing === "new"
        ? <ServiceForm bid={bid} onDone={async () => { setEditing(null); await reload(); }} onError={setError} />
        : <Button variant="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setEditing("new")}>{t("settings.addService")}</Button>}
    </Section>
  );
}

function ServiceForm({ bid, initial, onDone, onError }: { bid: string; initial?: Service; onDone: () => Promise<void>; onError: (e: string | null) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [duration, setDuration] = useState(String(initial?.durationMin ?? 60));
  const [price, setPrice] = useState(initial?.priceCents == null ? "" : (initial.priceCents / 100).toFixed(2));
  const [currency, setCurrency] = useState(initial?.currency ?? "CAD");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    onError(null);
    const body = {
      name, description, durationMin: Number(duration), currency,
      priceCents: price.trim() === "" ? null : Math.round(Number(price.replace(",", ".")) * 100),
      sort: initial?.sort ?? 0,
    };
    try {
      await api(`/api/b/${bid}/services${initial ? `/${initial.id}` : ""}`, { method: initial ? "PUT" : "POST", body });
      await onDone();
    } catch (err) {
      onError(err instanceof ApiError ? String(err.body["message"] ?? t("common.error")) : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.serviceName")} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoFocus />
        <Field label={t("settings.duration")} type="number" min={5} max={1440} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} />
        <Field label={t("settings.price")} hint={t("settings.priceHint")} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        <Field label={t("settings.currency")} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
      </div>
      <TextArea label={t("settings.description")} rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      <div className="flex gap-2">
        <Button onClick={() => void submit()} loading={busy} disabled={!name.trim()}>{t("common.save")}</Button>
        <Button variant="ghost" onClick={() => void onDone()}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

// --- FAQs -----------------------------------------------------------------------

function FaqsTab({ faqs, onChange }: { faqs: { q: string; a: string }[]; onChange: (f: { q: string; a: string }[]) => void }) {
  const { t } = useI18n();
  const update = (i: number, patch: Partial<{ q: string; a: string }>) => onChange(faqs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const next = [...faqs];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    onChange(next);
  };
  return (
    <Section intro={t("settings.faqsIntro")}>
      {faqs.length === 0 && <p className="text-sm text-zinc-500">{t("settings.noFaqs")}</p>}
      {faqs.map((f, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <Field label={t("settings.question")} value={f.q} maxLength={300} onChange={(e) => update(i, { q: e.target.value })} />
          <TextArea label={t("settings.answer")} value={f.a} rows={2} maxLength={1500} onChange={(e) => update(i, { a: e.target.value })} />
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("settings.moveUp")} icon={<ArrowUp className="size-4" aria-hidden />} />
            <Button size="sm" variant="ghost" disabled={i === faqs.length - 1} onClick={() => move(i, 1)} aria-label={t("settings.moveDown")} icon={<ArrowDown className="size-4" aria-hidden />} />
            <Button size="sm" variant="ghost" onClick={() => onChange(faqs.filter((_, j) => j !== i))} icon={<Trash2 className="size-4" aria-hidden />}>{t("settings.remove")}</Button>
          </div>
        </div>
      ))}
      {faqs.length < 50 && (
        <Button variant="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => onChange([...faqs, { q: "", a: "" }])}>{t("settings.addFaq")}</Button>
      )}
    </Section>
  );
}

// --- Tone and languages ---------------------------------------------------------

function ToneTab({ settings, setS, languageNames }: { settings: AgentSettings; setS: (p: Partial<AgentSettings>) => void; languageNames: Record<string, string> }) {
  const { t, locale } = useI18n();
  // Language names in the reader's own language ("arabe" in French), from the
  // browser; the server's English names are the fallback.
  const display = useMemo(() => {
    try { return new Intl.DisplayNames([locale], { type: "language" }); } catch { return null; }
  }, [locale]);
  const nameOf = (code: string) => {
    const n = display?.of(code) ?? languageNames[code] ?? code;
    return n.charAt(0).toLocaleUpperCase(locale) + n.slice(1);
  };
  const tones: { id: Tone; label: Key; hint: Key }[] = [
    { id: "friendly", label: "settings.tone.friendly", hint: "settings.tone.friendlyHint" },
    { id: "professional", label: "settings.tone.professional", hint: "settings.tone.professionalHint" },
    { id: "concise", label: "settings.tone.concise", hint: "settings.tone.conciseHint" },
  ];
  const toggleLang = (code: string, on: boolean) => {
    const next = on ? [...settings.languages, code] : settings.languages.filter((c) => c !== code);
    if (next.length) setS({ languages: next });
  };
  return (
    <div className="space-y-6">
      <Section title={t("settings.tone")}>
        <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t("settings.tone")}>
          {tones.map((tone) => (
            <label key={tone.id} className={cx(
              "cursor-pointer rounded-lg border p-3 transition-colors",
              settings.tone === tone.id ? "border-brand-600 bg-brand-50 dark:bg-brand-900/20" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700",
            )}>
              <input type="radio" name="tone" className="sr-only" checked={settings.tone === tone.id} onChange={() => setS({ tone: tone.id })} />
              <span className="block text-sm font-semibold">{t(tone.label)}</span>
              <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">{t(tone.hint)}</span>
            </label>
          ))}
        </div>
        <TextArea label={t("settings.toneNotes")} value={settings.customToneNotes} maxLength={1000} onChange={(e) => setS({ customToneNotes: e.target.value })} />
      </Section>
      <Section title={t("settings.languages")} intro={t("settings.languagesHint")}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.keys(languageNames).sort((a, b) => nameOf(a).localeCompare(nameOf(b), locale)).map((code) => {
            const name = nameOf(code);
            const on = settings.languages.includes(code);
            return (
              <label key={code} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={on} onChange={(e) => toggleLang(code, e.target.checked)}
                  disabled={on && settings.languages.length === 1} className="size-4 rounded accent-brand-600" />
                <span>{name}</span>
                {settings.languages[0] === code && <Badge tone="green">{t("settings.mainLanguage")}</Badge>}
              </label>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// --- Handoff --------------------------------------------------------------------

function HandoffTab({ settings, setS }: { settings: AgentSettings; setS: (p: Partial<AgentSettings>) => void }) {
  const { t } = useI18n();
  const h = settings.handoff;
  const [keywords, setKeywords] = useState(h.keywords.join(", "));
  return (
    <Section intro={t("settings.handoffIntro")}>
      <Switch checked={h.onAnger} onChange={(v) => setS({ handoff: { ...h, onAnger: v } })} label={t("settings.onAnger")} />
      <Switch checked={h.onAccountChange} onChange={(v) => setS({ handoff: { ...h, onAccountChange: v } })} label={t("settings.onAccountChange")} />
      <Field label={t("settings.keywords")} hint={t("settings.keywordsHint")} value={keywords}
        onChange={(e) => {
          setKeywords(e.target.value);
          setS({ handoff: { ...h, keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 30) } });
        }} />
      <TextArea label={t("settings.rules")} value={h.rules} maxLength={1000} onChange={(e) => setS({ handoff: { ...h, rules: e.target.value } })} />
      <TextArea label={t("settings.neverDo")} hint={t("settings.neverDoHint")} rows={4} value={settings.neverDo.join("\n")}
        onChange={(e) => setS({ neverDo: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20) })} />
    </Section>
  );
}

// --- Reminders --------------------------------------------------------------------

/**
 * What the customer receives, per template language - word for word the
 * bodies in docs/whatsapp-templates.md, which is what the owner submits to
 * Meta. {{1}} name, {{2}} date, {{3}} time.
 */
const REMINDER_SAMPLES: Record<string, { body: string; confirm: string; cancel: string; dir?: "rtl" }> = {
  en: { body: "Hi {{1}}, this is a reminder of your appointment on {{2}} at {{3}}. Can you still make it?", confirm: "Confirm", cancel: "Cancel" },
  fr: { body: "Bonjour {{1}}, petit rappel de votre rendez-vous le {{2}} à {{3}}. Serez-vous présent ?", confirm: "Confirmer", cancel: "Annuler" },
  ar: { body: "مرحبًا {{1}}، نذكّرك بموعدك يوم {{2}} الساعة {{3}}. هل ما زلت قادرًا على الحضور؟", confirm: "تأكيد", cancel: "إلغاء", dir: "rtl" },
};
const TEMPLATE_LANGUAGES = ["en", "en_US", "fr", "fr_CA", "ar"];
const HOURS_OPTIONS = [2, 4, 12, 24, 48, 72];

function RemindersTab({ settings, setS }: { settings: AgentSettings; setS: (p: Partial<AgentSettings>) => void }) {
  const { t, locale } = useI18n();
  const r = settings.reminders;
  const names = useMemo(() => {
    try { return new Intl.DisplayNames([locale], { type: "language" }); } catch { return null; }
  }, [locale]);
  const langName = (code: string) => {
    const n = names?.of(code.replace("_", "-")) ?? code;
    return `${n.charAt(0).toLocaleUpperCase(locale)}${n.slice(1)} (${code})`;
  };
  const set = (patch: Partial<AgentSettings["reminders"]>) => setS({ reminders: { ...r, ...patch } });
  const sample = REMINDER_SAMPLES[r.templateLanguage.slice(0, 2)] ?? REMINDER_SAMPLES["en"]!;
  const filled = sample.body.replace("{{1}}", "Sam").replace("{{2}}", "…").replace("{{3}}", "10:00");
  return (
    <Section intro={t("settings.remindersIntro")}>
      <Switch checked={r.enabled} onChange={(enabled) => set({ enabled })} label={t("settings.remindersOn")} hint={t("settings.remindersOnHint")} />
      {r.enabled && <Alert tone="amber">{t("settings.remindersApproval")}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Select label={t("settings.hoursBefore")} value={r.hoursBefore} onChange={(e) => set({ hoursBefore: Number(e.target.value) })}>
          {[...new Set([...HOURS_OPTIONS, r.hoursBefore])].sort((a, b) => a - b).map((h) => (
            <option key={h} value={h}>{t("settings.hoursOption", { n: h })}</option>
          ))}
        </Select>
        <Select label={t("settings.templateLanguage")} hint={t("settings.templateLanguageHint")} value={r.templateLanguage}
          onChange={(e) => set({ templateLanguage: e.target.value })}>
          {[...new Set([...TEMPLATE_LANGUAGES, r.templateLanguage])].map((code) => <option key={code} value={code}>{langName(code)}</option>)}
        </Select>
      </div>
      <Field label={t("settings.templateName")} hint={t("settings.templateNameHint")} value={r.templateName} maxLength={100}
        pattern="[a-z0-9_]+" onChange={(e) => set({ templateName: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} />
      <div>
        <p className="mb-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("settings.reminderPreview")}</p>
        <div className="max-w-sm rounded-2xl rounded-bl-md bg-white p-3 text-sm shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700" dir={sample.dir ?? "ltr"}>
          <p className="whitespace-pre-wrap">{filled}</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-zinc-100 pt-2 text-center text-sm font-medium text-sky-600 dark:border-zinc-700 dark:text-sky-400">
            <span>{sample.confirm}</span><span>{sample.cancel}</span>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">{t("settings.reminderPreviewHint")}</p>
      </div>
    </Section>
  );
}

// --- Preview --------------------------------------------------------------------

function PreviewTab({ bid, version }: { bid: string; version: string }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ prompt: string; context: string } | null>(null);
  useEffect(() => { void api<{ prompt: string; context: string }>(`/api/b/${bid}/settings/preview`).then(setPreview); }, [bid, version]);
  return (
    <Section intro={t("settings.previewIntro")}>
      {!preview ? <Spinner label={t("common.loading")} /> : (
        <pre dir="auto" className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-4 font-mono text-xs leading-relaxed text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
          {preview.prompt}{"\n\n"}{preview.context}
        </pre>
      )}
    </Section>
  );
}
