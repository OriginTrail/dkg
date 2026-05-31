import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('Ctrl+B toggles left panel visibility', async ({ page, shell }) => {
    await expect(shell.leftPanel).toBeVisible();
    await page.keyboard.press('Control+b');
    await expect(shell.leftPanel).toBeHidden();
    await page.keyboard.press('Control+b');
    await expect(shell.leftPanel).toBeVisible();
  });

  test('Ctrl+J toggles bottom panel', async ({ page, bottomPanel }) => {
    expect(await bottomPanel.isCollapsed()).toBe(true);
    await page.keyboard.press('Control+j');
    expect(await bottomPanel.isCollapsed()).toBe(false);
    await page.keyboard.press('Control+j');
    expect(await bottomPanel.isCollapsed()).toBe(true);
  });

  test('Ctrl+Shift+B toggles right panel', async ({ page }) => {
    const rightPanel = page.locator(sel.rightPanel.root).first();
    await expect(rightPanel).toBeVisible();
    await page.keyboard.press('Control+Shift+b');
    await expect(rightPanel).toBeHidden();
    await page.keyboard.press('Control+Shift+b');
    await expect(rightPanel).toBeVisible();
  });

  test('shortcuts are suppressed when text input is focused', async ({ page, bottomPanel }) => {
    await bottomPanel.toggle();
    await bottomPanel.switchTab('Node Log');
    const logFilter = page.locator(sel.bottom.logFilter).first();
    await logFilter.waitFor({ state: 'visible' });
    await logFilter.focus();
    const collapsed = await bottomPanel.isCollapsed();
    await page.keyboard.press('Control+j');
    expect(await bottomPanel.isCollapsed()).toBe(collapsed);
  });

  test('shortcuts are suppressed when textarea is focused', async ({ page, leftPanel, createProjectModal }) => {
    await page.route('**/api/agent/identity', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agentAddress: '0x1111111111111111111111111111111111111111' }),
      }),
    );
    await leftPanel.clickNewProject();
    await expect(createProjectModal.overlay).toBeVisible();
    await createProjectModal.descriptionInput.focus();
    const leftPanelEl = page.locator(sel.leftPanel.root).first();
    const wasVisible = await leftPanelEl.isVisible();
    await page.keyboard.press('Control+b');
    expect(await leftPanelEl.isVisible()).toBe(wasVisible);
  });
});
