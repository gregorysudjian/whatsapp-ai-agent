/**
 * A stand-in for Google's OAuth and Calendar APIs, speaking their shapes:
 * the token endpoint (authorization code and refresh), userinfo, events
 * insert / patch / delete, and freeBusy. Point the app at it with the
 * GOOGLE_* URLs in .env.test. Every request is recorded so tests can check
 * which calendar, event and token each call used.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface GoogleRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  form: Record<string, string>;
  authorization: string;
}

export class MockGoogle {
  readonly requests: GoogleRequest[] = [];
  /** Authorization codes the token endpoint will accept, and the account each belongs to. */
  readonly codes = new Map<string, { email: string; refreshToken: string }>();
  /** Refresh tokens Google has revoked: using one answers invalid_grant. */
  readonly revoked = new Set<string>();
  /** Events by id, as last written. */
  readonly events = new Map<string, Record<string, unknown>>();
  /** What freeBusy answers with, as [start, end] ISO instants. */
  busy: { start: string; end: string }[] = [];
  /** Make the next calendar call fail with this status (once). */
  failNext: number | null = null;
  private server: http.Server | undefined;
  private n = 0;
  private readonly emails = new Map<string, string>(); // access token -> email

  reset(): void {
    this.requests.length = 0;
    this.events.clear();
    this.busy = [];
    this.failNext = null;
  }

  calendarCalls(): GoogleRequest[] {
    return this.requests.filter((r) => r.path.startsWith("/calendar/"));
  }

  async listen(port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const isForm = String(req.headers["content-type"] ?? "").includes("x-www-form-urlencoded");
        let body: Record<string, unknown> = {};
        try { if (!isForm && raw) body = JSON.parse(raw) as Record<string, unknown>; } catch { /* leave empty */ }
        const form = isForm ? Object.fromEntries(new URLSearchParams(raw)) : {};
        const r: GoogleRequest = { method: req.method ?? "GET", path: url.pathname, body, form, authorization: String(req.headers["authorization"] ?? "") };
        this.requests.push(r);
        const send = (status: number, json?: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(json === undefined ? "" : JSON.stringify(json));
        };

        if (r.path === "/token") {
          if (form["grant_type"] === "authorization_code") {
            const grant = this.codes.get(form["code"] ?? "");
            if (!grant) return send(400, { error: "invalid_grant", error_description: "Bad code" });
            this.codes.delete(form["code"]!);
            const access = `access-${++this.n}`;
            this.emails.set(access, grant.email);
            return send(200, { access_token: access, refresh_token: grant.refreshToken, expires_in: 3599, token_type: "Bearer" });
          }
          if (form["grant_type"] === "refresh_token") {
            if (this.revoked.has(form["refresh_token"] ?? "")) return send(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
            return send(200, { access_token: `access-${++this.n}`, expires_in: 3599, token_type: "Bearer" });
          }
          return send(400, { error: "unsupported_grant_type" });
        }
        if (r.path === "/revoke") return send(200, {});
        if (r.path === "/oauth2/v3/userinfo") {
          return send(200, { email: this.emails.get(r.authorization.replace(/^Bearer /, "")) ?? "unknown@example.test" });
        }
        if (!r.authorization.startsWith("Bearer access-")) return send(401, { error: { code: 401 } });
        if (this.failNext !== null) {
          const status = this.failNext;
          this.failNext = null;
          return send(status, { error: { code: status, message: "mock failure" } });
        }
        if (r.path === "/calendar/v3/freeBusy") {
          const id = ((body["items"] as { id: string }[] | undefined) ?? [])[0]?.id ?? "primary";
          return send(200, { kind: "calendar#freeBusy", calendars: { [id]: { busy: this.busy } } });
        }
        const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(r.path);
        if (m) {
          const eventId = m[2] ? decodeURIComponent(m[2]) : undefined;
          if (r.method === "POST" && !eventId) {
            const id = `evt${++this.n}`;
            this.events.set(id, body);
            return send(200, { id, ...body });
          }
          if (!eventId || !this.events.has(eventId)) return send(404, { error: { code: 404, message: "Not Found" } });
          if (r.method === "PATCH") {
            this.events.set(eventId, { ...this.events.get(eventId), ...body });
            return send(200, { id: eventId, ...this.events.get(eventId) });
          }
          if (r.method === "DELETE") {
            this.events.delete(eventId);
            return send(204);
          }
        }
        send(404, { error: { code: 404 } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
    void (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
