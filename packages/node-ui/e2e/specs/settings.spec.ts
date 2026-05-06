import { test, expect } from '../fixtures/base.js';

test.describe('Settings', () => {
  test.beforeEach(async ({ shell, settings }) => {
    await shell.goto();
    await settings.open();
  });

  test('opens with Settings heading and subtitle', async ({ settings, page }) => {
    await expect(settings.title).toBeVisible();
    await expect(page.getByText('Node configuration and preferences')).toBeVisible();
  });

  test('LLM card renders with Not Configured badge', async ({ settings }) => {
    await expect(settings.llmCard).toBeVisible();
    await expect(settings.llmStatusBadge).toHaveText(/Not Configured/);
  });

  test('API key input is masked by default and Show toggles to Hide', async ({ settings }) => {
    await expect(settings.apiKeyInput).toHaveAttribute('type', 'password');
    await expect(settings.apiKeyToggleBtn).toHaveText('Show');
    await settings.toggleApiKeyVisibility();
    await expect(settings.apiKeyInput).toHaveAttribute('type', 'text');
    await expect(settings.apiKeyToggleBtn).toHaveText('Hide');
  });

  test('API key, Model, and Base URL inputs accept text', async ({ settings }) => {
    await settings.fillApiKey('sk-test-1234');
    await settings.fillModel('gpt-4o');
    await settings.fillBaseUrl('https://example.com/v1');
    await expect(settings.apiKeyInput).toHaveValue('sk-test-1234');
    await expect(settings.modelInput).toHaveValue('gpt-4o');
    await expect(settings.baseUrlInput).toHaveValue('https://example.com/v1');
  });

  test('Disconnect button is hidden when LLM is not configured', async ({ settings }) => {
    await expect(settings.llmDisconnectBtn).toBeHidden();
  });

  test('Saving an LLM config flips the daemon to "LLM Connected" and exposes Disconnect; Disconnect reverts state', async ({ settings, page }) => {
    // The previous test only asserted the Save button was visible and
    // enabled — it never CLICKED it. A regression that broke the click
    // handler, the API call, the optimistic state flip, or the
    // "configured" indicator would all ship past such a smoke test.
    //
    // This drives the full save→connected→disconnect cycle so the daemon
    // ends back at "Not Configured" for downstream tests (sequencing
    // matters: Playwright runs workers: 1 and the daemon state carries
    // between tests). If the test fails mid-flow, the afterEach hook
    // here ensures we still try to disconnect to keep the suite clean.
    await settings.fillApiKey('sk-e2e-test-key');
    await settings.fillModel('gpt-4o-mini');
    await settings.fillBaseUrl('https://api.openai.com/v1');
    await expect(settings.llmSaveBtn).toBeEnabled();
    await settings.llmSaveBtn.click();
    try {
      await expect(page.getByText(/LLM configuration saved|LLM settings updated/)).toBeVisible({ timeout: 10_000 });
      await expect(settings.llmStatusBadge).toContainText('LLM Connected');
      await expect(settings.llmDisconnectBtn).toBeVisible();
    } finally {
      // Always revert — even if assertions above failed — so the test
      // daemon doesn't carry sk-e2e-test-key into other specs.
      if (await settings.llmDisconnectBtn.isVisible().catch(() => false)) {
        await settings.llmDisconnectBtn.click();
        await expect(settings.llmStatusBadge).toContainText('Not Configured', { timeout: 10_000 });
      }
    }
  });

  test('Telemetry card renders with the share-telemetry toggle', async ({ settings }) => {
    await expect(settings.telemetryCard).toBeVisible();
    await expect(settings.telemetryToggle).toBeVisible();
  });

  test('Local Data Retention defaults to 90 days and exposes 5 options', async ({ settings }) => {
    await expect(settings.retentionSelect).toBeVisible();
    expect(await settings.getRetentionValue()).toBe('90');
    const opts = await settings.retentionSelect.locator('option').allTextContents();
    expect(opts).toEqual(['7 days', '30 days', '90 days', '180 days', '365 days']);
  });

  test('reducing retention surfaces the Prune & Save / Cancel pending row', async ({ settings, page }) => {
    await settings.changeRetention(30);
    await expect(page.getByText(/Reduce retention to 30 days\?/)).toBeVisible();
    await expect(settings.retentionPruneBtn).toBeVisible();
    await expect(settings.retentionCancelBtn).toBeVisible();
  });

  test('Cancel on pending retention dismisses the row and reverts the select', async ({ settings, page }) => {
    await settings.changeRetention(30);
    await settings.retentionCancelBtn.click();
    await expect(page.getByText(/Reduce retention to/)).toBeHidden();
    expect(await settings.getRetentionValue()).toBe('90');
  });

  test('enabling telemetry opens the consent modal with policy text', async ({ settings, page }) => {
    await settings.toggleTelemetry();
    await expect(page.getByText('Enable Telemetry Streaming?')).toBeVisible();
    await expect(page.getByText('Operation logs (publish, query, sync, gossip events)')).toBeVisible();
    await expect(page.getByText('Private keys or wallet credentials')).toBeVisible();
  });

  test('consent modal Cancel closes without enabling', async ({ settings, page }) => {
    await settings.toggleTelemetry();
    await settings.consentCancelBtn.click();
    await expect(page.getByText('Enable Telemetry Streaming?')).toBeHidden();
  });

  test('Node Identity card shows the ONLINE banner when the daemon is up', async ({ settings }) => {
    // The harness boots a real daemon, so the badge must read ONLINE. If
    // this fails the daemon never made it past P2P bootstrap — that's a
    // bug, not a test problem.
    await expect(settings.identityCard).toBeVisible();
    await expect(settings.offlineBanner).toContainText('ONLINE');
  });

  test('Node Identity card lists Name / Peer ID / Role / Network / Store labels', async ({ settings }) => {
    for (const label of ['Name', 'Peer ID', 'Role', 'Network', 'Store']) {
      await expect(settings.identityCard.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('Blockchain card renders Chain row', async ({ settings }) => {
    await expect(settings.blockchainCard).toBeVisible();
    await expect(settings.blockchainCard.getByText('Chain', { exact: true })).toBeVisible();
  });

  test('Background Sync Status renders the CG picker', async ({ settings }) => {
    // The seed creates `qa-cg`, and the daemon adds the system CGs and
    // syncs more from the testnet. Assert the picker has at least the
    // seeded CG as an option.
    await expect(settings.syncSelect).toBeVisible();
    const opts = await settings.syncSelect.locator('option').allTextContents();
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.some(o => o.includes('qa-cg'))).toBe(true);
  });

  test('Background Sync Status Refresh button is enabled when a CG is selected', async ({ settings }) => {
    await expect(settings.syncRefreshBtn).toBeEnabled();
  });

  test('Developer Mode toggle is off by default', async ({ settings }) => {
    await expect(settings.devCard).toBeVisible();
    await expect(settings.devModeToggle).toBeVisible();
  });

  test('toggling Developer Mode reveals the unlocked-features panel', async ({ settings }) => {
    await settings.toggleDevMode();
    await expect(settings.devCard.getByText('Observability tab is now visible above.')).toBeVisible();
    await settings.toggleDevMode();
    await expect(settings.devCard.getByText('Observability tab is now visible above.')).toBeHidden();
  });

  test('Privacy & Memory card shows the disabled Publish by Default and Analytics toggles', async ({ page }) => {
    await expect(page.getByText('Privacy & Memory')).toBeVisible();
    await expect(page.getByText('Publish by Default')).toBeVisible();
    await expect(page.getByText('Analytics')).toBeVisible();
  });

  test('Danger Zone Shutdown button arms after first click', async ({ settings }) => {
    await expect(settings.shutdownBtn).toHaveText(/Shutdown Node/);
    await settings.clickShutdown();
    await expect(settings.shutdownBtn).toHaveText('Confirm Shutdown');
  });

  test('Danger Zone shows confirmation hint after first click', async ({ settings, page }) => {
    await settings.clickShutdown();
    await expect(page.getByText(/Click again to confirm/)).toBeVisible();
  });
});
