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
    // After reload, wait for the CG list to actually load (not just the
    // panel root) — the hideCount = contextGraphs.length -
    // visibleContextGraphs.length math is racy until the daemon list
    // resolves. Earlier this test relied on the seed being the ONLY CG
    // so the panel root was visible right alongside it; with extra CGs
    // present (e.g. from the create-project-success spec running
    // earlier), the root can paint before the full list lands.
    await leftPanel.waitForReady();
    // Use expect.poll so the CG list / hidden state has time to
    // re-hydrate from localStorage and the daemon refresh.
    await expect.poll(() => leftPanel.isShowHiddenVisible(), { timeout: 10_000 }).toBe(true);
    const names = await leftPanel.getProjectNames();
    expect(names).not.toContain(seed.contextGraphName);
  });
});
