import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Left Panel Navigation', () => {
  // No global waitForReady — `Dashboard row is visible`, `PROJECTS mode
  // is active by default`, `Memory Stack row is visible`, and the
  // `+ New Project` / `Join Project` button tests don't depend on the
  // project tree being populated. Tree-dependent tests opt in inline.
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

  test('Memory Stack row is visible', async ({ leftPanel, page }) => {
    await page.locator('.v10-tree-dashboard').filter({ hasText: 'Memory Stack' }).waitFor({ state: 'visible', timeout: 5_000 });
    expect(await leftPanel.isMemoryStackVisible()).toBe(true);
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

  test('expanding a project reveals memory layer items', async ({ leftPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    const section = leftPanel.root.locator(sel.leftPanel.section).filter({ hasText: seed.contextGraphName });
    const layerHeaders = section.locator(sel.leftPanel.layerHeader);
    expect(await layerHeaders.count()).toBe(3);
    await expect(section.locator(sel.leftPanel.treeItem).first()).toBeVisible();
  });

  test('expanded project shows Working, Shared, and Verified memory sections', async ({ page, leftPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    const content = page.locator(sel.leftPanel.root).first();
    await expect(content.getByText('WORKING MEMORY')).toBeVisible();
    await expect(content.getByText('SHARED MEMORY')).toBeVisible();
    await expect(content.getByText('VERIFIED MEMORY')).toBeVisible();
  });

  test('working memory section contains agent drafts and import link', async ({ page, leftPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    const section = page.locator(sel.leftPanel.root).first();
    await expect(section.getByText('agent drafts')).toBeVisible();
    await expect(section.getByText('Import files…')).toBeVisible();
  });

  test('clicking agent drafts opens WM tab', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickLayer(seed.contextGraphName, 'wm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('WM'))).toBe(true);
  });

  test('clicking Import files link opens import modal', async ({ leftPanel, importFilesModal, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickLayer(seed.contextGraphName, 'import');
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('clicking team workspace opens SWM tab', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickLayer(seed.contextGraphName, 'swm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('SWM'))).toBe(true);
  });

  test('clicking verified assets opens VM tab', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickLayer(seed.contextGraphName, 'vm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('VM'))).toBe(true);
  });

  test('Context Oracle mode shows coming soon placeholder', async ({ leftPanel }) => {
    await leftPanel.switchToMode('oracle');
    await expect(leftPanel.oraclePlaceholder).toBeVisible();
    const text = await leftPanel.oraclePlaceholder.textContent();
    expect(text).toContain('coming soon');
  });

  test('expanding a project toggles chevron open class', async ({ page, leftPanel, seed }) => {
    const chevron = page.locator('.v10-tree-section').filter({ hasText: seed.contextGraphName }).locator('.v10-tree-chevron');
    expect(await chevron.evaluate((el: Element) => el.classList.contains('open'))).toBe(false);
    await leftPanel.expandProject(seed.contextGraphName);
    expect(await chevron.evaluate((el: Element) => el.classList.contains('open'))).toBe(true);
  });

  test('collapsing a project removes chevron open class', async ({ page, leftPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    const chevron = page.locator('.v10-tree-section').filter({ hasText: seed.contextGraphName }).locator('.v10-tree-chevron');
    expect(await chevron.evaluate((el: Element) => el.classList.contains('open'))).toBe(true);
    await leftPanel.expandProject(seed.contextGraphName);
    expect(await chevron.evaluate((el: Element) => el.classList.contains('open'))).toBe(false);
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

  test('collapse button hides left panel', async ({ leftPanel, shell }) => {
    await leftPanel.collapse();
    await expect(shell.leftPanel).toBeHidden();
  });

  test('clicking Dashboard row switches to dashboard view', async ({ leftPanel, centerPanel, seed }) => {
    await leftPanel.expandProject(seed.contextGraphName);
    await leftPanel.clickDashboard();
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('clicking Memory Stack opens Memory Stack tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.clickMemoryStack();
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Memory Stack');
  });

  test('Join Project button opens the JoinProjectModal', async ({ leftPanel, joinProjectModal }) => {
    await leftPanel.clickJoinProject();
    expect(await joinProjectModal.isOpen()).toBe(true);
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

  test('participating ⤑ toggle keeps the project in the tree', async ({ leftPanel, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.toggleParticipating(seed.contextGraphName);
    const names = await leftPanel.getProjectNames();
    expect(names).toContain(seed.contextGraphName);
  });
});
