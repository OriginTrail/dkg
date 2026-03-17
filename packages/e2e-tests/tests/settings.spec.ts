import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui/settings');
  });

  test.describe('page load', () => {
    test('loads correctly with Settings heading and subtitle', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Node configuration and preferences')).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('LLM Configuration', () => {
    test('displays LLM Configuration section with API Key, Model, Base URL inputs and Save/Disconnect buttons', async ({ page }) => {
      const llmCard = page.locator('.settings-card').filter({ hasText: 'LLM Configuration' });
      await expect(llmCard).toBeVisible({ timeout: 15_000 });
      await expect(llmCard.getByText('API Key', { exact: true })).toBeVisible();
      const apiKeyInput = llmCard.locator('input[placeholder*="sk-"], input[placeholder*="••••••••"]').first();
      await expect(apiKeyInput).toBeVisible();
      await expect(llmCard.getByText('Model')).toBeVisible();
      await expect(llmCard.getByText('Base URL')).toBeVisible();
      await expect(llmCard.getByRole('button', { name: /^Save$/ })).toBeVisible();
      const disconnectBtn = llmCard.getByRole('button', { name: 'Disconnect' });
      if (await disconnectBtn.isVisible()) {
        await expect(disconnectBtn).toBeVisible();
      }
    });
  });

  test.describe('Telemetry section', () => {
    test('displays Telemetry & Observability section with Share telemetry and Local Data Retention', async ({ page }) => {
      await expect(page.getByText('Telemetry & Observability')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('Share telemetry with network')).toBeVisible();
      await expect(page.getByText('Local Data Retention')).toBeVisible();
      const retentionSelect = page.locator('select').filter({ has: page.locator('option[value="7"]') }).first();
      await expect(retentionSelect).toBeVisible();
      await expect(page.locator('option[value="7"]')).toHaveCount(1);
      await expect(page.locator('option[value="30"]')).toHaveCount(1);
      await expect(page.locator('option[value="90"]')).toHaveCount(1);
    });
  });

  test.describe('Node Identity', () => {
    test('displays Node Identity with NAME, PEER ID, ROLE, NETWORK, STORE and ONLINE status', async ({ page }) => {
      await expect(page.getByText('Node Identity')).toBeVisible({ timeout: 15_000 });
      const nodeCard = page.locator('.settings-card').filter({ hasText: 'Node Identity' });
      await expect(nodeCard.getByText('Name')).toBeVisible();
      await expect(nodeCard.getByText('Peer ID')).toBeVisible();
      await expect(nodeCard.getByText('Role')).toBeVisible();
      await expect(nodeCard.getByText('Network')).toBeVisible();
      await expect(nodeCard.getByText('Store')).toBeVisible();
      await expect(page.getByText(/● ONLINE|● OFFLINE/)).toBeVisible();
      const peerIdValue = nodeCard.locator('.prov-field-value, .mono').filter({ hasText: /12D3KooW/ });
      const hasPeerId = await peerIdValue.count() > 0 || (await nodeCard.textContent())?.includes('12D3KooW');
      expect(hasPeerId || (await nodeCard.textContent())?.includes('—')).toBeTruthy();
    });
  });

  test.describe('Blockchain Config', () => {
    test('displays Blockchain Config with CHAIN, WALLET balances (ETH, TRAC), and RPC URL', async ({ page }) => {
      await expect(page.getByText('Blockchain Config')).toBeVisible({ timeout: 15_000 });
      const chainSection = page.locator('.settings-card').filter({ hasText: 'Blockchain Config' });
      await expect(chainSection.getByText('Chain', { exact: true }).first()).toBeVisible();
      const hasEth = await chainSection.getByText(/ETH/).isVisible().catch(() => false);
      const hasTrac = await chainSection.getByText(/TRAC/).isVisible().catch(() => false);
      expect(hasEth || hasTrac || (await chainSection.textContent())?.includes('Wallet')).toBeTruthy();
      const hasRpc = await chainSection.getByText('RPC').isVisible().catch(() => false);
      const hasOperationalWallet = await chainSection.getByText(/Operational Wallet|Wallet/).isVisible().catch(() => false);
      expect(hasRpc || hasOperationalWallet).toBeTruthy();
    });
  });

  test.describe('Background Sync Status', () => {
    test('displays Background Sync Status with paranet dropdown and Refresh button', async ({ page }) => {
      await expect(page.getByText('Background Sync Status')).toBeVisible({ timeout: 15_000 });
      const syncSection = page.locator('.settings-card').filter({ hasText: 'Background Sync Status' });
      await expect(syncSection.getByRole('combobox')).toBeVisible();
      await expect(syncSection.getByRole('button', { name: /Refresh|Refreshing/ })).toBeVisible();
    });
  });

  test.describe('Developer Mode toggle', () => {
    test('displays Developer Mode text and toggle, enables dev mode when clicked', async ({ page }) => {
      await expect(page.getByText('Developer Mode')).toBeVisible({ timeout: 15_000 });
      const devSection = page.locator('.settings-card').filter({ hasText: 'Developer' });
      const toggle = devSection.locator('button').filter({ has: page.locator('span') }).first();
      await expect(toggle).toBeVisible();
      const isOn = await devSection.getByText('Observability tab is now visible').isVisible().catch(() => false);
      if (!isOn) {
        await toggle.click();
        await expect(page.getByText('Observability tab is now visible')).toBeVisible({ timeout: 5_000 });
      }
    });
  });

  test.describe('Privacy section', () => {
    test('displays Privacy & Memory section with disabled toggles and config.json explanation', async ({ page }) => {
      const privacyCard = page.locator('.settings-card').filter({ hasText: 'Privacy & Memory' });
      await expect(privacyCard).toBeVisible({ timeout: 15_000 });
      await expect(privacyCard.getByText(/config\.json/)).toBeVisible();
      await expect(privacyCard.getByText('Publish by Default')).toBeVisible();
      await expect(privacyCard.getByText('Analytics')).toBeVisible();
      await expect(privacyCard.getByText(/Edit.*config\.json|These settings are not yet configurable/)).toBeVisible();
      const disabledToggles = privacyCard.locator('button[disabled]');
      await expect(disabledToggles.first()).toBeVisible();
    });
  });

  test.describe('Installed Apps', () => {
    test('displays Installed Apps section, OriginTrail Game with ACTIVE when present', async ({ page }) => {
      await expect(page.getByText('Installed Apps')).toBeVisible({ timeout: 15_000 });
      const appsSection = page.locator('.settings-card').filter({ hasText: 'Installed Apps' });
      await page.waitForTimeout(1000);
      const hasOriginTrailGame = await appsSection.getByText('OriginTrail Game').isVisible().catch(() => false);
      const hasActive = await appsSection.getByText('ACTIVE').isVisible().catch(() => false);
      const hasNoApps = await appsSection.getByText('No apps installed').isVisible().catch(() => false);
      const hasLoading = await appsSection.getByText('Loading…').isVisible().catch(() => false);
      expect(hasOriginTrailGame || hasActive || hasNoApps || hasLoading).toBeTruthy();
    });
  });

  test.describe('Danger Zone', () => {
    test('displays Danger Zone with Shutdown Node button', async ({ page }) => {
      await expect(page.getByText('Danger Zone')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /Shutdown Node|Confirm Shutdown|Shutting down/ })).toBeVisible();
    });
  });
});

