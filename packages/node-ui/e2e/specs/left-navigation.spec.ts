import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

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

  test('My Context Graphs peer group lists three projects', async ({ leftPanel }) => {
    const names = await leftPanel.getProjectNames();
    expect(names).toContain('Pharma Drug Interactions');
    expect(names).toContain('Climate Science');
    expect(names).toContain('EU Supply Chain');
    expect(names.length).toBe(3);
  });

  test('clicking a context graph opens its project tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes('Pharma'))).toBe(true);
  });

  test('clicking Import from layer switcher opens import modal', async ({ leftPanel, importFilesModal }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'import');
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('Context Oracle mode shows catalogue empty state', async ({ leftPanel, page }) => {
    await leftPanel.switchToMode('oracle');
    await expect(page.getByText(/No public catalogue entries yet/i)).toBeVisible();
  });

  test('switching back to Context Graphs mode restores project list', async ({ leftPanel }) => {
    await leftPanel.switchToMode('oracle');
    await leftPanel.switchToMode('explorer');
    expect((await leftPanel.getProjectNames()).length).toBe(3);
  });

  test('+ New Context Graph button opens create modal', async ({ leftPanel, createProjectModal, page }) => {
    await page.route('**/api/agent/identity', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agentAddress: '0x1111111111111111111111111111111111111111' }),
      }),
    );
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('clicking Dashboard row switches to dashboard view', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickDashboard();
    expect((await centerPanel.getActiveTabName())?.trim()).toBe('Dashboard');
  });

  test('Join Context Graph button opens join modal', async ({ page }) => {
    await page.locator('.v10-new-project-btn').filter({ hasText: 'Join Context Graph' }).click();
    await expect(page.locator('.v10-modal-overlay')).toBeVisible();
  });
});
