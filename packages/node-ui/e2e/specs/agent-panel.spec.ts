import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

test.describe('Right Panel (Agent Panel)', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('renders three mode tabs', async ({ rightPanel }) => {
    const tabs = await rightPanel.getModeTabNames();
    expect(tabs).toContain('Agents');
    expect(tabs).toContain('Network');
    expect(tabs).toContain('Sessions');
  });

  test('Agents mode is active by default', async ({ rightPanel }) => {
    const active = await rightPanel.getActiveMode();
    expect(active?.trim()).toBe('Agents');
  });

  test.describe('Agents Mode', () => {
    test('"+" add agent subtab is visible', async ({ page }) => {
      const addTab = page.locator(sel.rightPanel.addBtn);
      await expect(addTab).toBeVisible();
    });

    test('shows CONNECT ANOTHER AGENT heading', async ({ page }) => {
      const heading = page.getByText('CONNECT ANOTHER AGENT');
      await expect(heading).toBeVisible();
    });

    test('CONNECT ANOTHER AGENT panel lists the OpenClaw integration option', async ({ page }) => {
      // The empty integrations panel was a mock-only artefact; the real
      // daemon ships the OpenClaw / Hermes options bundled.
      await expect(page.getByText('OpenClaw').first()).toBeVisible();
    });
  });

  test.describe('Network Mode', () => {
    test.beforeEach(async ({ rightPanel }) => {
      await rightPanel.switchMode('Network');
    });

    test('shows mode as active', async ({ rightPanel }) => {
      const active = await rightPanel.getActiveMode();
      expect(active?.trim()).toBe('Network');
    });

    test('displays a peer count line', async ({ page }) => {
      // Real daemon connects to live testnet relays — peer count drifts.
      await expect(page.getByText(/\d+ peers?/).first()).toBeVisible();
    });

    test('shows the direct/relayed breakdown line', async ({ page }) => {
      await expect(page.getByText(/\d+ direct \/ \d+ relayed/)).toBeVisible();
    });

    test('Refresh button is visible', async ({ page }) => {
      const refreshBtn = page.locator('button').filter({ hasText: 'Refresh' });
      await expect(refreshBtn).toBeVisible();
    });

    test('Refresh button has descriptive title attribute', async ({ page }) => {
      const refreshBtn = page.locator('.v10-agents-refresh');
      const title = await refreshBtn.getAttribute('title');
      expect(title).toBeTruthy();
      expect(title).toContain('Refresh');
    });

    test('shows NETWORK PEERS heading', async ({ page }) => {
      const heading = page.getByText('NETWORK PEERS');
      await expect(heading).toBeVisible();
    });

    test('peers list shows the empty marker (isolated test daemon has no peers)', async ({ page }) => {
      // The e2e daemon runs in isolation on 127.0.0.1 with no bootstrap
      // peers configured — so the peers list MUST render the empty marker.
      // A populated list here means the daemon picked up a real peer from
      // somewhere (network leak) or the empty-state path regressed and
      // is rendering stale/phantom rows.
      await expect(page.getByText('No connected peers yet.')).toBeVisible({ timeout: 10_000 });
    });

    test('peer-count summary header is rendered', async ({ page }) => {
      await expect(page.getByText(/\d+ peers?/).first()).toBeVisible();
      await expect(page.getByText(/\d+ direct \/ \d+ relayed/)).toBeVisible();
    });
  });

  test.describe('Sessions Mode', () => {
    test.beforeEach(async ({ rightPanel }) => {
      await rightPanel.switchMode('Sessions');
    });

    test('shows mode as active', async ({ rightPanel }) => {
      const active = await rightPanel.getActiveMode();
      expect(active?.trim()).toBe('Sessions');
    });

    test('displays session description text', async ({ page }) => {
      const desc = page.getByText('Sessions track DKG-persisted conversations');
      await expect(desc).toBeVisible();
    });

    test('shows empty sessions message', async ({ page }) => {
      const msg = page.getByText('No integrated-agent sessions yet.');
      await expect(msg).toBeVisible();
    });
  });

  test('switching between all three modes and back', async ({ rightPanel }) => {
    await rightPanel.switchMode('Network');
    expect((await rightPanel.getActiveMode())?.trim()).toBe('Network');
    await rightPanel.switchMode('Sessions');
    expect((await rightPanel.getActiveMode())?.trim()).toBe('Sessions');
    await rightPanel.switchMode('Agents');
    expect((await rightPanel.getActiveMode())?.trim()).toBe('Agents');
  });

  test.describe('Add agent flow', () => {
    test('+ Add tab is visible in the Agents subtabs', async ({ page }) => {
      await expect(page.locator('.v10-agent-subtab.add')).toBeVisible();
    });

    test('clicking + Add does not crash the panel', async ({ page }) => {
      await page.locator('.v10-agent-subtab.add').click();
      await expect(page.locator('.v10-panel-right').first()).toBeVisible();
    });

    test('Network mode Refresh button is clickable', async ({ rightPanel, page }) => {
      await rightPanel.switchMode('Network');
      const refresh = page.locator('.v10-panel-right .v10-agents-refresh').first();
      await expect(refresh).toBeVisible();
      await refresh.click();
    });
  });
});
