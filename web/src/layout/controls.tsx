import { Monitor, Moon, Sun } from "lucide-react";
import { useI18n, type Locale } from "../i18n/index.tsx";
import { useTheme, type ThemePref } from "../lib/theme.tsx";
import { api, type Me } from "../lib/api.ts";
import { useAuth } from "../lib/auth.tsx";
import { cx } from "../components/ui.tsx";

/** EN | FR. Signed in, the choice is also saved to the account. */
export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  const { me, setMe } = useAuth();

  const choose = (l: Locale) => {
    setLocale(l);
    if (me) void api<Me>("/api/auth/me", { method: "PATCH", body: { locale: l } }).then(setMe).catch(() => {});
  };

  return (
    <div role="group" aria-label={t("shell.language")} className={cx("inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800", className)}>
      {(["en", "fr"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => choose(l)}
          className={cx(
            "h-7 min-w-9 rounded-md px-2 text-xs font-semibold uppercase transition-colors",
            locale === l
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { pref, setPref } = useTheme();
  const { t } = useI18n();
  const options: { value: ThemePref; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: t("shell.themeLight") },
    { value: "dark", icon: Moon, label: t("shell.themeDark") },
    { value: "system", icon: Monitor, label: t("shell.themeSystem") },
  ];
  return (
    <div role="group" aria-label={t("shell.theme")} className={cx("inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800", className)}>
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={pref === value}
          onClick={() => setPref(value)}
          className={cx(
            "grid size-7 place-items-center rounded-md transition-colors",
            pref === value
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
              : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}
