import { test, expect } from '../fixtures/base.js';
import { fetchApiInPage } from '../helpers/page-api.js';

async function readWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test.describe('dashboard auth session', () => {
  test('loads without exposing a browser bearer token and uses session credentials', async ({ shell, page }) => {
    const eventUrls: string[] = [];
    let resolveEventResponse: ((response: { status(): number; headers(): Record<string, string> }) => void) | undefined;
    const eventResponsePromise = new Promise<{ status(): number; headers(): Record<string, string> }>((resolve) => {
      resolveEventResponse = resolve;
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname !== '/api/events') return;
      resolveEventResponse?.(response);
      resolveEventResponse = undefined;
    });
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/events')) eventUrls.push(url);
    });

    await shell.goto();

    const legacyToken = await page.evaluate(() => (window as Record<string, unknown>).__DKG_TOKEN__);
    expect(legacyToken).toBeUndefined();

    const session = await page.evaluate(async () => {
      const res = await fetch('/api/dashboard/session/status', { credentials: 'same-origin' });
      return res.ok ? res.json() : null;
    });
    expect(session?.authenticated).toBe(true);

    const status = await fetchApiInPage<{ peerId?: string }>(page, '/api/status');
    expect(status.ok).toBe(true);
    expect(status.json?.peerId).toBeTruthy();

    if (eventUrls.length === 0) {
      const eventRequest = await page.waitForRequest(
        (request) => request.url().includes('/api/events'),
        { timeout: 30_000 },
      );
      eventUrls.push(eventRequest.url());
    }
    const eventResponse = await readWithTimeout(eventResponsePromise, 30_000);
    expect(eventResponse).not.toBe('timeout');
    if (eventResponse === 'timeout') throw new Error('timed out waiting for /api/events response');
    expect(eventResponse.status()).toBe(200);
    expect(eventResponse.headers()['content-type']).toContain('text/event-stream');
    expect(eventUrls.length).toBeGreaterThan(0);
    expect(eventUrls.every((url) => !new URL(url).searchParams.has('token'))).toBe(true);

    const origin = new URL(page.url()).origin;
    const cookies = await page.context().cookies(origin);
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    expect(cookieHeader).toContain('dkg_ui_session=');

    const stream = await fetch(`${origin}/api/events`, { headers: { Cookie: cookieHeader } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body?.getReader();
    expect(reader).toBeTruthy();

    const connected = await readWithTimeout(reader!.read(), 5_000);
    expect(connected).not.toBe('timeout');

    const logoutStatus = await page.evaluate(async () => {
      const statusRes = await fetch('/api/dashboard/session/status', { credentials: 'same-origin' });
      const status = statusRes.ok ? await statusRes.json() as { csrfToken?: string } : null;
      if (!status?.csrfToken) return 'missing-csrf-token';
      const res = await fetch('/api/dashboard/session/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-DKG-CSRF': status.csrfToken },
      });
      return res.status;
    });
    expect(logoutStatus).toBe(200);

    const closed = await readWithTimeout(reader!.read(), 5_000);
    expect(closed).not.toBe('timeout');
    expect(closed).toMatchObject({ done: true });
  });
});
