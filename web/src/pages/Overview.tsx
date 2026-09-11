import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { AlertCircle, Inbox, MessageSquare, Send, UserRound, Users } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Alert, Badge, Button, Card, PageHeader, Spinner } from "../components/ui.tsx";

interface Summary {
  business: { id: number; name: string; status: string; timezone: string; connected: boolean };
  stats: {
    inbound: number; outbound: number; contacts: number; openWindows: number;
    needsHuman: number; agentEnabled: boolean;
  };
}

/**
 * The first real screen behind login. D9 replaces the tiles with the full
 * overview (date filter, charts, response time); until then this proves the
 * whole path - session, scope, API - end to end.
 */
export function Overview() {
  const { bid } = useParams();
  const { t, fmtNumber } = useI18n();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api<Summary>(`/api/b/${bid}/summary`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError && err.status === 0 ? t("common.offline") : t("common.error")));
  };
  // Reload when the business changes; `load` itself is recreated each render.
  useEffect(load, [bid]);

  if (error) return <div className="space-y-3"><Alert>{error}</Alert><Button variant="secondary" onClick={load}>{t("common.retry")}</Button></div>;
  if (!data) return <Spinner label={t("common.loading")} />;

  const tiles: { key: Key; value: number; icon: typeof Inbox; alert?: boolean }[] = [
    { key: "overview.inbound", value: data.stats.inbound, icon: MessageSquare },
    { key: "overview.outbound", value: data.stats.outbound, icon: Send },
    { key: "overview.contacts", value: data.stats.contacts, icon: Users },
    { key: "overview.openWindows", value: data.stats.openWindows, icon: Inbox },
    { key: "overview.needsHuman", value: data.stats.needsHuman, icon: UserRound, alert: data.stats.needsHuman > 0 },
  ];

  return (
    <div>
      <PageHeader
        title={t("overview.title")}
        subtitle={t("overview.subtitle")}
        actions={data.stats.agentEnabled
          ? <Badge tone="green">● {t("overview.agentOn")}</Badge>
          : <Badge tone="amber">● {t("overview.agentOff")}</Badge>}
      />
      {!data.business.connected && (
        <div className="mb-6"><Alert tone="amber"><span className="inline-flex items-center gap-2"><AlertCircle className="size-4" aria-hidden />{t("shell.notConnected")}</span></Alert></div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {tiles.map(({ key, value, icon: Icon, alert }) => (
          <Card key={key} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-xs font-medium leading-snug text-zinc-500 dark:text-zinc-400">{t(key)}</p>
              <Icon className={alert ? "size-4 shrink-0 text-amber-500" : "size-4 shrink-0 text-zinc-400"} aria-hidden />
            </div>
            <p className={alert ? "mt-2 text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400" : "mt-2 text-2xl font-semibold tabular-nums"}>
              {fmtNumber(value)}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
