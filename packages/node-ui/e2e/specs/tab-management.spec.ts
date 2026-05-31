import { test, expect } from '../fixtures/base.js';

test.describe('Tab Management (rc.12)', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('Dashboard tab is present on load', async ({ centerPanel }) => {
    expect(await centerPanel.getTabNames()).toContain('Dashboard');
  });

  test('Dashboard tab cannot be closed', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Dashboard')).toBe(false);
  });

  test('clicking a project opens a new closable tab', async ({ leftPanel, centerPanel }) => {
    const before = await centerPanel.getTabCount();
    await leftPanel.expandProject('Pharma Drug Interactions');
    expect(await centerPanel.getTabCount()).toBeGreaterThan(before);

    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes('Pharma'));
    expect(projectTab).toBeTruthy();
    expect(await centerPanel.isTabClosable(projectTab!)).toBe(true);
  });

  test('clicking a memory layer keeps single project tab (layer switcher)', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const before = await centerPanel.getTabCount();
    await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    expect(await centerPanel.getTabCount()).toBe(before);
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.includes('Pharma'))).toBe(true);
  });

  test('closing a tab removes it from the bar', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes('Pharma'))!;
    await centerPanel.closeTab(projectTab);
    expect(await centerPanel.getTabNames()).not.toContain(projectTab);
  });

  test('closing active tab activates a neighbor', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Climate Science');
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes('Climate'))!;
    await centerPanel.closeTab(projectTab);
    expect(await centerPanel.getActiveTabName()).toBeTruthy();
  });

  test('clicking existing tab switches to it', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await centerPanel.switchTab('Dashboard');
    expect((await centerPanel.getActiveTabName())?.trim()).toBe('Dashboard');
  });

  test('multiple projects open as separate tabs', async ({ leftPanel, centerPanel }) => {
    const before = await centerPanel.getTabCount();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.expandProject('Climate Science');
    expect(await centerPanel.getTabCount()).toBeGreaterThan(before + 1);
  });

  test('reopening same project does not duplicate tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const countBefore = await centerPanel.getTabCount();
    await centerPanel.switchTab('Dashboard');
    await leftPanel.expandProject('Pharma Drug Interactions');
    expect(await centerPanel.getTabCount()).toBe(countBefore);
  });

  test('Observability opens as closable tab from header', async ({ header, centerPanel }) => {
    await header.openObservability();
    expect(await centerPanel.getTabNames()).toContain('Observability');
    expect(await centerPanel.isTabClosable('Observability')).toBe(true);
  });
});
