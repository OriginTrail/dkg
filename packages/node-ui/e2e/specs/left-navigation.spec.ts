import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';
import { PRIMARY_CG, SECONDARY_CG } from '../helpers/real-node.js';

test.describe('Left Panel Navigation (rc.12)', () => {
  test.beforeEach(async ({ shell, leftPanel }) => {
    await shell.goto();
    await leftPanel.waitForProjectsLoaded();
  });

  test('My Context Graphs is expanded by default, and Public graphs collapsed', async ({ leftPanel }) => {
    await expect(leftPanel.sectionHeader('My Context Graphs')).toHaveAttribute('aria-expanded', 'true');
    await expect(leftPanel.sectionHeader('Public graphs')).toHaveAttribute('aria-expanded', 'false');
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

  test('Public graphs expands and renders the catalogue', async ({ leftPanel }) => {
    await leftPanel.expandSection('Public graphs');
    expect(await leftPanel.isSectionExpanded('Public graphs')).toBe(true);
    // The catalogue renders EITHER discovered public CGs OR the empty-state
    // hint — both are valid on a real node depending on what's been synced.
    // Only the Public graphs section counts: My Context Graphs' rows share
    // the row class.
    const section = leftPanel.publicGraphsSection();
    const body = section.locator(sel.leftPanel.peerGroupBody);
    const rows = body.locator(sel.leftPanel.section);
    const emptyState = body.locator(sel.leftPanel.emptyCard);
    const count = section.locator(sel.leftPanel.peerGroupCount);
    // As many rows as the header counts, or, with none, the empty state alone.
    await expect
      .poll(async () => {
        const [counted, listed, empty] = await Promise.all([count.textContent(), rows.count(), emptyState.count()]);
        return Number(counted) === listed && (listed > 0 ? empty === 0 : empty === 1);
      })
      .toBe(true);
    if ((await rows.count()) > 0) {
      for (const row of await rows.all()) await expect(row).toBeVisible();
    } else {
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toContainText(/Discovered public graphs will appear here/i);
    }
  });

  test('expanding Public graphs leaves My Context Graphs expanded, with both lists on show', async ({ leftPanel }) => {
    const mine = leftPanel.section('My Context Graphs');
    const discovered = leftPanel.section('Public graphs');
    await expect(leftPanel.sectionHeader('My Context Graphs')).toHaveAttribute('aria-expanded', 'true');
    await expect(leftPanel.sectionHeader('Public graphs')).toHaveAttribute('aria-expanded', 'false');
    await leftPanel.expandSection('Public graphs');
    // Nothing is opened again: both sections stay as that one click left them.
    await expect(leftPanel.sectionHeader('Public graphs')).toHaveAttribute('aria-expanded', 'true');
    await expect(leftPanel.sectionHeader('My Context Graphs')).toHaveAttribute('aria-expanded', 'true');
    const myRows = mine.locator(sel.leftPanel.peerGroupBody).locator(sel.leftPanel.section);
    for (const name of [PRIMARY_CG, SECONDARY_CG]) await expect(myRows.filter({ hasText: name }).first()).toBeVisible();
    // Public graphs lists the graphs the node discovered, or says there are none yet.
    const discoveredBody = discovered.locator(sel.leftPanel.peerGroupBody);
    await expect(discoveredBody.locator(`${sel.leftPanel.section}, ${sel.leftPanel.emptyCard}`).first()).toBeVisible();
  });

  test('New button opens create modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('clicking Dashboard row switches to dashboard view', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject(PRIMARY_CG);
    await leftPanel.clickDashboard();
    expect((await centerPanel.getActiveTabName())?.trim()).toBe('Dashboard');
  });

  test('Join button opens join modal', async ({ page }) => {
    await page.locator('.v10-sidebar-inline-actions button').filter({ hasText: /^Join$/ }).click();
    await expect(page.locator('.v10-modal-overlay')).toBeVisible();
  });
});
