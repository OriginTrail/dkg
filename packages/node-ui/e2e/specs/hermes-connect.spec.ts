import { test, expect } from '../fixtures/base.js';

/**
 * S3 / issue #386 — Hermes / local-agent connect surface, real-node edition.
 *
 * The previous version of this spec intercepted `/api/local-agent-integrations`,
 * `/api/hermes-channel/health` and `/api/local-agent-integrations/connect` to
 * fake a live Hermes gateway and assert the terminal "chat-ready" state. That
 * is a mock, and it asserted a state the node can't actually reach in CI.
 *
 * This suite runs against the real devnet node with NO route interception. It
 * verifies the real, deterministic, side-effect-free contract:
 *   - the right panel's "Connect Another Agent" surface lists the bundled
 *     integrations (OpenClaw + Hermes) returned by the live daemon registry;
 *   - each integration renders its real Connect affordance — both OpenClaw and
 *     Hermes ship with `capabilities.connectFromUi: true`, so both buttons
 *     render deterministically on a real node.
 *
 * It deliberately does NOT click "Connect Hermes": the node-ui connect path
 * runs `connectLocalAgentIntegrationFromUi`, which kicks off a real Hermes
 * install/spawn that cannot reach chat-ready without a live Hermes gateway.
 * The full click-to-chat-ready journey is covered by the live-daemon manual
 * sanity checks (`agent-docs/hermes-parity/manual-sanity-checks.md`).
 */

test.describe('Local-agent connect surface (real node)', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    // On a reused operator-owned devnet, OpenClaw/Hermes may already be connected,
    // in which case PanelRight auto-selects that agent's chat tab and the "Connect
    // Another Agent" surface is NOT the default view. Explicitly select the "+"
    // add-agent tab so these specs assert the connect surface deterministically
    // regardless of pre-existing local-agent state.
    const addTab = page.getByRole('tab', { name: 'Add another integrated agent' });
    await addTab.click({ timeout: 15_000 });
  });

  test('the "Connect Another Agent" surface lists the bundled integrations', async ({ page }) => {
    await expect(page.getByText('Connect Another Agent')).toBeVisible();
    const list = page.locator('.v10-local-agent-list');
    await expect(list).toBeVisible();
    // The daemon ships OpenClaw + Hermes as default integrations.
    await expect(list.locator('.v10-local-agent-title').filter({ hasText: 'OpenClaw' })).toBeVisible();
    await expect(list.locator('.v10-local-agent-title').filter({ hasText: 'Hermes' })).toBeVisible();
  });

  test('OpenClaw exposes a real Connect affordance', async ({ page }) => {
    const connectBtn = page.getByRole('button', { name: /Connect OpenClaw/i });
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn).toBeEnabled();
  });

  test('Hermes is listed and exposes a real Connect affordance', async ({ page }) => {
    const hermesDetail = page
      .locator('.v10-local-agent-detail')
      .filter({ has: page.locator('.v10-local-agent-title', { hasText: 'Hermes' }) });
    await expect(hermesDetail).toBeVisible();

    // The bundled Hermes adapter ships with `capabilities.connectFromUi: true`
    // (verified against the live daemon's `/api/local-agent-integrations`), so
    // the "Connect Hermes" button renders deterministically on a real node.
    // We assert it directly — we do NOT click it (that kicks off a real Hermes
    // install/spawn that needs a live gateway; see the file header).
    const connectBtn = page.getByRole('button', { name: /Connect Hermes/i });
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn).toBeEnabled();
  });
});
