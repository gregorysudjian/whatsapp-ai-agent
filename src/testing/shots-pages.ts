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
  ];
}
