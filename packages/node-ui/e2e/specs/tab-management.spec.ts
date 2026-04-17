import { test, expect } from '../fixtures/base.js';

test.describe('Tab Management', () => {
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

  test('clicking a project opens a new closable tab', async ({ leftPanel, centerPanel }) => {
    const before = await centerPanel.getTabCount();
    await leftPanel.expandProject('Pharma Drug Interactions');
    const after = await centerPanel.getTabCount();
    expect(after).toBeGreaterThan(before);

    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes('Pharma'));
    expect(projectTab).toBeTruthy();
    expect(await centerPanel.isTabClosable(projectTab!)).toBe(true);
  });

  test('clicking a memory layer opens a WM tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('WM'))).toBe(true);
  });

  test('closing a tab removes it from the bar', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find(t => t.includes('Pharma'))!;
    await centerPanel.closeTab(projectTab);
    const remaining = await centerPanel.getTabNames();
    expect(remaining).not.toContain(projectTab);
  });

  test('closing active tab activates a neighbor', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Climate Science');
    await leftPanel.clickLayer('Climate Science', 'swm');
    const tabs = await centerPanel.getTabNames();
    const swmTab = tabs.find(t => t.includes('SWM'))!;
    await centerPanel.closeTab(swmTab);
    const activeAfter = await centerPanel.getActiveTabName();
    expect(activeAfter).toBeTruthy();
  });

  test('clicking existing tab switches to it', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await centerPanel.switchTab('Dashboard');
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('multiple views open as separate tabs', async ({ leftPanel, centerPanel }) => {
    const before = await centerPanel.getTabCount();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    await leftPanel.expandProject('Climate Science');
    await leftPanel.clickLayer('Climate Science', 'swm');
    const after = await centerPanel.getTabCount();
    expect(after).toBeGreaterThan(before + 1);
  });

  test('reopening same view does not duplicate tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    const countBefore = await centerPanel.getTabCount();
    await centerPanel.switchTab('Dashboard');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    const countAfter = await centerPanel.getTabCount();
    expect(countAfter).toBe(countBefore);
  });

  test('Memory Stack opens as closable tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.clickMemoryStack();
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Memory Stack');
    expect(await centerPanel.isTabClosable('Memory Stack')).toBe(true);
  });
});
