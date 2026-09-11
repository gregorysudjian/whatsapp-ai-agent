import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { AuthProvider, defaultBusinessId, useAuth } from "./lib/auth.tsx";
import { I18nProvider, useI18n } from "./i18n/index.tsx";
import { ThemeProvider } from "./lib/theme.tsx";
import { Spinner } from "./components/ui.tsx";
import { AppLayout } from "./layout/AppLayout.tsx";
import { Login } from "./pages/Login.tsx";
import { ChangePassword } from "./pages/ChangePassword.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Settings } from "./pages/Settings.tsx";
import { NotFound, Placeholder } from "./pages/Placeholder.tsx";

/** Signed in, password settled - or sent where they need to go. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const { t } = useI18n();
  if (loading) return <Spinner label={t("common.loading")} />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword) return <Navigate to="/welcome" replace />;
  return <>{children}</>;
}

/**
 * The browser-side mirror of the server's scope check. The server is the
 * real guard (an owner asking for another business gets a 404 from the API);
 * this just avoids rendering a page the API will refuse.
 */
function RequireBusiness({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const { bid } = useParams();
  if (!me?.businesses.some((b) => String(b.id) === bid)) return <NotFound />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  return me?.user.role === "super_admin" ? <>{children}</> : <NotFound />;
}

function Home() {
  const { me } = useAuth();
  const bid = me ? defaultBusinessId(me) : undefined;
  if (bid) return <Navigate to={`/b/${bid}/overview`} replace />;
  return me?.user.role === "super_admin" ? <Navigate to="/admin/clients" replace /> : <NotFound />;
}

function ForcedPasswordChange() {
  const { me, loading } = useAuth();
  const { t } = useI18n();
  if (loading) return <Spinner label={t("common.loading")} />;
  if (!me) return <Navigate to="/login" replace />;
  if (!me.user.mustChangePassword) return <Navigate to="/" replace />;
  return <ChangePassword forced />;
}

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/welcome" element={<ForcedPasswordChange />} />
              <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route index element={<Home />} />
                <Route path="/account" element={<ChangePassword forced={false} />} />
                <Route path="/b/:bid">
                  <Route index element={<Navigate to="overview" replace />} />
                  <Route path="overview" element={<RequireBusiness><Overview /></RequireBusiness>} />
                  <Route path="inbox" element={<RequireBusiness><Placeholder title="nav.inbox" /></RequireBusiness>} />
                  <Route path="bookings" element={<RequireBusiness><Placeholder title="nav.bookings" /></RequireBusiness>} />
                  <Route path="contacts" element={<RequireBusiness><Placeholder title="nav.contacts" /></RequireBusiness>} />
                  <Route path="settings" element={<RequireBusiness><Settings /></RequireBusiness>} />
                  <Route path="reports" element={<RequireBusiness><Placeholder title="nav.reports" /></RequireBusiness>} />
                  <Route path="*" element={<NotFound />} />
                </Route>
                <Route path="/admin/clients" element={<RequireAdmin><Placeholder title="nav.clients" /></RequireAdmin>} />
                <Route path="/admin/usage" element={<RequireAdmin><Placeholder title="nav.usage" /></RequireAdmin>} />
                <Route path="/admin/audit" element={<RequireAdmin><Placeholder title="nav.audit" /></RequireAdmin>} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
