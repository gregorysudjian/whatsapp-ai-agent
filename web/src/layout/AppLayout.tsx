import { useEffect, useState, type ComponentType } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  Building2, CalendarDays, ChevronsLeft, ChevronsRight, FileText, Inbox, KeyRound,
  LayoutDashboard, LogOut, Menu, MessageCircle, MoreHorizontal, Receipt, ScrollText, Settings2, Users, X,
} from "lucide-react";
import { useAuth, rememberBusiness } from "../lib/auth.tsx";
import { useI18n, type Key } from "../i18n/index.tsx";
import { Badge, cx } from "../components/ui.tsx";
import { LanguageToggle, ThemeToggle } from "./controls.tsx";

interface NavItem { to: string; label: Key; short?: Key; icon: ComponentType<{ className?: string }> }

const businessNav = (bid: number): NavItem[] => [
  { to: `/b/${bid}/overview`, label: "nav.overview", icon: LayoutDashboard },
  { to: `/b/${bid}/inbox`, label: "nav.inbox", short: "nav.inboxShort", icon: Inbox },
  { to: `/b/${bid}/bookings`, label: "nav.bookings", icon: CalendarDays },
  { to: `/b/${bid}/contacts`, label: "nav.contacts", icon: Users },
  { to: `/b/${bid}/settings`, label: "nav.settings", icon: Settings2 },
  { to: `/b/${bid}/reports`, label: "nav.reports", icon: FileText },
];

const adminNav: NavItem[] = [
  { to: "/admin/clients", label: "nav.clients", icon: Building2 },
  { to: "/admin/usage", label: "nav.usage", icon: Receipt },
  { to: "/admin/audit", label: "nav.audit", icon: ScrollText },
];

function readCollapsed(): boolean {
  try { return localStorage.getItem("sidebarCollapsed") === "1"; } catch { return false; }
}

