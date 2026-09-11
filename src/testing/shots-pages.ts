/**
 * Pages added by later steps register here, so shots.ts stays unchanged.
 * Each entry: a name (used on the command line and in file names), a path,
 * and whose session to use.
 */

export function extraPages(_bid: number, _ownerCookie: string, _adminCookie: string): { name: string; path: string; cookie?: string; fullPage?: boolean }[] {
  return [];
}
