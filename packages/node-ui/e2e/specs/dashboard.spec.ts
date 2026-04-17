import { test, expect } from '../fixtures/base.js';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-dashboard').waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('renders page title "Dashboard"', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Dashboard', level: 1 });
    await expect(heading).toBeVisible();
  });

  test('displays subtitle with node name and network', async ({ dashboard, page }) => {
    await page.locator('.v10-dash-subtitle').waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('.v10-dash-subtitle')).toContainText('my-dkg-node', { timeout: 5_000 });
    const text = await dashboard.subtitle.textContent();
    expect(text).toContain('my-dkg-node');
    expect(text).toContain('DKG Mainnet');
  });

  test('shows four stat cards', async ({ dashboard }) => {
    const stats = await dashboard.getStatCards();
    expect(stats.length).toBe(4);
    const labels = stats.map(s => s.label.toUpperCase());
    expect(labels).toContain('KNOWLEDGE ASSETS');
    expect(labels).toContain('CONTEXT GRAPHS');
    expect(labels).toContain('CONNECTED PEERS');
    expect(labels).toContain('AGENTS');
  });

  test('stat values are numeric and populated', async ({ dashboard }) => {
    const stats = await dashboard.getStatCards();
    for (const stat of stats) {
      const num = parseInt(stat.value, 10);
      expect(num).toBeGreaterThanOrEqual(0);
    }
  });

  test('renders four quick action buttons', async ({ dashboard }) => {
    const count = await dashboard.quickActions.count();
    expect(count).toBe(4);
  });

  test('Create Project quick action opens modal', async ({ dashboard, createProjectModal }) => {
    await dashboard.clickQuickAction('Create Project');
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('Import Memories quick action opens import modal', async ({ dashboard, importFilesModal }) => {
    await dashboard.clickQuickAction('Import Memories');
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('Run SPARQL quick action opens SPARQL tab', async ({ dashboard, centerPanel }) => {
    await dashboard.clickQuickAction('Run SPARQL');
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('SPARQL');
  });

  test('Browse Graph quick action opens Explorer tab', async ({ dashboard, centerPanel }) => {
    await dashboard.clickQuickAction('Browse Graph');
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Explorer');
  });

  test('renders three project cards', async ({ dashboard }) => {
    const names = await dashboard.getProjectCardNames();
    expect(names).toContain('Pharma Drug Interactions');
    expect(names).toContain('Climate Science');
    expect(names).toContain('EU Supply Chain');
  });

  test('clicking project card opens project tab', async ({ dashboard, centerPanel }) => {
    await dashboard.clickProjectCard('Pharma Drug Interactions');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('Pharma'))).toBe(true);
  });

  test('displays six recent operations', async ({ dashboard, page }) => {
    await page.locator('.v10-recent-op').first().waitFor({ state: 'visible', timeout: 5_000 });
    const ops = await dashboard.getRecentOperations();
    expect(ops.length).toBe(6);
  });

  test('recent operations include type and status fields', async ({ dashboard, page }) => {
    await page.locator('.v10-recent-op').first().waitFor({ state: 'visible', timeout: 5_000 });
    const ops = await dashboard.getRecentOperations();
    const first = ops[0];
    expect(first.type.length).toBeGreaterThan(0);
    expect(first.status.length).toBeGreaterThan(0);
  });

  test('at least one operation shows failed status', async ({ dashboard, page }) => {
    await page.locator('.v10-recent-op').first().waitFor({ state: 'visible', timeout: 5_000 });
    const ops = await dashboard.getRecentOperations();
    const failed = ops.filter(op => op.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
  });

  test('View all link opens Operations tab', async ({ dashboard, centerPanel }) => {
    await dashboard.clickViewAllOperations();
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Operations');
  });

  test('Spending section shows TRAC amount', async ({ page }) => {
    const spending = page.getByText('TRAC');
    await expect(spending).toBeVisible();
  });

  test('Spending section shows publishes count and TRAC total', async ({ page }) => {
    const text = page.getByText(/\d+ publishes/);
    await expect(text).toBeVisible();
    const content = await text.textContent();
    expect(content).toMatch(/\d+ publishes · [\d.]+ TRAC/);
  });

  test('Projects section badge shows count 3', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Projects' });
    await expect(heading).toBeVisible();
    const badge = page.locator('.v10-dash-section-badge');
    await expect(badge).toBeVisible();
    const badgeText = await badge.textContent();
    expect(badgeText!.trim()).toBe('3');
  });

  test('project cards display asset counts', async ({ page }) => {
    await expect(page.getByText('227 assets')).toBeVisible();
    await expect(page.getByText('45 assets')).toBeVisible();
    await expect(page.getByText('89 assets')).toBeVisible();
  });

  test('recent operations include timestamps', async ({ page }) => {
    await page.locator('.v10-recent-op').first().waitFor({ state: 'visible', timeout: 5_000 });
    const time = page.locator('.v10-recent-op-time').first();
    const text = await time.textContent();
    expect(text).toMatch(/\d{1,2}:\d{2}:\d{2}\s*(AM|PM)/);
  });

  test('Run SPARQL quick action opens placeholder tab', async ({ dashboard, page }) => {
    await dashboard.clickQuickAction('Run SPARQL');
    const placeholder = page.locator('.v10-view-placeholder');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText('coming soon');
  });

  test('Browse Graph quick action opens placeholder tab', async ({ dashboard, page }) => {
    await dashboard.clickQuickAction('Browse Graph');
    const placeholder = page.locator('.v10-view-placeholder');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText('coming soon');
  });
});
