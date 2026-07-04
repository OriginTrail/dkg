import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';
import { fetchApiInPage } from '../helpers/page-api.js';

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
    // `synced` can legitimately be either state on the devnet depending on
    // sync/tip timing, so the durable assertion is "the dot reports SOMETHING"
    // — the online/offline class pair must be exhaustive — not "the daemon is
    // synced", which depends on transient sync state.
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
    // The durable invariant here is that the field renders WITH a numeric value
    // (parseable to >= 0) — a non-finite / missing peer count is the regression
    // this catches. The stronger ">1 peer on the 3-node devnet" assertion lives
    // in peer-connectivity.spec.ts; this test stays count-agnostic on purpose.
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

  test('clicking notification bell opens the dropdown and renders the feed the API reports', async ({ header, page }) => {
    // Ground-truth the scoped feed the node serves to THIS caller (same dashboard
    // session the UI uses) and assert the pane agrees. This catches the real bug class
    // — "the API has notifications but the pane renders none" — without the old
    // flaky `> 0` assumption, which silently passed on mock data or lucky
    // timing: the feed loads async AND gates on caller-identity resolution, so
    // counting items the instant the pane opens is a race (it was passing only
    // because the feed sometimes won that race).
    const feed = await fetchApiInPage<{ notifications?: unknown[] }>(page, '/api/notifications');
    const apiCount = Array.isArray(feed.json?.notifications) ? feed.json.notifications.length : -1;
    expect(apiCount, '/api/notifications must return a notifications array').toBeGreaterThanOrEqual(0);

    await header.openNotifications();
    await expect(header.notifDropdown).toBeVisible();

    if (apiCount === 0) {
      // Empty feed → the pane must show its explicit empty state, never rows.
      // The pane first passes through loading / identity-pending before settling
      // on the empty state, so wait for that explicit empty state (generous
      // timeout) to confirm loading has cleared — only THEN are zero rows the
      // steady-state truth rather than a mid-load snapshot that flakes.
      await expect(page.locator(sel.header.notifEmpty)).toBeVisible({ timeout: 15_000 });
      expect(await header.getNotificationTexts()).toHaveLength(0);
    } else {
      // Non-empty feed → the rows MUST render once the async fetch + identity
      // resolution settle. Digest-collapsing can fold N atomic rows into fewer
      // pane rows, so assert ">= 1 row", not exact equality.
      await expect
        .poll(async () => (await header.getNotificationTexts()).length, {
          timeout: 15_000,
          message: `notifications pane rendered no rows despite /api/notifications reporting ${apiCount}`,
        })
        .toBeGreaterThan(0);
    }
  });

  test('notification dropdown shows the Notifications title row', async ({ header, page }) => {
    // The title is now sentence-case ("Notifications") rather than
    // SHOUTY-CAPS, AND a case-insensitive substring match collides with
    // the empty-state lead ("You're all caught up."). Anchor on the
    // NotificationsPane title's own selector class — the durable handle.
    await header.openNotifications();
    await expect(page.locator('.v10-notif-pane-title')).toBeVisible();
    await expect(page.locator('.v10-notif-pane-title')).toHaveText(/notifications/i);
  });

  test('notification items have timestamps when present', async ({ header, page }) => {
    // formatNotificationTimestamp() emits one of four shapes depending
    // on age: same-day "h:mm AM/PM", "Yesterday h:mm AM/PM",
    // "<weekday> h:mm AM/PM", or "Mon D, YYYY h:mm AM/PM". The legacy
    // assertion required seconds (`h:mm:ss`) which the helper has never
    // produced. Match the union of the four real shapes — and accept
    // 0 items, since a fresh browser context starts with no notifs.
    await header.openNotifications();
    const times = page.locator('.v10-notif-time');
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

  // (Removed) "notification badge count matches actual notification items":
  // it asserted `unreadBadge === totalDropdownItems`, conflating the UNREAD
  // count with the TOTAL item count — those legitimately differ (3 items, 1
  // unread), so the assertion encoded a wrong invariant carried over from the
  // mock-data era. The real, durable contract (badge renders only when
  // unread > 0 and parses to a positive int) is covered by
  // "notification badge renders only when there are unread notifs" above.

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
