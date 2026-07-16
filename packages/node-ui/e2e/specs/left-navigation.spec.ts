import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';
import { PRIMARY_CG, SECONDARY_CG } from '../helpers/real-node.js';

test.describe('Left Panel Navigation (rc.12)', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.waitForProjectsLoaded();
  });

  test('Context Graphs mode is active by default', async ({ leftPanel }) => {
    const mode = await leftPanel.getActiveMode();
    expect(mode?.trim()).toContain('Context Graphs');
  });

  test('Dashboard row is visible', async ({ leftPanel }) => {
    await expect(leftPanel.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' })).toBeVisible();
  });

  test('My Context Graphs peer group lists the seeded context graphs', async ({ leftPanel }) => {
    // The devnet seeds devnet-test + devnet-isolation on boot; the node may also
    // surface a local "Agent Context" CG. Assert the deterministic anchors are
    // present (tolerant to extra CGs) rather than a brittle exact count.
    const names = await leftPanel.getProjectNames();
    expect(names).toContain(PRIMARY_CG);
    expect(names).toContain(SECONDARY_CG);
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  test('clicking a context graph opens its project tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes(PRIMARY_CG))).toBe(true);
  });

  test('clicking Import from layer switcher opens import modal', async ({ leftPanel, importFilesModal }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    await leftPanel.clickLayer(PRIMARY_CG, 'import');
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('Context Oracle mode activates and renders the catalogue', async ({ leftPanel, page }) => {
    await leftPanel.switchToMode('oracle');
    expect((await leftPanel.getActiveMode())?.trim()).toContain('Context Oracle');
    // The catalogue renders EITHER discovered public CGs OR the empty-state
    // hint — both are valid on a real node depending on what's been synced.
    const emptyState = page.getByText(/No public catalogue entries yet/i);
    const catalogueRows = leftPanel.root.locator('.v10-tree-section');
    await expect
      .poll(async () => (await emptyState.isVisible().catch(() => false)) || (await catalogueRows.count()) > 0)
      .toBe(true);
  });

  test('switching back to Context Graphs mode restores project list', async ({ leftPanel }) => {
    await leftPanel.switchToMode('oracle');
    await leftPanel.switchToMode('explorer');
    expect((await leftPanel.getProjectNames()).length).toBeGreaterThanOrEqual(2);
  });

  test('+ New Context Graph button opens create modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('clicking Dashboard row switches to dashboard view', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    await leftPanel.clickDashboard();
    expect((await centerPanel.getActiveTabName())?.trim()).toBe('Dashboard');
  });

  test('Join Context Graph button opens join modal', async ({ page }) => {
    await page.locator('.v10-new-project-btn').filter({ hasText: 'Join Context Graph' }).click();
    await expect(page.locator('.v10-modal-overlay')).toBeVisible();
  });
});
