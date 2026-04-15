import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Left Panel Navigation', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-tree-section').first().waitFor({ state: 'visible', timeout: 10_000 });
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

  test('three projects are listed with badges', async ({ leftPanel }) => {
    const names = await leftPanel.getProjectNames();
    expect(names).toContain('Pharma Drug Interactions');
    expect(names).toContain('Climate Science');
    expect(names).toContain('EU Supply Chain');
    expect(names.length).toBe(3);
  });

  test('project badge shows asset count', async ({ leftPanel }) => {
    const badge = leftPanel.root.locator(sel.leftPanel.section)
      .filter({ hasText: 'Pharma Drug Interactions' })
      .locator(sel.leftPanel.sectionBadge);
    await expect(badge).toHaveText('227');
  });

  test('expanding a project reveals memory layer items', async ({ leftPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const section = leftPanel.root.locator(sel.leftPanel.section).filter({ hasText: 'Pharma Drug Interactions' });

    const layerHeaders = section.locator(sel.leftPanel.layerHeader);
    const count = await layerHeaders.count();
    expect(count).toBe(3);

    const items = section.locator(sel.leftPanel.treeItem);
    await expect(items.first()).toBeVisible();
  });

  test('expanded project shows Working, Shared, and Verified memory sections', async ({ page, leftPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const content = page.locator(sel.leftPanel.root).first();
    await expect(content.getByText('WORKING MEMORY')).toBeVisible();
    await expect(content.getByText('SHARED MEMORY')).toBeVisible();
    await expect(content.getByText('VERIFIED MEMORY')).toBeVisible();
  });

  test('working memory section contains agent drafts and import link', async ({ page, leftPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    const section = page.locator(sel.leftPanel.root).first();
    await expect(section.getByText('agent drafts')).toBeVisible();
    await expect(section.getByText('Import files…')).toBeVisible();
  });

  test('clicking agent drafts opens WM tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'wm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('WM'))).toBe(true);
  });

  test('clicking Import files link opens import modal', async ({ leftPanel, importFilesModal }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickLayer('Pharma Drug Interactions', 'import');
    expect(await importFilesModal.isOpen()).toBe(true);
  });

  test('clicking team workspace opens SWM tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Climate Science');
    await leftPanel.clickLayer('Climate Science', 'swm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('SWM'))).toBe(true);
  });

  test('clicking verified assets opens VM tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('EU Supply Chain');
    await leftPanel.clickLayer('EU Supply Chain', 'vm');
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some(t => t.includes('VM'))).toBe(true);
  });

  test('Context Oracle mode shows coming soon placeholder', async ({ leftPanel }) => {
    await leftPanel.switchToMode('oracle');
    await expect(leftPanel.oraclePlaceholder).toBeVisible();
    const text = await leftPanel.oraclePlaceholder.textContent();
    expect(text).toContain('coming soon');
  });

  test('expanding a project toggles chevron open class', async ({ page, leftPanel }) => {
    const chevron = page.locator('.v10-tree-section').filter({ hasText: 'EU Supply Chain' }).locator('.v10-tree-chevron');
    const wasClosed = !(await chevron.evaluate((el: Element) => el.classList.contains('open')));
    expect(wasClosed).toBe(true);
    await leftPanel.expandProject('EU Supply Chain');
    const isOpen = await chevron.evaluate((el: Element) => el.classList.contains('open'));
    expect(isOpen).toBe(true);
  });

  test('collapsing a project removes chevron open class', async ({ page, leftPanel }) => {
    await leftPanel.expandProject('EU Supply Chain');
    const chevron = page.locator('.v10-tree-section').filter({ hasText: 'EU Supply Chain' }).locator('.v10-tree-chevron');
    expect(await chevron.evaluate((el: Element) => el.classList.contains('open'))).toBe(true);
    await leftPanel.expandProject('EU Supply Chain');
    expect(await chevron.evaluate((el: Element) => el.classList.contains('open'))).toBe(false);
  });

  test('multiple projects can be expanded simultaneously', async ({ page, leftPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.expandProject('Climate Science');
    const pharmaItems = page.locator('.v10-tree-section').filter({ hasText: 'Pharma Drug Interactions' }).locator('.v10-tree-item');
    const climateItems = page.locator('.v10-tree-section').filter({ hasText: 'Climate Science' }).locator('.v10-tree-item');
    expect(await pharmaItems.count()).toBeGreaterThan(0);
    expect(await climateItems.count()).toBeGreaterThan(0);
  });

  test('switching back to Projects mode restores tree', async ({ leftPanel }) => {
    await leftPanel.switchToMode('oracle');
    await leftPanel.switchToMode('explorer');
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBe(3);
  });

  test('+ New Project button opens create project modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });

  test('collapse button hides left panel', async ({ leftPanel, shell }) => {
    await leftPanel.collapse();
    await expect(shell.leftPanel).toBeHidden();
  });

  test('clicking Dashboard row switches to dashboard view', async ({ leftPanel, centerPanel }) => {
    await leftPanel.expandProject('Pharma Drug Interactions');
    await leftPanel.clickDashboard();
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('clicking Memory Stack opens Memory Stack tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.clickMemoryStack();
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Memory Stack');
  });
});
