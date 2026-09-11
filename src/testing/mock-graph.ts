/**
 * A stand-in for Meta's Graph API, speaking its real response shapes.
 *
 * Point the client at it with GRAPH_BASE_URL and the send path runs for real
 * over a socket - chunking, wamid capture, error classification and retry all
 * execute exactly as they would in production. That is worth far more than
 * stubbing `sendText`, which would test nothing but the stub.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
  /** The bearer token presented - lets tests prove which client's token was used. */
  authorization: string;
  receivedAt: number;
}

/** A canned response. `status` 200 returns a normal send result. */
export interface ScriptedResponse {
  status: number;
  /** Graph's error envelope, used when status is not 2xx. */
  error?: { message: string; type: string; code: number; error_subcode?: number };
  /** Seconds; sent as Retry-After so backoff can be asserted. */
  retryAfter?: number;
}

export class MockGraph {
  readonly requests: RecordedRequest[] = [];
  /** Consumed one per request; when empty, every request succeeds. */
  private script: ScriptedResponse[] = [];
  private server: http.Server | undefined;
  private nextWamid = 1;
  /**
   * Per-instance so ids stay unique across test files. wamid is the primary
   * key in the store and inserts are ON CONFLICT DO NOTHING, so a collision
   * between two mock instances silently drops rows rather than failing.
   */
  private readonly wamidPrefix = Math.random().toString(36).slice(2, 8);

  /** Queue responses for the next N requests, in order. */
  script_(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  reset(): void {
    this.requests.length = 0;
    this.script.length = 0;
  }

  /** Messages sent as plain text, in order - the usual assertion target. */
  get sentTexts(): string[] {
    return this.requests
      .filter((r) => r.body["type"] === "text")
      .map((r) => (r.body["text"] as { body: string } | undefined)?.body ?? "");
  }

  /** Read receipts and typing indicators, which are not replies. */
  get statusUpdates(): RecordedRequest[] {
    return this.requests.filter((r) => r.body["status"] === "read");
  }

  async listen(port: number): Promise<number> {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          // Leave it empty - a malformed body is itself worth asserting on.
        }
        this.requests.push({
          path: req.url ?? "",
          body,
          authorization: String(req.headers["authorization"] ?? ""),
          receivedAt: Date.now(),
        });

        const next = this.script.shift();
        if (next && next.status >= 300) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (next.retryAfter !== undefined) headers["retry-after"] = String(next.retryAfter);
          res.writeHead(next.status, headers);
          res.end(JSON.stringify({
            error: next.error ?? {
              message: "mock failure", type: "OAuthException", code: next.status,
            },
          }));
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "recipient", wa_id: "recipient" }],
          messages: [{ id: `wamid.MOCK_${this.wamidPrefix}_${this.nextWamid++}` }],
        }));
      });
    });

    await new Promise<void>((resolve) => this.server?.listen(port, resolve));
    return (this.server?.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }
}
