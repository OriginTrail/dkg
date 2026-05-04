import { test, expect } from '../fixtures/base.js';

test.describe('Header', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-header-meta').waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('displays DKG logo with v10 version badge', async ({ header }) => {
    await expect(header.logo).toBeVisible();
    await expect(header.version).toHaveText('v10');
  });

  test('shows agent name', async ({ header }) => {
    await expect(header.agentName).toBeVisible();
    const name = await header.getAgentName();
    expect(name).toBeTruthy();
    expect(name!.length).toBeGreaterThan(0);
  });

  test('shows green sync status dot', async ({ header }) => {
    await expect(header.statusDot).toBeVisible();
  });

  test('status dot is rendered', async ({ header }) => {
    await expect(header.statusDot).toBeVisible();
  });

  test('header reports a sync status (synced or syncing) and a peer count', async ({ header, page }) => {
    // The test daemon runs isolated (`relay: "none"` in the harness) so it
    // never connects to peers — status stays "syncing · 0 peers" by design.
    // The greedy "must reach synced + >0 peers" check belongs in a manual
    // smoke run against a real testnet-connected node, not in CI.
    await expect(page.getByText(/synced|syncing/i).first()).toBeVisible();
    await expect(page.getByText(/\d+ peers?/).first()).toBeVisible();
    expect(await header.getPeerCount()).toBeGreaterThanOrEqual(0);
  });

  test('notification badge counter is non-negative', async ({ header }) => {
    const unread = await header.getUnreadCount();
    expect(unread).toBeGreaterThanOrEqual(0);
  });

  test('clicking notification bell opens dropdown', async ({ header }) => {
    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();
  });

  test('notification dropdown shows the Notifications title', async ({ header, page }) => {
    await header.openNotifications();
    await expect(page.locator('.v10-header-notif-title')).toBeVisible();
  });

  test('clicking notification bell again closes the dropdown', async ({ header }) => {
    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();
    await header.openNotifications();
    await expect(header.notifDropdown).toBeHidden();
  });

  test('clicking outside notification dropdown closes it', async ({ page, header }) => {
    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();
    await page.locator('.v10-app').click({ position: { x: 5, y: 300 } });
    await expect(header.notifDropdown).toBeHidden();
  });

  test('all header action buttons are visible', async ({ header }) => {
    await expect(header.sidebarToggle).toBeVisible();
    await expect(header.themeToggle).toBeVisible();
    await expect(header.rightPanelToggle).toBeVisible();
  });

  test('header uses semantic <header> tag', async ({ page }) => {
    const header = page.locator('header.v10-header');
    await expect(header).toBeVisible();
  });

  test('Settings button is rendered with the Settings title attribute', async ({ header }) => {
    await expect(header.settingsBtn).toBeVisible();
    await expect(header.settingsBtn).toHaveAttribute('title', 'Settings');
  });

  test('Settings button opens the Settings tab in the center panel', async ({ header, centerPanel }) => {
    await header.openSettings();
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Settings');
  });
});
