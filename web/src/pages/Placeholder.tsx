import { Construction, SearchX } from "lucide-react";
import { Link } from "react-router";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Button, Card, EmptyState, PageHeader } from "../components/ui.tsx";
import { useAuth, defaultBusinessId } from "../lib/auth.tsx";

/** Stands in for a section not built yet, so navigation is complete from day one. */
export function Placeholder({ title }: { title: Key }) {
  const { t } = useI18n();
  return (
    <div>
      <PageHeader title={t(title)} />
      <Card>
        <EmptyState icon={<Construction className="size-10" aria-hidden />} title={t("common.comingSoon")} body={t("common.comingSoonBody")} />
      </Card>
    </div>
  );
}

export function NotFound() {
  const { t } = useI18n();
  const { me } = useAuth();
  const home = me ? `/b/${defaultBusinessId(me) ?? ""}/overview` : "/login";
  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <EmptyState
        icon={<SearchX className="size-10" aria-hidden />}
        title={t("common.notFoundTitle")}
        body={t("common.notFoundBody")}
        action={<Link to={home}><Button variant="secondary">{t("common.goHome")}</Button></Link>}
      />
    </Card>
  );
}