export function AppLayout() {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const bid = params["bid"] ? Number(params["bid"]) : (me?.businesses[0]?.id ?? 0);
  const business = me?.businesses.find((b) => b.id === bid);
  // On a URL for a business this user can't open (the page shows "not
  // found"), keep their own navigation instead of an empty sidebar.
  const navBusiness = business ?? me?.businesses[0];

  // Close the mobile drawer whenever the page changes.
  useEffect(() => setDrawer(false), [location.pathname]);
  // Reopen on the same business next time.
  useEffect(() => { if (business) rememberBusiness(business.id); }, [business]);

  if (!me) return null;
  const isAdmin = me.user.role === "super_admin";

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem("sidebarCollapsed", c ? "0" : "1"); } catch { /* storage blocked */ }
      return !c;
    });
  };

  /** Same page, different business. */
  const switchTo = (id: number) => {
    const rest = location.pathname.match(/^\/b\/\d+(\/.*)?$/)?.[1] ?? "/overview";
    navigate(`/b/${id}${rest}`);
  };

  const navLink = (item: NavItem, compact: boolean) => (
    <NavLink
      key={item.to}
      to={item.to}
      title={compact ? t(item.label) : undefined}
      className={({ isActive }) => cx(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        compact && "justify-center px-0",
        isActive
          ? "bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200"
          : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
      )}
    >
      <item.icon className="size-5 shrink-0" aria-hidden />
      {!compact && <span className="truncate">{t(item.label)}</span>}
    </NavLink>
  );

  const sidebarBody = (compact: boolean) => (
    <>
      <div className={cx("flex h-16 shrink-0 items-center gap-2 px-4", compact && "justify-center px-0")}>
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
          <MessageCircle className="size-4" aria-hidden />
        </div>
        {!compact && <span className="truncate font-semibold tracking-tight">{t("app.name")}</span>}
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-2" aria-label={t("nav.menu")}>
        {navBusiness && <div className="space-y-1">{businessNav(navBusiness.id).map((i) => navLink(i, compact))}</div>}
        {isAdmin && (
          <div className="space-y-1">
            {!compact && <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">{t("nav.admin")}</p>}
            {adminNav.map((i) => navLink(i, compact))}
          </div>
        )}
      </nav>

      <div className={cx("space-y-3 border-t border-zinc-200 p-3 dark:border-zinc-800", compact && "px-2")}>
        {!compact && (
          <div className="flex items-center justify-between gap-2">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        )}
        {!compact && (
          <div className="min-w-0 px-1">
            <p className="truncate text-sm font-medium" title={me.user.email}>{me.user.email}</p>
            <p className="text-xs text-zinc-500">{isAdmin ? t("shell.roleAdmin") : t("shell.roleOwner")}</p>
          </div>
        )}
        <div className={cx("flex gap-1", compact && "flex-col")}>
          <NavLink to="/account" title={t("auth.changePassword")} aria-label={t("auth.changePassword")}
            className="grid h-9 flex-1 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
            <KeyRound className="size-4" aria-hidden />
          </NavLink>
          <button type="button" onClick={() => void logout()} title={t("auth.logout")} aria-label={t("auth.logout")}
            className="grid h-9 flex-1 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
            <LogOut className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className={cx(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-zinc-200 bg-white lg:flex dark:border-zinc-800 dark:bg-zinc-900",
        collapsed ? "w-[4.5rem]" : "w-64",
      )}>
        {sidebarBody(collapsed)}
        <button type="button" onClick={toggleCollapsed}
          aria-label={collapsed ? t("shell.expand") : t("shell.collapse")}
          className="absolute -right-3 top-5 grid size-6 place-items-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:text-zinc-100">
          {collapsed ? <ChevronsRight className="size-3.5" aria-hidden /> : <ChevronsLeft className="size-3.5" aria-hidden />}
        </button>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t("nav.menu")}>
          <div className="absolute inset-0 bg-zinc-950/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-zinc-900">
            <button type="button" onClick={() => setDrawer(false)} aria-label={t("nav.close")}
              className="absolute right-3 top-4 grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <X className="size-5" aria-hidden />
            </button>
            {sidebarBody(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-zinc-200 bg-white/85 px-4 backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-zinc-900/85">
          <button type="button" onClick={() => setDrawer(true)} aria-label={t("nav.menu")}
            className="grid size-10 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-100 lg:hidden dark:text-zinc-300 dark:hover:bg-zinc-800">
            <Menu className="size-5" aria-hidden />
          </button>

          {business && (
            <div className="flex min-w-0 items-center gap-2">
              {isAdmin && me.businesses.length > 1 ? (
                <label className="flex min-w-0 items-center gap-2">
                  <span className="sr-only">{t("shell.switchBusiness")}</span>
                  <Building2 className="size-4 shrink-0 text-zinc-400" aria-hidden />
                  <select
                    value={business.id}
                    onChange={(e) => switchTo(Number(e.target.value))}
                    className="h-9 min-w-0 max-w-[14rem] truncate rounded-lg border border-zinc-300 bg-white pl-2 pr-8 text-sm font-medium dark:border-zinc-700 dark:bg-zinc-900 sm:max-w-xs"
                  >
                    {me.businesses.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}{b.status === "inactive" ? ` (${t("shell.inactive")})` : ""}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="truncate text-sm font-semibold">{business.name}</span>
              )}
              {business.status === "inactive" && <Badge tone="amber">{t("shell.inactive")}</Badge>}
              {/* A wrapper carries the breakpoint: the badge's own inline-flex would override "hidden". */}
              {!business.connected && <span className="hidden sm:inline-flex"><Badge tone="red">{t("shell.notConnected")}</Badge></span>}
            </div>
          )}
          <div className="flex-1" />
          <div className="hidden items-center gap-2 sm:flex lg:hidden">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>

        {/* The inbox is a two-pane app of its own and fills the screen; every
            other page is a padded document. */}
        <main className={/^\/b\/\d+\/inbox(\/|$)/.test(location.pathname)
          ? "flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:p-6"
          : "flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-10"}>
          <Outlet />
        </main>

        {/* Mobile bottom bar: the three pages used most, plus the full menu */}
        {navBusiness && (
          <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden dark:border-zinc-800 dark:bg-zinc-900"
            aria-label={t("nav.menu")}>
            {businessNav(navBusiness.id).slice(0, 3).map((item) => (
              <NavLink key={item.to} to={item.to}
                className={({ isActive }) => cx(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                  isActive ? "text-brand-700 dark:text-brand-300" : "text-zinc-500 dark:text-zinc-400",
                )}>
                <item.icon className="size-5" aria-hidden />
                <span className="max-w-full truncate px-1">{t(item.short ?? item.label)}</span>
              </NavLink>
            ))}
            <button type="button" onClick={() => setDrawer(true)}
              className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              <MoreHorizontal className="size-5" aria-hidden />
              <span>{t("nav.more")}</span>
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

