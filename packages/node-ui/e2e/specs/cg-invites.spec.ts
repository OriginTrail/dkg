import { test, expect } from '../fixtures/rich.js';

test.describe('Context graph invites — share modal', () => {
  test.beforeEach(async ({ shell, leftPanel, projectLayer }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
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
});

test.describe('Context graph invites — overview panel', () => {
  test('overview shows pending join requests card', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    const joinSection = page.locator('[data-section="join-requests"]');
    await expect(joinSection.locator('.v10-po-section-title')).toHaveText('Pending join requests');
    await expect(joinSection.getByText(/No pending join requests/i)).toBeVisible();
  });

  test('participant agents section lists curator and allowlisted agents', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject('Pharma Drug Interactions');
    await expect(page.locator('.v10-po-section-title').filter({ hasText: 'Participant agents' })).toBeVisible();
    await expect(page.getByText(/Curator|·curator/)).toBeVisible({ timeout: 15_000 });
  });
});
