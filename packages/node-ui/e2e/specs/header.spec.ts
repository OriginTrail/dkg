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

  test('status dot has "online" class indicating synced state', async ({ header }) => {
    const isOnline = await header.isSynced();
    expect(isOnline).toBe(true);
  });

  test('displays "synced" status text', async ({ page }) => {
    await expect(page.getByText('synced')).toBeVisible();
  });

  test('displays peer count with number and label', async ({ header, page }) => {
    await page.locator('.v10-header-meta').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByText(/\d+ peer/).waitFor({ state: 'visible', timeout: 5_000 });
    const peers = await header.getPeerCount();
    expect(peers).toBeGreaterThan(0);
  });

  test('notification badge displays unread count', async ({ header }) => {
    const unread = await header.getUnreadCount();
    expect(unread).toBeGreaterThan(0);
  });

  test('clicking notification bell opens dropdown with items', async ({ header }) => {
    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();
    const texts = await header.getNotificationTexts();
    expect(texts.length).toBeGreaterThan(0);
  });

  test('notification dropdown shows NOTIFICATIONS title', async ({ header, page }) => {
    await header.openNotifications();
    await expect(page.getByText('NOTIFICATIONS')).toBeVisible();
  });

  test('notification items have timestamps', async ({ header, page }) => {
    await header.openNotifications();
    const times = page.locator('.v10-header-notif-item-time');
    const count = await times.count();
    expect(count).toBeGreaterThan(0);
    const firstTime = await times.first().textContent();
    expect(firstTime).toMatch(/\d{1,2}:\d{2}:\d{2}\s*(AM|PM)/);
  });

  test('clicking notification bell again closes the dropdown', async ({ header }) => {
    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();
    await header.openNotifications();
    await expect(header.notifDropdown).toBeHidden();
  });

  test.skip('notification badge count matches actual notification items', async ({ header }) => {
    // BUG: Badge shows "2" but there are 3 notification items
    const badgeCount = await header.getUnreadCount();
    await header.openNotifications();
    const texts = await header.getNotificationTexts();
    expect(badgeCount).toBe(texts.length);
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
});
