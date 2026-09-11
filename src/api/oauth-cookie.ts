/**
 * The cookie that ties a Google consent flow to the browser that started it.
 *
 * SameSite=Lax, unlike the session cookie: Google's redirect back is a
 * cross-site top-level navigation, which Lax cookies ride along on and Strict
 * ones do not. It holds only a hash of the state, lives ten minutes, and is
 * scoped to /api/google.
 */

export const OAUTH_COOKIE = "wa_oauth";

export function oauthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["COOKIE_SECURE"] === "1",
    path: "/api/google",
    maxAge: 10 * 60_000,
  };
}
