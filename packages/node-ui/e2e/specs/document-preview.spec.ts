import { test, expect } from '../fixtures/rich.js';
// Use the SECONDARY (isolation) CG: the global-setup seeds PRIMARY_CG and the
// import specs upload documents into it on the shared devnet, so PRIMARY_CG's
// Documents tab is no longer empty. SECONDARY_CG is registered but never seeded
// or imported into, so the "no documents" empty state is deterministic.
import { SECONDARY_CG } from '../helpers/real-node.js';

test.describe('Document preview', () => {
  test.beforeEach(async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject(SECONDARY_CG);
    await page.locator('[data-layer="wm"]').click();
    await page.locator('.v10-layer-expand-tab').filter({ hasText: 'Documents' }).click();
  });

  test('Documents tab is reachable on WM layer', async ({ page }) => {
    await expect(page.locator('.v10-layer-expand-tab.active').filter({ hasText: 'Documents' })).toBeVisible();
  });

  test('Documents tab shows empty state without error when no docs seeded', async ({ page }) => {
    // The seeded entities are RDF triples, not uploaded documents, so the
    // Documents tab is genuinely empty on a fresh devnet CG.
    await expect(page.locator('.v10-me-error')).toBeHidden();
    await expect(page.getByText(/No documents in this layer yet/i)).toBeVisible();
  });
});
