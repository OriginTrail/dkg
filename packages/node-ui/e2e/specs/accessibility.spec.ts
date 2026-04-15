import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Accessibility', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('header buttons have descriptive title attributes', async ({ page }) => {
    await expect(page.locator(sel.header.sidebarToggle)).toHaveAttribute('title', 'Toggle sidebar');
    await expect(page.locator(sel.header.rightPanelToggle)).toHaveAttribute('title', 'Toggle agent panel');
    const themeTitle = await page.locator(sel.header.themeToggle).getAttribute('title');
    expect(themeTitle).toBeTruthy();
    expect(themeTitle).toMatch(/Switch to (light|dark) mode/);
  });

  test('header element uses semantic <header> tag', async ({ page }) => {
    const header = page.locator('header.v10-header');
    await expect(header).toBeVisible();
  });

  test('log filter input has placeholder text', async ({ page, bottomPanel }) => {
    await bottomPanel.toggle();
    const logFilter = page.locator(sel.bottom.logFilter);
    await expect(logFilter).toHaveAttribute('placeholder', 'Filter logs...');
  });

  test('modal inputs have form labels', async ({ dashboard, createProjectModal, page }) => {
    await dashboard.clickQuickAction('Create Project');
    await expect(createProjectModal.overlay).toBeVisible();
    const labels = page.locator(sel.modal.formLabel);
    expect(await labels.count()).toBeGreaterThan(0);
  });

  test('modal overlay uses fixed positioning', async ({ dashboard, createProjectModal, page }) => {
    await dashboard.clickQuickAction('Create Project');
    await expect(createProjectModal.overlay).toBeVisible();
    const style = await page.locator(sel.modal.overlay).evaluate(el => {
      return window.getComputedStyle(el).position;
    });
    expect(style).toBe('fixed');
  });

  test('keyboard Tab cycles through header controls', async ({ page }) => {
    await page.locator(sel.header.sidebarToggle).focus();
    await page.keyboard.press('Tab');
    const tag = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
    expect(tag).toMatch(/button|input|a/);
  });

  test('buttons are focusable via keyboard', async ({ page }) => {
    const buttons = page.locator('button:visible');
    expect(await buttons.count()).toBeGreaterThan(0);
    await buttons.first().focus();
    const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
    expect(focused).toBe('button');
  });

  test('notification dropdown is keyboard accessible', async ({ header, page }) => {
    const notifBtn = page.locator('.v10-header-notif-wrap button').first();
    await notifBtn.focus();
    await notifBtn.press('Enter');
    await expect(header.notifDropdown).toBeVisible();
  });

  test('create project modal name input has placeholder', async ({ dashboard, createProjectModal }) => {
    await dashboard.clickQuickAction('Create Project');
    const placeholder = await createProjectModal.nameInput.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder!.length).toBeGreaterThan(0);
  });

  test('dashboard heading hierarchy is correct', async ({ page }) => {
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    const h3s = page.getByRole('heading', { level: 3 });
    expect(await h3s.count()).toBeGreaterThan(0);
  });
});
