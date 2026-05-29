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

  test('Documents tab shows empty state or document list without error', async ({ page }) => {
    await expect(page.locator('.v10-me-error')).toBeHidden();
    const body = page.locator('.v10-layer-expand-body');
    await expect(body.first()).toBeVisible();
  });

  test('clicking a document row opens preview modal when documents exist', async ({ page, filePreviewModal }) => {
    const docRow = page.locator('.v10-item-row').filter({ hasText: /\.md|\.pdf/i });
    const count = await docRow.count();
    if (count === 0) return;
    await docRow.first().click();
    expect(await filePreviewModal.isOpen()).toBe(true);
    await filePreviewModal.close();
  });
});
