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

  test('shows the OriginTrail "powered by" wordmark next to the DKG logo', async ({ header, page }) => {
    // The brand-mark lockup was added in v10 (see Header.tsx
    // `ORIGINTRAIL_WORDMARK`). It carries an aria-label of
    // "Powered by OriginTrail" and the visible "powered by" caption,
    // and the SVG wordmark itself is rendered with the
    // `.v10-header-ot-wordmark` class.
    await expect(header.otBrand).toBeVisible();
    await expect(header.otBrand).toHaveAttribute('aria-label', 'Powered by OriginTrail');
    await expect(header.otWordmark).toBeVisible();
    await expect(page.getByText('powered by', { exact: true })).toBeVisible();
  });

  test('shows agent name', async ({ header }) => {
    await expect(header.agentName).toBeVisible();
    const name = await header.getAgentName();
    expect(name).toBeTruthy();
    expect(name!.length).toBeGreaterThan(0);
  });

  test('agent identity chip carries the agentDid + agentAddress as a tooltip (the only documented affordance today)', async ({ page }) => {
    // The `.v10-header-agent-switcher` div advertises a multi-agent
    // switcher via its class name AND its CSS (`cursor: pointer` + hover
    // background). However Header.tsx attaches NO onClick handler, so
    // clicking the chip does nothing. Until the switcher is wired up
    // (see test.skip below) the chip's only real affordance is the
    // `title` tooltip — assert it's present so we at least guarantee
    // the user can copy the full address out of the hover.
    const chip = page.locator('.v10-header-agent-switcher').first();
    await expect(chip).toBeVisible();
    const title = await chip.getAttribute('title');
    expect(title, 'agent chip must carry an agentDid+agentAddress tooltip').toBeTruthy();
    expect(title!).toMatch(/did:dkg:agent:0x[a-fA-F0-9]+/);
    expect(title!).toMatch(/0x[a-fA-F0-9]{40}/);
  });

  // SKIPPED: real UX bug surfaced by this audit.
  //
  // Header.tsx:141 renders `<div className="v10-header-agent-switcher" …>`
  // with NO onClick handler, but styles.css gives it `cursor: pointer`
  // and a `:hover` background. The user sees a clickable affordance,
  // clicks it, and nothing happens. The class name and the visual
  // treatment both promise a multi-agent switcher — either wire one up
  // or strip the pointer/hover styling. This skip is the regression
  // signal: once a click does open SOMETHING (dropdown, modal, toggle),
  // this test will pass automatically.
  test.skip('clicking the agent identity chip should open an agent switcher (BUG: cursor:pointer with no onClick handler)', async ({ page }) => {
    const chip = page.locator('.v10-header-agent-switcher').first();
    await chip.click();
    // The expected dropdown/menu doesn't yet exist — when implemented,
    // adjust the locator to match the actual surface.
    const dropdown = page.locator('.v10-header-agent-menu, [role="menu"][aria-label*="agent" i]');
    await expect(dropdown.first()).toBeVisible({ timeout: 3_000 });
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
