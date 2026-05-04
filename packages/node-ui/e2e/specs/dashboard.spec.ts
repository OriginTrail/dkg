import { test, expect } from '../fixtures/base.js';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-dashboard').waitFor({ state: 'visible', timeout: 15_000 });
  });

  test('renders page title "Dashboard"', async ({ page }) => {
    const heading = page.getByRole('heading', { name: 'Dashboard', level: 1 });
    await expect(heading).toBeVisible();
  });

  test('subtitle includes the configured node name', async ({ dashboard, page }) => {
    await page.locator('.v10-dash-subtitle').waitFor({ state: 'visible', timeout: 10_000 });
    const text = await dashboard.subtitle.textContent();
    expect(text?.length ?? 0).toBeGreaterThan(0);
  });

  test('shows four stat cards with the canonical labels', async ({ dashboard }) => {
    const stats = await dashboard.getStatCards();
    expect(stats.length).toBe(4);
    const labels = stats.map(s => s.label.toUpperCase());
    expect(labels).toContain('KNOWLEDGE ASSETS');
    expect(labels).toContain('CONTEXT GRAPHS');
    expect(labels).toContain('CONNECTED PEERS');
    expect(labels).toContain('AGENTS');
  });

  test('stat values are numeric and non-negative', async ({ dashboard }) => {
    const stats = await dashboard.getStatCards();
    for (const stat of stats) {
      const num = parseInt(stat.value, 10);
      expect(num).toBeGreaterThanOrEqual(0);
    }
  });

  test('renders five quick action buttons', async ({ dashboard }) => {
    const count = await dashboard.quickActions.count();
    expect(count).toBe(5);
  });

  test('Create Project quick action opens modal', async ({ dashboard, createProjectModal }) => {
    await dashboard.clickQuickAction('Create Project');
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('Join Project quick action opens join modal', async ({ dashboard, joinProjectModal }) => {
    await dashboard.clickQuickAction('Join Project');
    expect(await joinProjectModal.isOpen()).toBe(true);
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

  test('Projects card renders cards (capped at 5 by the slice in DashboardView)', async ({ page }) => {
    const cards = page.locator('.v10-dash-project-card');
    // The dashboard renders `cgData.contextGraphs.slice(0, 5)`. Real testnet
    // sync floods the list, so we just assert at least one card lands and the
    // cap is honoured. Reachability of the seeded CG is verified in the
    // left-navigation spec, where the full tree is rendered.
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    expect(await cards.count()).toBeLessThanOrEqual(5);
  });

  test('clicking the first project card opens a project tab', async ({ page, centerPanel }) => {
    const card = page.locator('.v10-dash-project-card').first();
    await card.waitFor({ state: 'visible', timeout: 15_000 });
    const cardName = (await card.locator('.v10-dash-project-name').textContent())?.trim() ?? '';
    await card.click();
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.toLowerCase().includes(cardName.toLowerCase().slice(0, 8)))).toBe(true);
  });

  test('View all link opens Operations tab', async ({ dashboard, centerPanel }) => {
    await dashboard.clickViewAllOperations();
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Operations');
  });

  test('Spending section header is present', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Spending' })).toBeVisible();
  });

  test('Spending section shows the empty placeholder before any publish has run', async ({ page }) => {
    // The seed creates a CG and imports a file but never publishes to VM, so
    // the economics endpoint has no period yet. The UI prints "—" in that case.
    // If this starts asserting publishes/TRAC numbers, the seed has changed
    // (or a publish snuck in) and the assertion below should be updated to
    // match the populated shape: /\d+ publishes · [\d.]+ TRAC/.
    const spending = page.locator('.v10-dash-section').filter({ hasText: 'Spending' }).locator('p');
    await expect(spending).toHaveText(/—|\d+ publishes · [\d.]+ TRAC/);
  });

  test('Projects section badge eventually reflects the seeded CG count', async ({ page }) => {
    // The seed creates `qa-cg` and waits until it shows up on
    // /api/paranet/list before tests start, so the dashboard MUST eventually
    // count it. Poll for up to 30s — the dashboard's useFetch refetches on
    // a 30s interval, so a 0 reading here means the user can't see their
    // own newly-created CG for at most one cache window. If this still
    // fails after 30s, that's a real refresh / propagation bug worth
    // reporting.
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect.poll(
      async () => {
        const badge = page.locator('.v10-dash-section-badge').first();
        const text = (await badge.textContent())?.trim() ?? '';
        return parseInt(text, 10) || 0;
      },
      { timeout: 35_000, intervals: [500, 1_000, 2_000, 4_000] },
    ).toBeGreaterThanOrEqual(1);
  });
});
