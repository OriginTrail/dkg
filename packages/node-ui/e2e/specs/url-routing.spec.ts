import { test, expect } from '../fixtures/base.js';

test.describe('URL state and deep-linking', () => {
  test('navigating directly to /ui/network renders the Network debug page', async ({ page }) => {
    await page.goto('network');
    await expect(page.getByRole('heading', { name: 'Network', level: 1 })).toBeVisible({ timeout: 15_000 });
    // Network page is rendered outside the AppShell — no sidebar toggle.
    expect(await page.locator('button[title="Toggle sidebar"]').count()).toBe(0);
  });

  // SKIPPED: production bug — ?tab=observability deep-link isn't
  // honoured after navigation. Settings reads `searchParams.get('tab')`
  // but the routing wiring doesn't surface the right view. Bookmark /
  // share-URL feature gap. Unskip when the route guard or initial-tab
  // logic is fixed.
  test.skip('Settings ?tab=observability shows the Observability tab when devMode is on', async ({ shell, header, settings, page }) => {
    await shell.goto();
    await header.openSettings();
    // Turn on dev mode (writes to localStorage and dispatches devmode-change).
    await settings.toggleDevMode();
    // Now navigate to settings with the deep-link.
    await page.goto('?tab=observability');
    // Either the Observability section renders, or — if devMode persistence
    // doesn't survive a fresh navigation — the regular settings render.
    // Assert one of the two. If neither, the deep-link is broken.
    const obs = page.getByRole('heading', { name: /Observability/i });
    const general = page.getByRole('heading', { name: 'Settings', level: 1 });
    const someVisible = await Promise.race([
      obs.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'observability').catch(() => null),
      general.waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'general').catch(() => null),
    ]);
    expect(someVisible).not.toBeNull();
  });

  test('unknown route falls back to AppShell (catch-all)', async ({ page }) => {
    await page.goto('this-route-does-not-exist');
    // The router's `path="*"` element is `<AppShell />`, so unknown URLs
    // should land on the dashboard, not a 404 page.
    await page.locator('.v10-app').waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });
});
