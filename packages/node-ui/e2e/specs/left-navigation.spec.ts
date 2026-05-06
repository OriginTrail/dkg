import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Left Panel Navigation', () => {
  // No global waitForReady — `Dashboard row is visible`, `PROJECTS mode
  // is active by default`, and the `+ New Project` / `Join Project` button
  // tests don't depend on the project tree being populated. Tree-dependent
  // tests opt in inline.
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('PROJECTS mode is active by default', async ({ leftPanel }) => {
    const mode = await leftPanel.getActiveMode();
    expect(mode?.trim().toUpperCase()).toContain('PROJECTS');
  });

  test('Dashboard row is visible', async ({ leftPanel }) => {
    const dashboard = leftPanel.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' });
    await expect(dashboard).toBeVisible();
  });

  test('seeded project is listed in the tree', async ({ leftPanel, seed }) => {
    await leftPanel.waitForReady();
    const names = await leftPanel.getProjectNames();
    expect(names).toContain(seed.contextGraphName);
  });

  test('seeded project shows a numeric badge', async ({ leftPanel, seed }) => {
    await leftPanel.waitForReady();
    const badge = leftPanel.root.locator(sel.leftPanel.section)
      .filter({ hasText: seed.contextGraphName })
      .locator(sel.leftPanel.sectionBadge);
    await expect(badge).toBeVisible();
    const text = (await badge.textContent())?.trim() ?? '';
    expect(parseInt(text, 10)).toBeGreaterThanOrEqual(0);
  });

  test('clicking a project row opens the project tab in the center panel', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.openProject(seed.contextGraphName);
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes(seed.contextGraphName))).toBe(true);
  });

  test('Context Oracle mode renders either a public-CG list or its empty-state copy (NOT the v9 "coming soon" placeholder)', async ({ leftPanel, page }) => {
    // PR #088dbc17 retired the "coming soon" placeholder. The oracle pane
    // now either lists public-policy CGs the daemon knows about, or shows
    // the new empty-state paragraph. Bucketing is identity-driven (see
    // contextGraphSidebar.ts) so the seeded CG can land in either bucket
    // depending on how fast `fetchCurrentAgent` resolves — accept either
    // populated or empty, but assert the legacy placeholder is gone.
    await leftPanel.switchToMode('oracle');
    const empty = leftPanel.oracleEmptyState;
    const oracleProjects = leftPanel.root.locator('.v10-tree-section');
    const someVisible = await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
      oracleProjects.first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false),
    ]);
    expect(someVisible).toBe(true);
    // Hard guard against the v9 "coming soon" string sneaking back.
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  });

  test('switching back to Projects mode restores the tree', async ({ leftPanel }) => {
    await leftPanel.waitForReady();
    const before = (await leftPanel.getProjectNames()).length;
    await leftPanel.switchToMode('oracle');
    await leftPanel.switchToMode('explorer');
    const after = (await leftPanel.getProjectNames()).length;
    expect(after).toBe(before);
  });

  test('+ New Project button opens create project modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('↗ Join Project button opens the JoinProjectModal', async ({ leftPanel, joinProjectModal }) => {
    await leftPanel.clickJoinProject();
    expect(await joinProjectModal.isOpen()).toBe(true);
  });

  test('+ New Project and ↗ Join Project both render in the sidebar header', async ({ leftPanel }) => {
    await expect(leftPanel.root.getByRole('button', { name: /\+ New Project/ })).toBeVisible();
    await expect(leftPanel.root.getByRole('button', { name: /↗ Join Project/ })).toBeVisible();
  });

  test('collapse button hides left panel', async ({ leftPanel, shell }) => {
    await leftPanel.collapse();
    await expect(shell.leftPanel).toBeHidden();
  });

  test('clicking Dashboard row switches to dashboard view', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.openProject(seed.contextGraphName);
    await leftPanel.clickDashboard();
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('hide × on a project removes it from the tree', async ({ leftPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.hideProject(seed.contextGraphName);
    const names = await leftPanel.getProjectNames();
    expect(names).not.toContain(seed.contextGraphName);
  });

  test('hiding a project surfaces a Show Hidden control', async ({ leftPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.hideProject(seed.contextGraphName);
    expect(await leftPanel.isShowHiddenVisible()).toBe(true);
  });

  test('Show Hidden restores hidden projects', async ({ leftPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.hideProject(seed.contextGraphName);
    await leftPanel.clickShowHidden();
    const names = await leftPanel.getProjectNames();
    expect(names).toContain(seed.contextGraphName);
  });
});
