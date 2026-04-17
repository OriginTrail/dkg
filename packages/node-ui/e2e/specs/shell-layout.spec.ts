import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Shell Layout', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('renders default four-panel layout with header', async ({ page, shell, header }) => {
    await expect(shell.root).toBeVisible();
    await expect(header.root).toBeVisible();
    await expect(shell.leftPanel).toBeVisible();
    await expect(page.locator(sel.center.root)).toBeVisible();
    await expect(page.locator(sel.bottom.root)).toBeVisible();
    await expect(page.locator(sel.rightPanel.root).first()).toBeVisible();
  });

  test('header sidebar toggle collapses left panel', async ({ header, shell }) => {
    await expect(shell.leftPanel).toBeVisible();
    await header.toggleSidebar();
    await expect(shell.leftPanel).toBeHidden();
  });

  test('header sidebar toggle re-expands left panel', async ({ header, shell }) => {
    await header.toggleSidebar();
    await expect(shell.leftPanel).toBeHidden();
    await header.toggleSidebar();
    await expect(shell.leftPanel).toBeVisible();
  });

  test('left panel collapse button hides tree entirely', async ({ leftPanel, shell }) => {
    await leftPanel.collapse();
    await expect(shell.leftPanel).toBeHidden();
  });

  test('header toggle collapses right panel', async ({ header, page }) => {
    const rightPanel = page.locator(sel.rightPanel.root).first();
    await expect(rightPanel).toBeVisible();
    await header.toggleRightPanel();
    await expect(rightPanel).toBeHidden();
  });

  test('header toggle re-expands right panel', async ({ header, page }) => {
    const rightPanel = page.locator(sel.rightPanel.root).first();
    await header.toggleRightPanel();
    await expect(rightPanel).toBeHidden();
    await header.toggleRightPanel();
    await expect(rightPanel).toBeVisible();
  });

  test('bottom panel starts collapsed', async ({ bottomPanel }) => {
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('bottom panel expand/collapse toggle works', async ({ bottomPanel }) => {
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(false);
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('left panel has expected default width', async ({ shell }) => {
    const width = await shell.getLeftPanelWidth();
    expect(width).toBeGreaterThanOrEqual(150);
    expect(width).toBeLessThanOrEqual(300);
  });

  test('two resize handles exist between panels', async ({ page }) => {
    const handles = page.locator(sel.resizeHandle);
    expect(await handles.count()).toBe(2);
    const firstBox = await handles.first().boundingBox();
    expect(firstBox).toBeTruthy();
    expect(firstBox!.height).toBeGreaterThan(100);
  });

  test('right panel has expected default width', async ({ shell }) => {
    const width = await shell.getRightPanelWidth();
    expect(width).toBeGreaterThanOrEqual(200);
    expect(width).toBeLessThanOrEqual(500);
  });

  test('collapsing both panels widens center area', async ({ header, page }) => {
    const centerBefore = await page.locator(sel.center.root).boundingBox();
    await header.toggleSidebar();
    await header.toggleRightPanel();
    const centerAfter = await page.locator(sel.center.root).boundingBox();
    expect(centerAfter!.width).toBeGreaterThan(centerBefore!.width);
  });
});
