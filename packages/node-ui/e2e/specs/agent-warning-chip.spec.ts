import { test, expect } from '../fixtures/base.js';

// In v10 PR #c4f27667 the right-panel's "Connect Another Agent" surface
// learned to render an offline warning chip whenever an integration record
// arrives with `runtime.lastError` (mapped to `integration.error` by
// `mapLocalAgentIntegrationRecord` in api.ts:1513). The chip carries a
// stable `data-testid="local-agent-warning-${id}"` for exactly this kind
// of regression assertion.
//
// The live daemon doesn't reliably produce a `lastError` shape on every
// run (it'd require a real disconnect-with-restore-failure sequence), so
// we shim `/api/local-agent-integrations` with `page.route` to inject the
// canonical disconnect-error fixture from setup-entrypoint-contract.md
// §6 / S3 step 4. This is the same pattern operators see when Hermes
// uninstall fails to restore the prior provider.
test.describe('Agent integration warning chip (v10 PR #c4f27667)', () => {
  const HERMES_LAST_ERROR = 'Hermes provider restore failed: backup file missing.';

  async function mockIntegrations(
    page: import('@playwright/test').Page,
    overrides: Partial<{ enabled: boolean; runtimeStatus: string; lastError: string | null }>,
  ) {
    const enabled = overrides.enabled ?? false;
    const runtimeStatus = overrides.runtimeStatus ?? 'disconnected';
    const lastError = overrides.lastError ?? null;
    await page.route('**/api/local-agent-integrations', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          integrations: [
            {
              id: 'hermes',
              name: 'Hermes',
              description: 'Hermes local-agent framework with chat bridge.',
              enabled,
              status: runtimeStatus,
              capabilities: {
                localChat: true,
                chatAttachments: true,
                connectFromUi: true,
              },
              transport: { kind: 'http', bridgeUrl: 'http://127.0.0.1:9090' },
              runtime: {
                status: runtimeStatus,
                ready: runtimeStatus === 'ready',
                lastError,
                updatedAt: new Date().toISOString(),
              },
              manifest: { packageName: '@origintrail-official/hermes-adapter', version: '0.0.0-test' },
            },
          ],
        }),
      });
    });
  }

  test('renders the offline warning chip when an integration carries runtime.lastError', async ({ shell, page }) => {
    await mockIntegrations(page, {
      enabled: false,
      runtimeStatus: 'disconnected',
      lastError: HERMES_LAST_ERROR,
    });
    await shell.goto();

    // Stable per-integration test id added in PR #c4f27667. Locate it
    // anywhere in the page; the layout puts it inside the right panel's
    // "Connect Another Agent" surface. Asserting on testid (not class)
    // means a cosmetic class rename can't hide a regression.
    const chip = page.getByTestId('local-agent-warning-hermes');
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveText(HERMES_LAST_ERROR);
    // role="status" makes the warning announceable to assistive tech —
    // verify the a11y attribute survived.
    await expect(chip).toHaveAttribute('role', 'status');
  });

  test('does NOT render the warning chip when runtime.lastError is null', async ({ shell, page }) => {
    await mockIntegrations(page, {
      enabled: false,
      runtimeStatus: 'disconnected',
      lastError: null,
    });
    await shell.goto();

    // Wait for the right panel to mount — anchor on the "Connect Another
    // Agent" heading the agent-panel suite already relies on.
    await expect(page.getByText('CONNECT ANOTHER AGENT')).toBeVisible();
    // Hermes detail line should still render so the user can see
    // "available to connect" — but the warning chip MUST NOT render.
    await expect(page.getByTestId('local-agent-warning-hermes')).toHaveCount(0);
  });

  test('chip is adapter-agnostic — the testid template renders for any integration id', async ({ shell, page }) => {
    // Per the PR commit message: "render adapter-agnostic rather than gating
    // on integration.id === 'hermes'. OpenClaw doesn't surface lastError
    // through the disconnect path today, but if it ever does the same chip
    // renders for free with no extra branching." This test pins that
    // contract by feeding a non-Hermes id and asserting the chip still
    // renders — guarding against a future refactor that hard-codes 'hermes'.
    await page.route('**/api/local-agent-integrations', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          integrations: [
            {
              id: 'openclaw',
              name: 'OpenClaw',
              description: 'OpenClaw local-agent framework.',
              enabled: false,
              status: 'disconnected',
              capabilities: { localChat: true, connectFromUi: true },
              transport: { kind: 'http', bridgeUrl: 'http://127.0.0.1:8080' },
              runtime: {
                status: 'disconnected',
                ready: false,
                lastError: 'OpenClaw bridge offline (probe timeout).',
                updatedAt: new Date().toISOString(),
              },
              manifest: { packageName: '@origintrail-official/dkg-adapter-openclaw', version: '0.0.0-test' },
            },
          ],
        }),
      });
    });
    await shell.goto();

    const chip = page.getByTestId('local-agent-warning-openclaw');
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveText('OpenClaw bridge offline (probe timeout).');
  });
});