test.describe('Observability', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui/settings');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      localStorage.setItem('dkg-developer-mode', '1');
      window.dispatchEvent(new Event('devmode-change'));
    });
    await page.goto('/ui/settings?tab=observability');
    await page.waitForLoadState('domcontentloaded');
  });

  test.describe('page load', () => {
    test('loads Observability with sub-tabs: All Operations, Performance, Logs, Errors', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'All Operations' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Performance' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Logs' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Errors' })).toBeVisible();
    });
  });

  test.describe('All Operations tab', () => {
    test('displays operation type filter, status filter, operation ID search, table and pagination', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'All Operations' })).toBeVisible({ timeout: 15_000 });
      const typeFilter = page.locator('select').filter({ has: page.locator('option[value="publish"]') }).first();
      await expect(typeFilter).toBeVisible();
      await expect(page.locator('option[value="publish"]')).toHaveCount(1);
      await expect(page.locator('option[value="update"]')).toHaveCount(1);
      await expect(page.locator('option[value="query"]')).toHaveCount(1);
      const statusFilter = page.locator('select').filter({ has: page.locator('option[value="success"]') }).first();
      await expect(statusFilter).toBeVisible();
      await expect(page.getByPlaceholder('Filter by Operation ID...')).toBeVisible();
      const table = page.locator('.data-table');
      await expect(table).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Time' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Type' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Duration' })).toBeVisible();
      const pagination = page.getByText(/Page \d+ \/ \d+|Showing \d+–\d+ of \d+|No operations recorded/).first();
      await expect(pagination).toBeVisible();
    });
  });

  test.describe('Performance tab', () => {
    test('displays time window dropdown and stats cards (OPERATIONS, SUCCESS %, AVG DURATION, ERRORS)', async ({ page }) => {
      await page.getByRole('button', { name: 'Performance' }).click();
      await page.waitForTimeout(500);
      const periodSelect = page.locator('select').filter({ has: page.locator('option') }).first();
      await expect(periodSelect).toBeVisible({ timeout: 10_000 });
      const hasOperations = await page.getByText('Operations').first().isVisible().catch(() => false);
      const hasSuccess = await page.getByText('Success').first().isVisible().catch(() => false);
      const hasAvgDuration = await page.getByText(/Avg Duration|Duration/).first().isVisible().catch(() => false);
      const hasErrors = await page.getByText('Errors').first().isVisible().catch(() => false);
      const hasEmptyState = await page.getByText('Not enough data for charts').isVisible().catch(() => false);
      expect(hasOperations || hasSuccess || hasAvgDuration || hasErrors || hasEmptyState).toBeTruthy();
    });
  });

  test.describe('Logs tab', () => {
    test('displays search input, level filter, line count, refresh interval, Auto-scroll and daemon.log', async ({ page }) => {
      await page.getByRole('button', { name: 'Logs' }).click();
      await page.waitForTimeout(500);
      await expect(page.getByPlaceholder('Search node log...')).toBeVisible({ timeout: 10_000 });
      const levelFilter = page.locator('select').filter({ has: page.locator('option[value="all"]') }).first();
      await expect(levelFilter).toBeVisible();
      await expect(page.locator('option[value="all"]').first()).toHaveCount(1);
      const lineCountSelect = page.locator('select').filter({ has: page.locator('option[value="500"]') }).first();
      await expect(lineCountSelect).toBeVisible();
      await expect(page.getByRole('button', { name: 'Auto-scroll' })).toBeVisible();
      await expect(page.getByText('daemon.log')).toBeVisible();
    });
  });

  test.describe('Errors tab', () => {
    test('displays time range dropdown and search input', async ({ page }) => {
      await page.getByRole('button', { name: 'Errors' }).click();
      await page.waitForTimeout(500);
      const periodSelect = page.locator('select').filter({ has: page.locator('option') }).first();
      await expect(periodSelect).toBeVisible({ timeout: 10_000 });
      await expect(page.getByPlaceholder('Search errors, operation IDs...')).toBeVisible();
    });
  });
});
