import { test, expect } from '../fixtures/base.js';

test.describe('Project View', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
  });

  test('project tab opens with correct name', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('Pharma Drug Interactions'))).toBe(true);
  });

  test('project heading displays project name', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Pharma Drug Interactions', level: 1 });
    await expect(heading).toBeVisible();
  });

  test('Import button is visible in project header', async ({ page }) => {
    const importBtn = page.getByRole('button', { name: '↑ Import', exact: true });
    await expect(importBtn).toBeVisible();
  });

  test('refresh button is visible in project header', async ({ page }) => {
    const refreshBtn = page.locator('button').filter({ hasText: '↻' });
    await expect(refreshBtn).toBeVisible();
  });

  test('empty state shows "No knowledge yet" heading', async ({ page }) => {
    const emptyHeading = page.getByRole('heading', { name: 'No knowledge yet' });
    await expect(emptyHeading).toBeVisible();
  });

  test('empty state shows import prompt text', async ({ page }) => {
    const text = page.getByText('Import files, chat with your agent');
    await expect(text).toBeVisible();
  });

  test('empty state Import Files button opens import modal', async ({ page, importFilesModal }) => {
    const importBtn = page.locator('button').filter({ hasText: '↑ Import Files' });
    await importBtn.click();
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('header Import button also opens import modal', async ({ page, importFilesModal }) => {
    const headerImport = page.locator('.v10-me-header button').filter({ hasText: '↑ Import' });
    await headerImport.click();
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('project tab is closable', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes('Pharma'))!;
    expect(await centerPanel.isTabClosable(projectTab)).toBe(true);
  });

  test('closing project tab returns to Dashboard', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes('Pharma'))!;
    await centerPanel.closeTab(projectTab);
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('empty state has hexagon icon', async ({ page }) => {
    const icon = page.locator('.v10-me-empty-icon');
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText('⬡');
  });

  test('empty state shows detailed import prompt', async ({ page }) => {
    await expect(page.getByText('connect an integration to start building')).toBeVisible();
  });

  test('project header has colored project dot', async ({ page }) => {
    const dot = page.locator('.v10-me-project-dot');
    await expect(dot).toBeVisible();
  });

  test('refresh button click does not crash the view', async ({ page }) => {
    const refreshBtn = page.locator('.v10-me-action-btn').filter({ hasText: '↻' });
    await refreshBtn.click();
    const heading = page.getByRole('heading', { name: 'Pharma Drug Interactions', level: 1 });
    await expect(heading).toBeVisible();
  });
});
