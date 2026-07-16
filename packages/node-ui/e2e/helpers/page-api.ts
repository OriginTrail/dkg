import type { Page } from '@playwright/test';

/**
 * Fetch a devnet `/api/*` endpoint FROM the browser context, attaching the SAME
 * bearer token the UI uses (`window.__DKG_TOKEN__`, injected into the HTML head
 * by vite.config.ts). A bare `fetch('/api/...')` inside `page.evaluate` omits
 * that header and gets a 401 on auth-enabled nodes even when the page itself
 * loaded fine — a false failure. Retries transient non-OK responses (e.g. a 5xx
 * under heavy parallel load), exactly like the UI's own polling does, and never
 * throws: callers get `{ ok, status, json }`.
 */
export async function fetchApiInPage<T = unknown>(
  page: Page,
  path: string,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: T | null }> {
  const retries = opts.retries ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  return page.evaluate(
    async ({ path, retries, retryDelayMs }) => {
      const token = (window as { __DKG_TOKEN__?: string }).__DKG_TOKEN__;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      let lastStatus = 0;
      for (let i = 0; i < retries; i++) {
        const r = await fetch(path, { headers });
        lastStatus = r.status;
        if (r.ok) return { ok: true, status: r.status, json: (await r.json()) as unknown };
        await new Promise((res) => setTimeout(res, retryDelayMs));
      }
      return { ok: false, status: lastStatus, json: null };
    },
    { path, retries, retryDelayMs },
  ) as Promise<{ ok: boolean; status: number; json: T | null }>;
}
