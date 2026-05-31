import { test, expect } from '../fixtures/rich.js';
import { sel } from '../helpers/selectors.js';

test.describe('Memory Layer Views (rc.12 project layer switcher)', () => {
  test.describe('Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject('Pharma Drug Interactions');
      await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    });

    test('opens project tab for Pharma Drug Interactions', async ({ centerPanel }) => {
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some((t) => t.includes('Pharma'))).toBe(true);
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
      await leftPanel.expandProject('Climate Science');
      await leftPanel.clickLayer('Climate Science', 'swm');
    });

    test('SWM layer switch is reachable', async ({ page }) => {
      await expect(page.locator(`${sel.layer.switchBtn}[data-layer="swm"]`)).toBeVisible();
    });

    test('layer view loads without error', async ({ page }) => {
      await expect(page.locator('.v10-me-error')).toBeHidden();
    });
  });

  test.describe('Verified Memory', () => {
    test.beforeEach(async ({ shell, leftPanel }) => {
      await shell.goto();
      await leftPanel.expandProject('EU Supply Chain');
      await leftPanel.clickLayer('EU Supply Chain', 'vm');
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
