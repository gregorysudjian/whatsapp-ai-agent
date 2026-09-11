import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { MessageCircle } from "lucide-react";
import { useAuth } from "../lib/auth.tsx";
import { useI18n } from "../i18n/index.tsx";
import { ApiError } from "../lib/api.ts";
import { Alert, Button, Field } from "../components/ui.tsx";
import { LanguageToggle, ThemeToggle } from "../layout/controls.tsx";

export function Login() {
  const { me, login } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 0 ? t("common.offline")
        : err instanceof ApiError && err.status === 401 ? t("auth.invalid")
        : t("common.error"));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end gap-2 p-4">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-brand-600 text-white shadow-sm">
              <MessageCircle className="size-6" aria-hidden />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("auth.title")}</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t("auth.subtitle")}</p>
          </div>
          <form onSubmit={submit} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900" noValidate>
            {error && <Alert>{error}</Alert>}
            <Field label={t("auth.email")} type="email" autoComplete="username" inputMode="email" required
              value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <Field label={t("auth.password")} type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="submit" className="w-full" loading={busy} disabled={!email || !password}>
              {busy ? t("auth.submitting") : t("auth.submit")}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-zinc-400">{t("app.name")} · {t("app.tagline")}</p>
        </div>
      </main>
    </div>
  );
}
