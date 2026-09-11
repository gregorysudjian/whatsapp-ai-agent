/**
 * Pages added by later steps register here, so shots.ts stays unchanged.
 * Each entry: a name (used on the command line and in file names), a path,
 * and whose session to use.
 */

export function extraPages(bid: number, ownerCookie: string, _adminCookie: string): { name: string; path: string; cookie?: string; fullPage?: boolean }[] {
  return [
    { name: "settings-business", path: `/b/${bid}/settings?tab=business`, cookie: ownerCookie, fullPage: true },
    { name: "settings-hours", path: `/b/${bid}/settings?tab=hours`, cookie: ownerCookie, fullPage: true },
    { name: "settings-services", path: `/b/${bid}/settings?tab=services`, cookie: ownerCookie, fullPage: true },
    { name: "settings-tone", path: `/b/${bid}/settings?tab=tone`, cookie: ownerCookie, fullPage: true },
    { name: "settings-preview", path: `/b/${bid}/settings?tab=preview`, cookie: ownerCookie, fullPage: true },
    { name: "settings-reminders", path: `/b/${bid}/settings?tab=reminders`, cookie: ownerCookie, fullPage: true },
    { name: "inbox", path: `/b/${bid}/inbox`, cookie: ownerCookie },
    { name: "contacts", path: `/b/${bid}/contacts`, cookie: ownerCookie },
    { name: "overview-full", path: `/b/${bid}/overview`, cookie: ownerCookie, fullPage: true },
    { name: "bookings", path: `/b/${bid}/bookings`, cookie: ownerCookie },
    { name: "bookings-list", path: `/b/${bid}/bookings?view=list`, cookie: ownerCookie },
    { name: "bookings-drawer", path: `/b/${bid}/bookings?view=week&open=5`, cookie: ownerCookie },
    { name: "bookings-new", path: `/b/${bid}/bookings?view=week&new=1`, cookie: ownerCookie },
    { name: "inbox-human", path: `/b/${bid}/inbox/33698765432`, cookie: ownerCookie },
    { name: "inbox-needs", path: `/b/${bid}/inbox/15145550199`, cookie: ownerCookie },
    { name: "inbox-rtl", path: `/b/${bid}/inbox/96171555666`, cookie: ownerCookie },
    { name: "inbox-closed", path: `/b/${bid}/inbox/96178333444`, cookie: ownerCookie },
  ];
}
