import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';
import { PRIMARY_CG, SECONDARY_CG } from '../helpers/real-node.js';

test.describe('Left Panel Navigation (rc.12)', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.waitForProjectsLoaded();
  });

  test('Dashboard row is visible', async ({ leftPanel }) => {
    await expect(leftPanel.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' })).toBeVisible();
  });

  test('My Context Graphs peer group lists the seeded Context Graphs', async ({ leftPanel }) => {
    // The devnet seeds devnet-test + devnet-isolation on boot; the node may also
    // surface a local "Agent Context" CG. Assert the deterministic anchors are
    // present (tolerant to extra CGs) rather than a brittle exact count.
    const names = await leftPanel.getProjectNames();
    expect(names).toContain(PRIMARY_CG);
    expect(names).toContain(SECONDARY_CG);
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  test('clicking a Context Graph opens its project tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes(PRIMARY_CG))).toBe(true);
  });

  test('clicking Import from layer switcher opens import modal', async ({ leftPanel, importFilesModal }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    await leftPanel.clickLayer(PRIMARY_CG, 'import');
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('Public Context Graphs renders the catalogue', async ({ leftPanel, page }) => {
    // Only the Public Context Graphs group counts: its disclosed body shows
    // either discovered public Context Graphs or the empty hint, depending on
    // what the node has synced. My Context Graphs rows don't satisfy it.
    const header = leftPanel.root.getByRole('button', { name: 'Public context graphs', exact: true });
    await expect(header).toBeVisible();
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const bodyId = await header.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    const body = page.locator(`[id="${bodyId}"]`);
    const content = body.locator('.v10-tree-section-label, .v10-tree-hint');
    await expect(content.first()).toBeVisible();
  });

  test('switching back to Context Graphs mode restores project list', async ({ leftPanel }) => {
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
    await page.locator('.v10-new-project-btn').filter({ hasText: /^Join$/ }).click();
    await expect(page.locator('.v10-modal-overlay')).toBeVisible();
  });
});
