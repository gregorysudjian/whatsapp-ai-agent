import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { en, type Key } from "./en.ts";
import { fr } from "./fr.ts";

export type Locale = "en" | "fr";
const dictionaries: Record<Locale, Record<Key, string>> = { en, fr };

export function translate(locale: Locale, key: Key, vars?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? en[key];
  return vars ? template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`)) : template;
}

/**
 * The active language: a choice made on this browser wins, then the
 * account's saved preference, then the browser's own language.
 */
export function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem("locale");
    if (stored === "en" || stored === "fr") return stored;
  } catch { /* storage blocked */ }
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  /** Dates and numbers in the active language. */
  fmtDate: (ms: number, opts?: Intl.DateTimeFormatOptions) => string;
  fmtNumber: (n: number, opts?: Intl.NumberFormatOptions) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem("locale", l); } catch { /* storage blocked */ }
    document.documentElement.lang = l;
  }, []);

  const value = useMemo<I18n>(() => {
    const tag = locale === "fr" ? "fr-CA" : "en-CA";
    return {
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      fmtDate: (ms, opts) => new Intl.DateTimeFormat(tag, opts ?? { dateStyle: "medium", timeStyle: "short" }).format(ms),
      fmtNumber: (n, opts) => new Intl.NumberFormat(tag, opts).format(n),
    };
  }, [locale, setLocale]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}

export type { Key };
