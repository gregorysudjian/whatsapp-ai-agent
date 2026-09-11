import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { FileText } from "lucide-react";
import { api } from "../lib/api.ts";
import { useI18n } from "../i18n/index.tsx";
import { Alert, Badge, Card, PageHeader, Spinner } from "../components/ui.tsx";

/** One row per month: the PDF the owner can file, forward or print. */
export function Reports() {
  const { bid } = useParams();
  const { t, locale } = useI18n();
  const [data, setData] = useState<{ months: string[]; current: string; language: "en" | "fr" } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api<{ months: string[]; current: string; language: "en" | "fr" }>(`/api/b/${bid}/reports`)
      .then(setData)
      .catch(() => setError(true));
  }, [bid]);

  const monthName = (m: string) => {
    const s = new Intl.DateTimeFormat(locale === "fr" ? "fr-CA" : "en-CA", { month: "long", year: "numeric", timeZone: "UTC" })
      .format(Date.parse(`${m}-01T12:00:00Z`));
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title={t("nav.reports")} subtitle={t("reports.subtitle")} />
      {error ? <Alert>{t("common.error")}</Alert> : !data ? <Spinner label={t("common.loading")} /> : (
        <>
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
            {t("reports.language", { lang: data.language === "fr" ? "français" : "English" })}
          </p>
          <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {data.months.map((m) => (
              <div key={m} className="flex items-center gap-3 px-4 py-3">
                <FileText className="size-5 shrink-0 text-zinc-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{monthName(m)}</p>
                  {m === data.current && <Badge tone="blue" className="mt-0.5">{t("reports.inProgress")}</Badge>}
                </div>
                <a href={`/api/b/${bid}/reports/monthly?month=${m}`} download
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 dark:text-brand-300 dark:ring-zinc-700 dark:hover:bg-zinc-800"
                  aria-label={t("reports.downloadMonth", { month: monthName(m) })}>
                  {t("reports.download")}
                </a>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
