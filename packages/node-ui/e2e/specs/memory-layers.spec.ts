import { test, expect } from '../fixtures/rich.js';
import { sel } from '../helpers/selectors.js';
import { PRIMARY_CG, SECONDARY_CG } from '../helpers/real-node.js';

test.describe('Memory Layer Views (rc.12 project layer switcher)', () => {
  test.describe('Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject(PRIMARY_CG);
      await leftPanel.clickLayer(PRIMARY_CG, 'wm');
    });

    test('opens project tab for the primary context graph', async ({ centerPanel }) => {
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some((t) => t.includes(PRIMARY_CG))).toBe(true);
    });

    test('WM layer switch button is active', async ({ page }) => {
      await expect(page.locator(`${sel.layer.switchBtn}[data-layer="wm"].active`)).toBeVisible();
    });

    test('layer expand tabs include Graph and Documents', async ({ page }) => {
      await expect(page.locator('.v10-layer-expand-tab').filter({ hasText: 'Graph' })).toBeVisible();
      await expect(page.locator('.v10-layer-expand-tab').filter({ hasText: 'Documents' })).toBeVisible();
    });

    test('layer view loads without error banner', async ({ page }) => {
      await expect(page.locator('.v10-me-error')).toBeHidden();
    });
  });

  test.describe('Shared Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject(SECONDARY_CG);
      await leftPanel.clickLayer(SECONDARY_CG, 'swm');
    });

    test('SWM layer switch is reachable', async ({ page }) => {
      await expect(page.locator(`${sel.layer.switchBtn}[data-layer="swm"]`)).toBeVisible();
    });

    test('layer view loads without error', async ({ page }) => {
      await expect(page.locator('.v10-me-error')).toBeHidden();
    });
  });

  test.describe('Verifiable Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject(PRIMARY_CG);
      await leftPanel.clickLayer(PRIMARY_CG, 'vm');
    });

    test('VM layer switch is reachable', async ({ page }) => {
      await expect(page.locator(`${sel.layer.switchBtn}[data-layer="vm"]`)).toBeVisible();
    });

    test('VM layer loads without error', async ({ page }) => {
      await expect(page.locator('.v10-me-error')).toBeHidden();
      await expect(page.locator('.v10-layer-switch-btn[data-layer="vm"].active')).toBeVisible();
    });
  });
});
