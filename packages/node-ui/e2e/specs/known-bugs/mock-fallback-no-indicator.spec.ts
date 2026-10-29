/** Regression for GH #904/#1133: a failed probe must hide operational fixtures.
 * Use the raw runner because the shared real-node fixture intentionally rejects
 * mock mode. The forced 500 response and observable flag verify this fault path.
 */
import { test, expect } from '@playwright/test';
import { fetchApiInPage } from '../../helpers/page-api.js';
import { HeaderPage } from '../../pages/header.po.js';
import { SettingsPage } from '../../pages/settings.po.js';

test.describe('unavailable node recovery', () => {
  for (const path of ['/ui/', '/ui/network']) {
    test(`failed status probe replaces operational surfaces at ${path}`, async ({ page }) => {
      let probes = 0;
      await page.route('**/api/status', (route) => {
        probes += 1;
        return route.fulfill({ status: 500, contentType: 'application/json',
          body: '{"error":"forced-down for recovery regression"}' });
      });
      await page.goto(path);
      const assertRecovery = async () => {
        await expect.poll(() => page.evaluate(
          () => (window as { __DKG_USING_MOCKS__?: boolean }).__DKG_USING_MOCKS__ === true,
        )).toBe(true);
        const recovery = page.getByRole('alert');
        await expect(recovery.getByRole('heading', { name: 'Node unavailable' })).toBeVisible();
        await expect(recovery).toContainText('Live node data could not be loaded');
        await expect(page.getByText(/mock-node-agent|my-dkg-node/i)).toHaveCount(0);
        await expect(page.locator('.v10-header, .v10-app-body')).toHaveCount(0);
        await expect(recovery.getByRole('button', { name: 'Retry connection' })).toBeVisible();
      };
      await assertRecovery();
      const beforeRetry = probes;
      await Promise.all([
        page.waitForEvent('load'),
        page.getByRole('button', { name: 'Retry connection' }).click(),
      ]);
      await assertRecovery();
      expect(probes).toBeGreaterThan(beforeRetry);
    });
  }

  test('Retry restores the live node identity after the status endpoint recovers', async ({ page }) => {
    await page.route('**/api/status', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: '{"error":"forced-down for recovery regression"}',
    }));
    await page.goto('/ui/');
    const recovery = page.getByRole('alert');
    await expect(recovery.getByRole('heading', { name: 'Node unavailable' })).toBeVisible();
    await expect.poll(() => page.evaluate(
      () => (window as { __DKG_USING_MOCKS__?: boolean }).__DKG_USING_MOCKS__,
    )).toBe(true);
    await expect(page.locator('.v10-header, .v10-app-body')).toHaveCount(0);

    // Remove the only intercepted endpoint. The identity now comes from the
    // authenticated devnet API, not a successful mock response or fixture name.
    await page.unroute('**/api/status');
    const live = await fetchApiInPage<{ name: string; peerId: string }>(page, '/api/status');
    expect(live.ok).toBe(true);
    expect(live.json?.name).toEqual(expect.any(String));
    expect(live.json?.name.length).toBeGreaterThan(0);
    expect(live.json?.peerId).toMatch(/^12D3Koo\w{20,}$/);
    await expect(recovery).toBeVisible();

    await Promise.all([
      page.waitForEvent('load'),
      recovery.getByRole('button', { name: 'Retry connection' }).click(),
    ]);
    await expect.poll(() => page.evaluate(
      () => (window as { __DKG_USING_MOCKS__?: boolean }).__DKG_USING_MOCKS__,
    )).toBe(false);
    await expect(page.getByRole('heading', { name: 'Node unavailable' })).toHaveCount(0);
    await expect(page.locator('.v10-header')).toBeVisible();
    await expect(page.locator('.v10-app-body')).toBeVisible();
    await expect(page.getByText(/mock-node-agent|my-dkg-node/i)).toHaveCount(0);

    await new HeaderPage(page).openSettings();
    const settings = new SettingsPage(page);
    await settings.waitForLoaded();
    await settings.waitForIdentityLoaded();
    await expect(settings.fieldValue('Name').first()).toHaveText(live.json!.name);
    await expect(settings.fieldValue('Peer ID').first()).toHaveText(live.json!.peerId);
  });
});
