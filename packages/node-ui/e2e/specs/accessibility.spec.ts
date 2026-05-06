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

  test('modal inputs have form labels covering Name and Description', async ({ dashboard, createProjectModal, page }) => {
    await dashboard.clickQuickAction('Create Project');
    await expect(createProjectModal.overlay).toBeVisible();
    // Earlier: `expect(await labels.count()).toBeGreaterThan(0)` — passed
    // even with a single empty label and no association to inputs. Pin
    // to the specific labels users need to fill the form.
    const labels = page.locator(sel.modal.formLabel);
    const texts = await labels.allTextContents();
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringMatching(/Name/i),
      expect.stringMatching(/Description/i),
    ]));
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
    // Previously asserted just `tag matches /button|input|a/` — almost any
    // focusable element passes that. Tighten to: the next focused element
    // is still inside the header (i.e. the user is cycling through the
    // header chrome, not falling off into invisible / off-screen tabbables).
    const focusInHeader = await page.evaluate(() =>
      document.activeElement
        ? !!document.activeElement.closest('header.v10-header')
        : false,
    );
    expect(focusInHeader).toBe(true);
  });

  test('focused buttons render a visible focus ring', async ({ page }) => {
    // Earlier: asserted `tag === 'button'` after `.focus()` on a button
    // — purely tautological (focusing a button keeps activeElement a
    // button). The real a11y contract is whether keyboard users can
    // SEE which button is focused. Assert a non-zero outline width
    // on the focused button (mirrors keyboard-focus.spec.ts:60).
    const buttons = page.locator('button:visible');
    expect(await buttons.count()).toBeGreaterThan(0);
    const first = buttons.first();
    await first.focus();
    const outlineWidth = await first.evaluate((el) =>
      getComputedStyle(el as HTMLElement).outlineWidth,
    );
    expect(parseFloat(outlineWidth)).toBeGreaterThan(0);
  });

  test('notification dropdown is keyboard accessible', async ({ header, page }) => {
    const notifBtn = page.locator('.v10-header-notif-wrap button').first();
    await notifBtn.focus();
    await notifBtn.press('Enter');
    await expect(header.notifDropdown).toBeVisible();
  });

  test('create project modal name input has a meaningful placeholder', async ({ dashboard, createProjectModal }) => {
    await dashboard.clickQuickAction('Create Project');
    // Previously: just `length > 0` — any non-empty string passed,
    // including a regression to "x" or "TODO". Anchor on the project's
    // example-placeholder convention ("e.g. ..."), which proves the
    // hint is shaped to guide the user, not just a non-empty fallback.
    await expect(createProjectModal.nameInput).toHaveAttribute('placeholder', /e\.g\./i);
    const placeholder = await createProjectModal.nameInput.getAttribute('placeholder');
    expect((placeholder ?? '').length).toBeGreaterThan(10);
  });

  test('dashboard heading hierarchy is correct', async ({ page }) => {
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    const h3s = page.getByRole('heading', { level: 3 });
    expect(await h3s.count()).toBeGreaterThan(0);
  });
});
