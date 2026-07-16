import { test, expect } from '../fixtures/base.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

test.describe('Project View (rc.12)', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
  });

  test('project tab opens with correct name', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes(PRIMARY_CG))).toBe(true);
  });

  test('project strip displays project name', async ({ page }) => {
    await expect(page.locator('.v10-project-strip').filter({ hasText: PRIMARY_CG })).toBeVisible();
  });

  test('Import button is visible in layer switcher', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Import into Context Graph' })).toBeVisible();
  });

  test('refresh button is visible in layer switcher', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Refresh Context Graph data' })).toBeVisible();
  });

  test('overview shows project overview card', async ({ page }) => {
    await expect(page.locator('.v10-project-overview, .v10-po-card, .v10-memory-explorer-page[data-view="overview"]').first()).toBeVisible();
  });

  test('layer switcher includes Working Memory', async ({ page }) => {
    await expect(page.locator('.v10-layer-switch-btn[data-layer="wm"]')).toBeVisible();
  });

  test('Import button opens import modal', async ({ page, importFilesModal }) => {
    await page.getByRole('button', { name: 'Import into Context Graph' }).click();
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('project tab is closable', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes(PRIMARY_CG))!;
    expect(await centerPanel.isTabClosable(projectTab)).toBe(true);
  });

  test('closing project tab returns to Dashboard', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes(PRIMARY_CG))!;
    await centerPanel.closeTab(projectTab);
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('project strip has colored project dot', async ({ page }) => {
    await expect(page.locator('.v10-project-strip-dot')).toBeVisible();
  });

  test('refresh button click does not crash the view', async ({ page }) => {
    await page.getByRole('button', { name: 'Refresh Context Graph data' }).click();
    await expect(page.locator('.v10-project-strip').filter({ hasText: PRIMARY_CG })).toBeVisible();
  });

  test('switching to WM layer activates WM switch button', async ({ leftPanel, page }) => {
    await leftPanel.clickLayer(PRIMARY_CG, 'wm');
    await expect(page.locator('.v10-layer-switch-btn[data-layer="wm"].active')).toBeVisible();
  });
});
