/**
 * Screenshots over the Chrome DevTools Protocol, using Node's built-in
 * WebSocket - no Playwright, no browser download.
 *
 * Why not `msedge --screenshot`: on Windows the window cannot be made
 * narrower than ~490px (so no real phone widths), it cannot carry a session
 * cookie, and an open EventSource keeps the page "loading" forever so the
 * capture never fires. Over CDP all three are solved: device metrics are
 * emulated exactly, the cookie is set directly, and capture happens when the
 * network goes quiet, ignoring long-lived streams.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = process.env["EDGE_PATH"] ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<Handler>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number; result?: Record<string, unknown>; error?: { message: string };
        method?: string; params?: Record<string, unknown>; sessionId?: string;
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {}, msg.sessionId);
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP connection to ${url} failed`)), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) { set = new Set(); this.handlers.set(method, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    this.ws.close();
  }
}

export interface Browser {
  shoot(opts: ShotOptions): Promise<string>;
  close(): Promise<void>;
}

export interface ShotOptions {
  url: string;
  out: string;
  width: number;
  height: number;
  mobile?: boolean;
  dark?: boolean;
  locale?: "en" | "fr";
  /** `name=value`, set for the URL's origin before navigating. */
  cookie?: string;
  fullPage?: boolean;
  /** Extra wait after the network settles, for animations. */
  settleMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser(): Promise<Browser> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-profile-"));
  const proc: ChildProcess = spawn(EDGE, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
    "--disable-extensions", "about:blank",
  ], { stdio: "ignore" });

  // Port 0 lets the browser choose; it writes the one it picked here.
  const portFile = path.join(profile, "DevToolsActivePort");
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    else await sleep(100);
  }
  if (!port) {
    proc.kill();
    throw new Error("Edge did not start (no DevToolsActivePort). Is EDGE_PATH right?");
  }

  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  async function shoot(o: ShotOptions): Promise<string> {
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const s = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);

    try {
      await s("Page.enable");
      await s("Network.enable");
      await s("Emulation.setDeviceMetricsOverride", {
        width: o.width, height: o.height, deviceScaleFactor: 1, mobile: o.mobile ?? false,
      });
      if (o.mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await s("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: o.dark ? "dark" : "light" }],
      });
      // Before any page script: the language to use, and theme "system" so
      // the emulated color scheme above decides light or dark.
      await s("Page.addScriptToEvaluateOnNewDocument", {
        source: `try { localStorage.setItem("locale", ${JSON.stringify(o.locale ?? "en")}); localStorage.setItem("theme", "system"); } catch (e) {}`,
      });
      if (o.cookie) {
        const eq = o.cookie.indexOf("=");
        await s("Network.setCookie", { name: o.cookie.slice(0, eq), value: o.cookie.slice(eq + 1), url: o.url });
      }

      // Network-idle: no request in flight for 600ms. Event streams never
      // finish, so they are excluded rather than waited on forever.
      const inflight = new Set<string>();
      const offs = [
        cdp.on("Network.requestWillBeSent", (p, sid) => {
          if (sid === sessionId && p["type"] !== "EventSource") inflight.add(String(p["requestId"]));
        }),
        cdp.on("Network.loadingFinished", (p, sid) => { if (sid === sessionId) inflight.delete(String(p["requestId"])); }),
        cdp.on("Network.loadingFailed", (p, sid) => { if (sid === sessionId) inflight.delete(String(p["requestId"])); }),
      ];
      const loaded = new Promise<void>((resolve) => {
        const off = cdp.on("Page.loadEventFired", (_p, sid) => { if (sid === sessionId) { off(); resolve(); } });
      });

      await s("Page.navigate", { url: o.url });
      await Promise.race([loaded, sleep(10_000)]);
      const deadline = Date.now() + 8_000;
      let quietSince = Date.now();
      while (Date.now() < deadline) {
        if (inflight.size > 0) quietSince = Date.now();
        else if (Date.now() - quietSince > 600) break;
        await sleep(50);
      }
      offs.forEach((off) => off());
      await sleep(o.settleMs ?? 250);

      let clip: Record<string, number> | undefined;
      if (o.fullPage) {
        const metrics = (await s("Page.getLayoutMetrics")) as { cssContentSize: { width: number; height: number } };
        clip = { x: 0, y: 0, width: o.width, height: Math.min(Math.ceil(metrics.cssContentSize.height), 6000), scale: 1 };
      }
      const shot = (await s("Page.captureScreenshot", {
        format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}),
      })) as { data: string };
      fs.mkdirSync(path.dirname(o.out), { recursive: true });
      fs.writeFileSync(o.out, Buffer.from(shot.data, "base64"));
      return o.out;
    } finally {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async function close(): Promise<void> {
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
    await sleep(300);
    if (!proc.killed) proc.kill();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  return { shoot, close };
}
