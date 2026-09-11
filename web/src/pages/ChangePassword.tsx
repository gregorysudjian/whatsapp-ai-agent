import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { KeyRound } from "lucide-react";
import { useAuth } from "../lib/auth.tsx";
import { useI18n, type Key } from "../i18n/index.tsx";
import { api, ApiError, type Me } from "../lib/api.ts";
import { Alert, Button, Card, Field } from "../components/ui.tsx";
import { LanguageToggle, ThemeToggle } from "../layout/controls.tsx";

/** Maps the server's policy codes ("Password rejected: too_short.") to words. */
function policyMessage(err: ApiError, t: (k: Key) => string): string {
  if (err.code === "wrong_current_password") return t("auth.wrongCurrent");
  const code = /rejected: (\w+)/.exec(String(err.body["message"] ?? ""))?.[1];
  const key = `pw.${code}` as Key;
  return code ? t(key) : t("common.error");
}

/**
 * Two uses: forced (first sign-in or after a reset - a full page, nothing
 * else reachable) and voluntary (from the account menu, inside the app).
 */
export function ChangePassword({ forced }: { forced: boolean }) {
  const { me, setMe, logout } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError(t("auth.mismatch"));
      return;
    }
    setBusy(true);
    try {
      const updated = await api<Me>("/api/auth/password", {
        method: "POST", body: { currentPassword: current, newPassword: next },
      });
      setMe(updated);
      setDone(true);
      setCurrent(""); setNext(""); setConfirm("");
      if (forced) navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? policyMessage(err, t) : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      {done && !forced && <Alert tone="green">{t("auth.saved")}</Alert>}
      <Field label={t("auth.currentPassword")} type="password" autoComplete="current-password"
        value={current} onChange={(e) => setCurrent(e.target.value)} required />
      <Field label={t("auth.newPassword")} type="password" autoComplete="new-password" hint={t("auth.passwordRules")}
        value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
      <Field label={t("auth.confirmPassword")} type="password" autoComplete="new-password"
        value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      <Button type="submit" loading={busy} disabled={!current || !next || !confirm} className="w-full sm:w-auto">
        {t("auth.savePassword")}
      </Button>
    </form>
  );

  if (!forced) {
    return (
      <div className="max-w-md">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">{t("auth.changePassword")}</h1>
        <Card className="p-6">{form}</Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end gap-2 p-4"><LanguageToggle /><ThemeToggle /></div>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-amber-500 text-white shadow-sm">
              <KeyRound className="size-6" aria-hidden />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">{t("auth.mustChangeTitle")}</h1>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t("auth.mustChangeBody")}</p>
            {me && <p className="mt-2 text-xs text-zinc-400">{t("shell.signedInAs", { email: me.user.email })}</p>}
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">{form}</div>
          <button type="button" onClick={() => void logout()} className="mx-auto mt-4 block text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            {t("auth.logout")}
          </button>
        </div>
      </main>
    </div>
  );
}
