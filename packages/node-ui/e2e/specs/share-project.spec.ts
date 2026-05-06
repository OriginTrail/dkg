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
    // Anchor to body-only copy: "Agents who submitted a signed request to
    // join this project." The previous regex `/join requests/i` *also*
    // matched the **tab label itself** ("Join Requests") which is always
    // visible — so the test passed even if the body never swapped.
    await expect(page.getByText(/Agents who submitted a signed request/i)).toBeVisible();
    // And one of: the empty marker or at least one approve/reject row.
    const empty = page.getByText('No pending join requests.', { exact: true });
    const approveBtn = page.getByRole('button', { name: 'Approve', exact: true });
    const someBranch = await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false),
      approveBtn.first().waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false),
    ]);
    expect(someBranch).toBe(true);
  });

  test('Done button closes the modal', async ({ shareProjectModal }) => {
    await shareProjectModal.close();
    await expect(shareProjectModal.box).toBeHidden();
  });
});
