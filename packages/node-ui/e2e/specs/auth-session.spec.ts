import { test, expect } from '../fixtures/base.js';
import { fetchApiInPage } from '../helpers/page-api.js';

test.describe('dashboard auth session', () => {
  test('loads without exposing a browser bearer token and uses session credentials', async ({ shell, page }) => {
    const eventUrls: string[] = [];
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

    await page.waitForTimeout(500);
    expect(eventUrls.every((url) => !new URL(url).searchParams.has('token'))).toBe(true);
  });
});
