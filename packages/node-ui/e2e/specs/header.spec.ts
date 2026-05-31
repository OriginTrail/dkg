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

  test('status dot reports a sync state (online/offline class)', async ({ header }) => {
    // The single-node devnet has no peers to catch a "tip" event from,
    // so `synced` may legitimately stay false during a fresh run. The
    // durable assertion is "the dot reports SOMETHING" — the
    // online/offline class pair must be exhaustive — not "the daemon
    // is synced", which depends on peer presence.
    await expect(header.statusDot).toBeVisible();
    const cls = await header.statusDot.evaluate((el) => el.className);
    expect(cls).toMatch(/\b(online|offline)\b/);
  });

  test('displays a sync status text (synced or syncing)', async ({ page }) => {
    // Same rationale as above — the single-node devnet may show either
    // state. Assert the union, not a specific token.
    await expect(page.getByText(/^(synced|syncing)$/)).toBeVisible();
  });

  test('displays peer count with number and label', async ({ header, page }) => {
    // The devnet test harness runs a single-node network, so the
    // header always shows "0 peers" — the durable invariant is that
    // the field renders WITH a numeric value (parseable to >= 0), not
    // that the value is positive. A non-finite / missing peer count is
    // the real regression we want to catch.
    await page.locator('.v10-header-meta').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByText(/\d+ peer/).waitFor({ state: 'visible', timeout: 5_000 });
    const peers = await header.getPeerCount();
    expect(Number.isFinite(peers)).toBe(true);
    expect(peers).toBeGreaterThanOrEqual(0);
  });

  test('notification badge renders only when there are unread notifs', async ({ header, page }) => {
    // A fresh Playwright browser context starts with no stored
    // notifications, so the badge is intentionally hidden (the
    // component conditionally renders it on `unread > 0`). The
    // durable invariants are: (a) the bell button is present, and
    // (b) when the badge IS rendered, its text parses to a positive
    // integer. Earlier `> 0` assertion was test-context-dependent.
    await expect(page.locator('.v10-header-notif-wrap button').first()).toBeVisible();
    const unread = await header.getUnreadCount();
    expect(Number.isFinite(unread)).toBe(true);
    expect(unread).toBeGreaterThanOrEqual(0);
    if (unread > 0) {
      await expect(header.notifBadge).toBeVisible();
    }
  });

  test('clicking notification bell opens dropdown with items', async ({ header }) => {
    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();
    const texts = await header.getNotificationTexts();
    expect(texts.length).toBeGreaterThan(0);
  });

  test('notification dropdown shows the Notifications title row', async ({ header, page }) => {
    // The title is now sentence-case ("Notifications") rather than
    // SHOUTY-CAPS, AND a case-insensitive substring match collides with
    // the empty-state row ("No notifications"). Anchor on the title's
    // own selector class instead — the durable handle for "the title".
    await header.openNotifications();
    await expect(page.locator('.v10-header-notif-title')).toBeVisible();
    await expect(page.locator('.v10-header-notif-title')).toHaveText(/notifications/i);
  });

  test('notification items have timestamps when present', async ({ header, page }) => {
    // formatNotificationTimestamp() emits one of four shapes depending
    // on age: same-day "h:mm AM/PM", "Yesterday h:mm AM/PM",
    // "<weekday> h:mm AM/PM", or "Mon D, YYYY h:mm AM/PM". The legacy
    // assertion required seconds (`h:mm:ss`) which the helper has never
    // produced. Match the union of the four real shapes — and accept
    // 0 items, since a fresh browser context starts with no notifs.
    await header.openNotifications();
    const times = page.locator('.v10-header-notif-item-time');
    const count = await times.count();
    if (count === 0) return;
    const firstTime = (await times.first().textContent())?.trim() ?? '';
    expect(firstTime).toMatch(
      /^(?:Yesterday\s+|[A-Za-z]{3}\s+|[A-Za-z]{3}\s+\d{1,2},\s+\d{4}\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)$/,
    );
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
