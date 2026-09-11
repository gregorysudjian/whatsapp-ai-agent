import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, onAuthError, type Me } from "./api.ts";
import { useI18n } from "../i18n/index.tsx";

interface AuthState {
  me: Me | null;
  /** True until the first /me answer, so routes don't flash the login page. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setMe: (me: Me) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const { setLocale } = useI18n();

  const setMe = useCallback((next: Me) => {
    setMeState(next);
    // The account's saved language applies unless this browser chose one.
    try {
      if (!localStorage.getItem("locale")) setLocale(next.user.locale);
    } catch { setLocale(next.user.locale); }
  }, [setLocale]);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/auth/me"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMeState(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, [setMe]);

  useEffect(() => { void refresh().catch(() => setLoading(false)); }, [refresh]);

  // A session that expires mid-use sends the person back to sign in.
  useEffect(() => onAuthError((err) => {
    if (err.status === 401) setMeState(null);
  }), []);

  const login = useCallback(async (email: string, password: string) => {
    setMe(await api<Me>("/api/auth/login", { method: "POST", body: { email, password } }));
  }, [setMe]);

  const logout = useCallback(async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } finally { setMeState(null); }
  }, []);

  return <Ctx.Provider value={{ me, loading, login, logout, refresh, setMe }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** The business to open by default: the last one chosen, if still allowed. */
export function defaultBusinessId(me: Me): number | undefined {
  try {
    const last = Number(localStorage.getItem("lastBusiness"));
    if (me.businesses.some((b) => b.id === last)) return last;
  } catch { /* storage blocked */ }
  return me.businesses[0]?.id;
}

export function rememberBusiness(id: number): void {
  try { localStorage.setItem("lastBusiness", String(id)); } catch { /* storage blocked */ }
}
