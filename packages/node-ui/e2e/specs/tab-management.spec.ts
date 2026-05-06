import { test, expect } from '../fixtures/base.js';

test.describe('Tab Management', () => {
  // No global waitForReady — the Dashboard tab itself doesn't depend on
  // the project tree, so simple smoke tests should not block on the
  // bootstrap window. Tree-dependent tests opt in inline.
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('Dashboard tab is present on load', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Dashboard');
  });

  test('Dashboard tab cannot be closed', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Dashboard')).toBe(false);
  });

  test('clicking a project opens a new closable tab', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.waitForReady();
    const before = await centerPanel.getTabCount();
    await leftPanel.openProject(seed.contextGraphName);
    const after = await centerPanel.getTabCount();
    expect(after).toBeGreaterThan(before);

    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes(seed.contextGraphName));
    expect(projectTab).toBeTruthy();
    expect(await centerPanel.isTabClosable(projectTab!)).toBe(true);
  });

  test('switching layers inside a project does NOT open a new tab', async ({ leftPanel, projectView, centerPanel, seed }) => {
    // In v10 the LayerSwitcher swaps the rendered layer view in-place
    // inside the existing project tab — it no longer opens a separate
    // tab per layer. This test guards against accidentally regressing
    // to the v9 "tab per WM/SWM/VM" behaviour.
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    const before = await centerPanel.getTabCount();
    await projectView.switchLayer('wm');
    await projectView.switchLayer('swm');
    await projectView.switchLayer('vm');
    const after = await centerPanel.getTabCount();
    expect(after).toBe(before);
  });

  test('closing a tab removes it from the bar', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes(seed.contextGraphName))!;
    await centerPanel.closeTab(projectTab);
    const remaining = await centerPanel.getTabNames();
    expect(remaining).not.toContain(projectTab);
  });

  test('closing the project tab leaves Dashboard active', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes(seed.contextGraphName))!;
    await centerPanel.closeTab(projectTab);
    const activeAfter = await centerPanel.getActiveTabName();
    expect(activeAfter?.trim()).toBe('Dashboard');
  });

  test('clicking existing tab switches to it', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    await centerPanel.switchTab('Dashboard');
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('opening Settings + a project opens distinct tabs', async ({ leftPanel, centerPanel, header, seed }) => {
    // Layer-tab tests went away with v10's flat project tree; the
    // multi-tab story now flows through opening fundamentally different
    // surfaces (project + Settings) rather than nested project layers.
    await leftPanel.waitForReady();
    const before = await centerPanel.getTabCount();
    await leftPanel.openProject(seed.contextGraphName);
    await header.openSettings();
    const after = await centerPanel.getTabCount();
    expect(after).toBeGreaterThanOrEqual(before + 2);
  });

  test('reopening the same project does not duplicate the tab', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.openProject(seed.contextGraphName);
    const countBefore = await centerPanel.getTabCount();
    await centerPanel.switchTab('Dashboard');
    await leftPanel.openProject(seed.contextGraphName);
    const countAfter = await centerPanel.getTabCount();
    expect(countAfter).toBe(countBefore);
  });
});
