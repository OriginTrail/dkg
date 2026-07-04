import type { Page } from '@playwright/test';

/**
 * Fetch a devnet `/api/*` endpoint FROM the browser context with the same
 * dashboard session cookie the UI uses. Retries transient non-OK responses
 * (e.g. a 5xx under heavy parallel load), exactly like the UI's own polling
 * does, and never throws: callers get `{ ok, status, json }`.
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
      let lastStatus = 0;
      for (let i = 0; i < retries; i++) {
        const r = await fetch(path, { credentials: 'same-origin' });
        lastStatus = r.status;
        if (r.ok) return { ok: true, status: r.status, json: (await r.json()) as unknown };
        await new Promise((res) => setTimeout(res, retryDelayMs));
      }
      return { ok: false, status: lastStatus, json: null };
    },
    { path, retries, retryDelayMs },
  ) as Promise<{ ok: boolean; status: number; json: T | null }>;
}
