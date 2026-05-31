import { test, expect } from '../fixtures/base.js';

test.describe('Dashboard (rc.12)', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-dashboard').waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('renders page title "Dashboard"', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('displays subtitle with node name and network', async ({ dashboard, page }) => {
    await page.locator('.v10-dash-subtitle').waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('.v10-dash-subtitle')).toContainText('my-dkg-node', { timeout: 5_000 });
    const text = await dashboard.subtitle.textContent();
    expect(text).toContain('my-dkg-node');
    expect(text).toContain('DKG Mainnet');
  });

  test('shows My Context Graphs stat card', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: 'My Context Graphs' })).toBeVisible();
  });

  test('shows Context Graph Size stat card', async ({ page }) => {
    await expect(page.locator('.stat-label').filter({ hasText: 'Context Graph Size' })).toBeVisible();
  });

  test('sidebar lists mock context graphs under My Context Graphs', async ({ leftPanel }) => {
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toContain('Pharma Drug Interactions');
  });

  test('clicking sidebar CG opens project tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes('Pharma'))).toBe(true);
  });

  test('New Context Graph button opens create modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
    await createProjectModal.cancel();
  });

  test('spending section shows TRAC label when economics mock loads', async ({ page }) => {
    await expect(page.getByText('TRAC').first()).toBeVisible({ timeout: 10_000 });
  });
});
