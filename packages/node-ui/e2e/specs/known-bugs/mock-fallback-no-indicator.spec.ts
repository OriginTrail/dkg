/** Regression for GH #904/#1133: a failed probe must hide operational fixtures.
 * Use the raw runner because the shared real-node fixture intentionally rejects
 * mock mode. The forced 500 response and observable flag verify this fault path.
 */
import { test, expect } from '@playwright/test';

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
});
