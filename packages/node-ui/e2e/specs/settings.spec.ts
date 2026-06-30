import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';
import { EXPECTED_NODE_ROLE } from '../helpers/real-node.js';
import { fetchApiInPage } from '../helpers/page-api.js';

/**
 * Settings page (pages/Settings.tsx — rewritten in the rc.12 line). Driven
 * entirely against the live devnet, no mocks. Every interaction here stops at a
 * SAFE boundary:
 *   - telemetry "enable" opens a consent dialog that we always Cancel (the node
 *     config is never flipped),
 *   - the Shutdown button is a two-click confirm; we only ever click it ONCE
 *     (arming the confirm) and then assert the daemon is still alive,
 *   - retention is asserted structurally (its persisted value is environment
 *     dependent — devnet ships 7 days), never mutated.
 */
test.describe('Settings page (rc.12 rewrite)', () => {
  test.beforeEach(async ({ shell, header, settingsPage }) => {
    await shell.goto();
    await header.openSettings();
    await settingsPage.waitForLoaded();
    // Gate on the async /api/status fetch so identity-derived assertions never
    // race the "—" first paint (status can lag under the local parallel load).
    await settingsPage.waitForIdentityLoaded();
  });

  test('opens as the active, closable center tab from the header gear', async ({ centerPanel, settingsPage }) => {
    await expect(settingsPage.title).toBeVisible();
    expect(await centerPanel.getTabNames()).toContain('Settings');
    expect((await centerPanel.getActiveTabName())?.trim()).toBe('Settings');
    expect(await centerPanel.isTabClosable('Settings')).toBe(true);
  });

  test('renders exactly the six section cards in order', async ({ settingsPage }) => {
    expect(await settingsPage.getSectionTitles()).toEqual([
      'Node Identity',
      'Blockchain Config',
      'Publisher Conviction',
      'Network Telemetry',
      'Local Data Retention',
      'Danger Zone',
    ]);
  });

  test('Node Identity fields are populated from the live node (no em-dash placeholders)', async ({ settingsPage }) => {
    for (const label of ['Name', 'Peer ID', 'Role', 'Network', 'Store']) {
      const value = (await settingsPage.fieldValue(label).first().textContent())?.trim() ?? '';
      expect(value.length, `${label} should render a real value`).toBeGreaterThan(0);
      expect(value, `${label} should not be the "not loaded" placeholder`).not.toBe('—');
    }
    // Devnet node role is deterministic but node-dependent: scripts/devnet.sh
    // boots the first NUM_CORE_NODES nodes as `core` and the rest as `edge`, so
    // assert against the role derived for the UI's target node rather than a
    // hard-coded `core` (which would falsely fail when repointed at an edge node
    // via UI_NODE_ID). Default CI run targets node1 → core.
    expect((await settingsPage.fieldValue('Role').first().textContent())?.trim()).toBe(EXPECTED_NODE_ROLE);
    // libp2p peer ids are base58 starting 12D3Koo… — catches a truncated/garbled id.
    expect((await settingsPage.fieldValue('Peer ID').first().textContent())?.trim()).toMatch(/^12D3Koo\w{20,}$/);
  });

  test('Node Identity Name + Peer ID exactly match GET /api/status', async ({ settingsPage, page }) => {
    // Authed in-page fetch (same bearer the UI uses) — a raw fetch would 401 on
    // an auth-enabled node and falsely fail even though Settings rendered fine.
    // Retries ride out transient 5xx under heavy parallel load, like the UI poll.
    const res = await fetchApiInPage<{ name: string; peerId: string }>(page, '/api/status');
    expect(res.ok, '/api/status must return JSON').toBeTruthy();
    const status = res.json!;
    expect((await settingsPage.fieldValue('Name').first().textContent())?.trim()).toBe(status.name);
    expect((await settingsPage.fieldValue('Peer ID').first().textContent())?.trim()).toBe(status.peerId);
  });

  test('Node Identity status pill reports ONLINE for a live daemon', async ({ settingsPage }) => {
    await expect(settingsPage.onlinePill).toBeVisible();
    expect(await settingsPage.getOnlinePillText()).toMatch(/●\s*ONLINE/);
    // The pill summary line carries peer/connection/uptime detail, never the
    // "Node is not responding" string a dead daemon would show.
    await expect(settingsPage.root.getByText('Node is not responding')).toHaveCount(0);
  });

  test('Blockchain Config shows the local hardhat chain, a wallet, and the testnet banner', async ({ settingsPage }) => {
    // Chain + wallet derive from the async /api/wallets/balances fetch — until it
    // resolves the field reads the "Unknown" fallback. The testnet banner renders
    // from the SAME payload, so waiting for it gates the whole assertion on a
    // loaded chainId (rather than racing the first paint).
    await expect(settingsPage.root.getByText(/Testnet Mode/i)).toBeVisible({ timeout: 15_000 });
    // At least one 0x… operational wallet address is rendered.
    await expect(settingsPage.root.getByText(/0x[a-fA-F0-9]{40}/).first()).toBeVisible();
    // chainLabel(31337) → "Local (Hardhat)"; once loaded it must never be the bare
    // "Unknown" fallback.
    const chain = (await settingsPage.fieldValue('Chain').first().textContent())?.trim() ?? '';
    expect(chain.length).toBeGreaterThan(0);
    expect(chain).not.toBe('Unknown');
  });

  test('RPC URL reveal/redact toggle flips its label', async ({ settingsPage, page }) => {
    const reveal = page.locator(sel.settings.rpcRevealBtn);
    // The devnet wallet endpoint reports an rpcUrl, so the field+toggle render.
    await expect(reveal).toBeVisible();
    await reveal.click();
    await expect(page.locator(sel.settings.rpcRedactBtn)).toBeVisible();
    await page.locator(sel.settings.rpcRedactBtn).click();
    await expect(page.locator(sel.settings.rpcRevealBtn)).toBeVisible();
  });

  test('Local Data Retention select exposes all five windows and a valid current value', async ({ settingsPage }) => {
    await expect(settingsPage.retentionSelect).toBeVisible();
    await expect(settingsPage.retentionSelect).toBeEnabled();
    expect(await settingsPage.getRetentionOptions()).toEqual([
      '7 days', '30 days', '90 days', '180 days', '365 days',
    ]);
    const current = await settingsPage.retentionSelect.inputValue();
    expect(['7', '30', '90', '180', '365']).toContain(current);
  });

  test('telemetry toggle defaults OFF and the enable-consent dialog is cancelable without flipping it', async ({ settingsPage }) => {
    await expect(settingsPage.telemetrySwitch).toBeVisible();
    await expect(settingsPage.telemetrySwitch).toHaveAttribute('aria-checked', 'false');

    // Turning it ON must require explicit consent — clicking opens a dialog,
    // it does NOT silently enable streaming.
    await settingsPage.telemetrySwitch.click();
    await expect(settingsPage.telemetryDialog).toBeVisible();
    await expect(settingsPage.telemetryDialog.getByText(/Private keys or wallet credentials/i)).toBeVisible();

    // Cancel → dialog closes, switch is still OFF (node telemetry untouched).
    await settingsPage.telemetryDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(settingsPage.telemetryDialog).toBeHidden();
    await expect(settingsPage.telemetrySwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('telemetry consent dialog closes on Escape (a11y) without enabling', async ({ settingsPage, page }) => {
    await settingsPage.telemetrySwitch.click();
    await expect(settingsPage.telemetryDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settingsPage.telemetryDialog).toBeHidden();
    await expect(settingsPage.telemetrySwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('Danger Zone Shutdown is a two-click confirm — the first click only arms it and never kills the node', async ({ settingsPage, page }) => {
    await expect(settingsPage.shutdownButton).toHaveText('Shutdown Node');

    // First click arms the confirm; it must NOT shut the daemon down.
    await settingsPage.shutdownButton.click();
    await expect(settingsPage.shutdownButton).toHaveText('Confirm Shutdown');
    await expect(settingsPage.root.getByText(/Click again to confirm/i)).toBeVisible();

    // Prove the daemon is still alive (the arming click had no side effect).
    // Authed in-page fetch (same bearer the UI uses) so an auth-enabled node
    // doesn't 401 here; retries ride out transient load-induced 5xx — the
    // contract under test is "daemon still up", not "every probe is instantly 200".
    const res = await fetchApiInPage(page, '/api/status');
    expect(res.ok, 'daemon must still answer /api/status after arming shutdown').toBeTruthy();
    expect(res.status).toBe(200);
  });

  test('Settings tab can be closed and reopened from the header', async ({ centerPanel, header, settingsPage }) => {
    await centerPanel.closeTab('Settings');
    expect(await centerPanel.getTabNames()).not.toContain('Settings');
    await header.openSettings();
    await settingsPage.waitForLoaded();
    expect(await centerPanel.getTabNames()).toContain('Settings');
  });
});
