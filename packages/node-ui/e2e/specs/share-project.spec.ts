import { test, expect } from '../fixtures/base.js';

test.describe('ShareProjectModal', () => {
  test.beforeEach(async ({ shell, leftPanel, projectView, page, seed }) => {
    await shell.goto();
    await leftPanel.waitForReady();
    await leftPanel.expandProject(seed.contextGraphName);
    await page.locator('.v10-layer-switcher').first().waitFor({ state: 'visible', timeout: 15_000 });
    await projectView.clickShare();
  });

  test('renders Allowlist and Join Requests tabs', async ({ shareProjectModal }) => {
    await expect(shareProjectModal.allowlistTab).toBeVisible();
    await expect(shareProjectModal.requestsTab).toBeVisible();
  });

  test('Add Agent button is disabled when input is empty', async ({ shareProjectModal }) => {
    await expect(shareProjectModal.addAgentBtn).toBeDisabled();
  });

  test('invalid address surfaces an inline error', async ({ shareProjectModal, page }) => {
    await shareProjectModal.fillAddress('not-an-address');
    await shareProjectModal.clickAdd();
    await expect(page.getByText(/Invalid Ethereum address/)).toBeVisible();
  });

  test('Copy Invite swaps button label to Copied', async ({ shareProjectModal, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await shareProjectModal.clickCopy();
    await expect(shareProjectModal.copyInviteBtn).toHaveText('Copied');
  });

  test('switching to Join Requests tab swaps the body content', async ({ shareProjectModal, page }) => {
    await shareProjectModal.switchToRequests();
    await expect(page.getByText(/No pending join requests|Pending Requests|join requests/i).first()).toBeVisible();
  });

  test('Done button closes the modal', async ({ shareProjectModal }) => {
    await shareProjectModal.close();
    await expect(shareProjectModal.box).toBeHidden();
  });
});
