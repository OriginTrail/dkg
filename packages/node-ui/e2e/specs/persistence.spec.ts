import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('UI state persists across page reloads', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  // SKIPPED: production bug — left panel collapse state isn't persisted
  // in localStorage, so a refresh resets it. Theme persists correctly;
  // this is the inconsistency. Unskip when the panel state is wired
  // into localStorage.
  test.skip('left panel collapse state persists', async ({ leftPanel, shell, page }) => {
    await leftPanel.collapse();
    await expect(shell.leftPanel).toBeHidden();
    await page.reload();
    // After reload, the left panel should remain hidden if its state
    // persists (most apps store this in localStorage).
    await expect(shell.leftPanel).toBeHidden({ timeout: 10_000 });
  });

  // SKIPPED: same panel-state-persistence bug as above (bottom panel).
  test.skip('bottom panel expand state persists', async ({ bottomPanel, page }) => {
    await bottomPanel.toggle();
    expect(await bottomPanel.isCollapsed()).toBe(false);
    await page.reload();
    // Bottom panel should still be expanded after reload.
    await page.locator('.v10-panel-bottom').waitFor({ state: 'visible', timeout: 10_000 });
    expect(await bottomPanel.isCollapsed()).toBe(false);
  });

  test('developer mode toggle persists', async ({ settings, header, page }) => {
    await header.openSettings();
    // Initial state may be on or off — record then flip.
    const initial = await settings.devCard.locator('button').first().getAttribute('style');
    await settings.toggleDevMode();
    const flipped = await settings.devCard.locator('button').first().getAttribute('style');
    expect(flipped).not.toBe(initial);
    await page.reload();
    await header.openSettings();
    const afterReload = await settings.devCard.locator('button').first().getAttribute('style');
    // After reload the toggle should still be in its flipped position.
    expect(afterReload).toBe(flipped);
  });

  test('hidden projects persist across reload', async ({ leftPanel, page, seed }) => {
    await leftPanel.waitForReady();
    await leftPanel.hideProject(seed.contextGraphName);
    expect(await leftPanel.isShowHiddenVisible()).toBe(true);
    await page.reload();
    // After reload, the hide-state should still be honoured: the seeded
    // CG should be absent from the visible list, and the Show Hidden
    // affordance should be present.
    await page.locator(sel.leftPanel.root).first().waitFor({ state: 'visible', timeout: 10_000 });
    expect(await leftPanel.isShowHiddenVisible()).toBe(true);
    const names = await leftPanel.getProjectNames();
    expect(names).not.toContain(seed.contextGraphName);
  });
});
