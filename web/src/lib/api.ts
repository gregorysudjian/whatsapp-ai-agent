/**
 * The one way the UI talks to the server. Same-origin, cookie-authenticated;
 * nothing sensitive is ever kept in JavaScript-readable storage.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body["message"] ?? body["error"] ?? `HTTP ${status}`));
    this.status = status;
    this.code = String(body["error"] ?? "unknown");
    this.body = body;
  }
}

type Listener = (err: ApiError) => void;
const authListeners = new Set<Listener>();

/** The auth layer listens here to react to a session that died mid-use. */
export function onAuthError(fn: Listener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.body !== undefined ? { "content-type": "application/json" } : {},
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, { error: "offline" });
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: "bad_response" };
  }

  if (!res.ok) {
    const err = new ApiError(res.status, body);
    if (res.status === 401 || err.code === "password_change_required") {
      for (const fn of authListeners) fn(err);
    }
    throw err;
  }
  return body as T;
}

// --- shared response shapes -------------------------------------------------

export interface MeBusiness {
  id: number;
  name: string;
  status: "active" | "inactive";
  timezone: string;
  defaultLanguage: "en" | "fr";
  connected: boolean;
}

export interface Me {
  user: {
    id: number;
    email: string;
    name: string | null;
    role: "super_admin" | "owner";
    businessId: number | null;
    locale: "en" | "fr";
    mustChangePassword: boolean;
  };
  businesses: MeBusiness[];
}
