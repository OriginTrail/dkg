import { test, expect } from '../fixtures/base.js';

test.describe('Keyboard & focus', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test.describe('Escape closes modals', () => {
    // SKIPPED: production bug — modals don't bind an Escape handler.
    // Clicking the overlay closes them; the keyboard equivalent doesn't.
    // Unskip when the modal components add an Esc-to-close listener.
    test.skip('Escape dismisses CreateProjectModal', async ({ leftPanel, createProjectModal, page }) => {
      await leftPanel.clickNewProject();
      expect(await createProjectModal.isOpen()).toBe(true);
      await page.keyboard.press('Escape');
      await expect(createProjectModal.overlay).toBeHidden();
    });

    // SKIPPED: same Esc-to-close bug as above.
    test.skip('Escape dismisses JoinProjectModal', async ({ leftPanel, joinProjectModal, page }) => {
      await leftPanel.clickJoinProject();
      expect(await joinProjectModal.isOpen()).toBe(true);
      await page.keyboard.press('Escape');
      await expect(joinProjectModal.box).toBeHidden();
    });

    // SKIPPED: same Esc-to-close bug as above.
    test.skip('Escape dismisses ImportFilesModal', async ({ dashboard, importFilesModal, page }) => {
      await dashboard.waitForReady();
      await dashboard.clickQuickAction('Import Memories');
      await expect(importFilesModal.overlay).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(importFilesModal.overlay).toBeHidden();
    });
  });

  test.describe('Enter to submit forms', () => {
    test('Enter inside the Join Project invite textarea triggers Join', async ({ leftPanel, joinProjectModal, page }) => {
      await leftPanel.clickJoinProject();
      // Use a multiaddr without a /p2p/ peer id so the validation path
      // produces a *specific* "missing peer ID" error string. The earlier
      // version of this test accepted ANY `.v10-modal-error` OR a disabled
      // button — but the Cancel button is not disabled, the Join button
      // is briefly disabled while submitting, and a generic error CSS
      // class can be left over from a previous render. That made it
      // possible for the test to pass while Enter never actually
      // routed through to the click handler. Asserting the exact error
      // string proves the form's submit path fired.
      await joinProjectModal.fillInvite('cg:demo\n/ip4/1.2.3.4/tcp/10001');
      await joinProjectModal.joinBtn.focus();
      await page.keyboard.press('Enter');
      await expect(joinProjectModal.error).toContainText('missing peer ID', { timeout: 5_000 });
    });
  });

  test.describe('Focus indicators', () => {
    test('header buttons render a focus outline when Tab-focused', async ({ header, page }) => {
      await header.sidebarToggle.focus();
      const outlineWidth = await header.sidebarToggle.evaluate((el) => {
        return getComputedStyle(el as HTMLElement).outlineWidth;
      });
      // A focused, keyboard-accessible button should have a non-zero
      // outline. If outline is removed without an alternative indicator,
      // keyboard users have no focus signal — that's a real a11y bug.
      expect(parseFloat(outlineWidth)).toBeGreaterThan(0);
    });
  });

  test.describe('Modal focus trap', () => {
    // SKIPPED: production bug — modals don't trap focus. Tab leaks to
    // the page underneath after a few presses. Also missing role="dialog"
    // / aria-modal. Unskip when a focus trap is added (e.g. focus-trap-
    // react, or manual cycle on first/last focusable element).
    test.skip('Tab inside CreateProjectModal stays within the modal box', async ({ leftPanel, createProjectModal, page }) => {
      await leftPanel.clickNewProject();
      await expect(createProjectModal.overlay).toBeVisible();
      // Tab a bunch and check the focused element is always inside the
      // modal-box. A leaked focus (focus on header/sidebar) would
      // indicate the modal isn't trapping focus.
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => {
          const box = document.querySelector('.v10-modal-box');
          return !!(box && document.activeElement && box.contains(document.activeElement));
        });
        expect(inside).toBe(true);
      }
    });
  });
});
