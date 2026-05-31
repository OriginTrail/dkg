import { test, expect } from '../fixtures/rich.js';
import { installRichMemoryRoutes } from '../helpers/rich-mock-routes.js';

test.describe('Document preview', () => {
  test.beforeEach(async ({ shell, leftPanel, page }) => {
    await installRichMemoryRoutes(page, { allContextGraphs: true });
    await page.route('**/api/file/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/markdown',
        body: '# Clinical Note\n\nPatient should avoid warfarin-aspirin co-administration.',
      });
    });

    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await page.locator('[data-layer="wm"]').click();
    await page.locator('.v10-layer-expand-tab').filter({ hasText: 'Documents' }).click();
  });

  test('Documents tab is reachable on WM layer', async ({ page }) => {
    await expect(page.locator('.v10-layer-expand-tab.active').filter({ hasText: 'Documents' })).toBeVisible();
  });

  test('Documents tab shows empty state without error when no docs seeded', async ({ page }) => {
    await expect(page.locator('.v10-me-error')).toBeHidden();
    await expect(page.getByText(/No documents in this layer yet/i)).toBeVisible();
  });
});
