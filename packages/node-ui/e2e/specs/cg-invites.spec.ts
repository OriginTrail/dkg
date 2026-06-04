import { test, expect } from '../fixtures/rich.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

test.describe('Context graph invites — share modal', () => {
  test.beforeEach(async ({ shell, leftPanel, projectLayer }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await projectLayer.clickShare();
  });

  test('share modal shows invite code section', async ({ shareProjectModal }) => {
    expect(await shareProjectModal.hasInviteSection()).toBe(true);
  });

  test('share modal lists allowed agents section', async ({ shareProjectModal }) => {
    expect(await shareProjectModal.hasAllowedAgentsSection()).toBe(true);
  });

  test('share modal shows pending join requests section', async ({ shareProjectModal }) => {
    await shareProjectModal.openJoinRequestsTab();
    expect(await shareProjectModal.hasPendingRequestsSection()).toBe(true);
  });

  test('done button closes share modal', async ({ shareProjectModal }) => {
    await shareProjectModal.close();
    expect(await shareProjectModal.isOpen()).toBe(false);
  });

  // Regression for #959: the Share modal only had backdrop-click + a footer
  // Done button — Esc did nothing and it wasn't focus-trapped. It now uses
  // the shared `useModalDismiss` hook (Esc-to-close) and has a header ×.
  test('Escape key closes share modal (#959)', async ({ shareProjectModal, page }) => {
    await expect(shareProjectModal.overlay).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(shareProjectModal.overlay).toBeHidden();
  });

  test('header × button closes share modal (#959)', async ({ shareProjectModal }) => {
    await expect(shareProjectModal.overlay).toBeVisible();
    // Scope to the modal overlay — a bare `.v10-modal-close` is global and
    // would match any other dialog/popover present on the page (Codex review).
    await shareProjectModal.overlay.locator('.v10-modal-close').click();
    await expect(shareProjectModal.overlay).toBeHidden();
  });
});

test.describe('Context graph invites — overview panel', () => {
  test('overview shows pending join requests card', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    const joinSection = page.locator('[data-section="join-requests"]');
    await expect(joinSection.locator('.v10-po-section-title')).toHaveText('Pending join requests');
    await expect(joinSection.getByText(/No pending join requests/i)).toBeVisible();
  });

  test('participant agents section lists curator and allowlisted agents', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await expect(page.locator('.v10-po-section-title').filter({ hasText: 'Participant agents' })).toBeVisible();
    await expect(page.getByText(/Curator|·curator/)).toBeVisible({ timeout: 15_000 });
  });
});
