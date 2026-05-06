import { test, expect } from '../fixtures/base.js';

/**
 * S3 / issue #386 — UI Connect Hermes click-to-chat-ready spec.
 *
 * Two cases share the post-condition (Connect button → connecting →
 * chat-ready) but differ in pre-conditions:
 *
 * - H-AC-06 (fresh user): no stored Hermes integration. The first
 *   `/api/local-agent-integrations` GET returns Hermes in 'available'
 *   state. Click Connect, daemon transitions to 'connecting', polling
 *   refresh transitions to 'chat_ready' once setup completes.
 *
 * - H-AC-11 (existing user): Hermes is already configured (enabled, with
 *   stored transport, runtime: ready). The user opens Node UI and the
 *   Hermes tab is already chat-ready without needing Connect.
 *
 * Per execution-plan.md §4: this spec uses API route interception so
 * CI does not need to spawn a real daemon + chain. The companion
 * `agent-docs/hermes-parity/manual-sanity-checks.md` documents the
 * full live-daemon path that QA drives during release-readiness.
 */

const HERMES_NAME = 'Hermes';

type Runtime = {
  status: 'disconnected' | 'configured' | 'connecting' | 'ready' | 'degraded' | 'error';
  ready: boolean;
  lastError?: string | null;
  updatedAt?: string;
};

type IntegrationRecord = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  capabilities: {
    localChat: boolean;
    connectFromUi: boolean;
    chatAttachments?: boolean;
    installNode?: boolean;
    dkgPrimaryMemory?: boolean;
    nodeServedSkill?: boolean;
  };
  transport: { kind: string; gatewayUrl?: string; bridgeUrl?: string; healthUrl?: string };
  runtime: Runtime;
  metadata?: Record<string, unknown>;
  manifest?: { packageName?: string; setupEntry?: string };
};

function hermesRecord(overrides: Partial<IntegrationRecord> = {}): IntegrationRecord {
  return {
    id: 'hermes',
    name: HERMES_NAME,
    description: 'Connect a local Hermes agent through the DKG node.',
    enabled: false,
    capabilities: {
      localChat: true,
      connectFromUi: true,
      chatAttachments: true,
    },
    transport: { kind: 'hermes-openai' },
    runtime: { status: 'disconnected', ready: false, lastError: null },
    metadata: {},
    ...overrides,
  };
}

function openClawAvailable(): IntegrationRecord {
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Local OpenClaw bridge.',
    enabled: false,
    capabilities: {
      localChat: true,
      connectFromUi: true,
      chatAttachments: true,
    },
    transport: { kind: 'openclaw-channel' },
    runtime: { status: 'disconnected', ready: false, lastError: null },
    metadata: {},
  };
}

test.describe('Hermes Connect — click-to-chat-ready', () => {
  test('H-AC-06: fresh user can Connect Hermes from the right panel and reach chat-ready', async ({ page, shell }) => {
    let connectCalled = false;

    // Intercept the integrations registry — first GET returns
    // available; after the Connect POST + daemon setup completes,
    // subsequent GETs return chat_ready.
    await page.route('**/api/local-agent-integrations', async (route, request) => {
      if (request.method() !== 'GET') return route.fallback();
      const integrations = connectCalled
        ? [
            openClawAvailable(),
            hermesRecord({
              enabled: true,
              transport: { kind: 'hermes-openai', gatewayUrl: 'http://127.0.0.1:8642' },
              runtime: { status: 'ready', ready: true, lastError: null },
            }),
          ]
        : [openClawAvailable(), hermesRecord()];
      await route.fulfill({ json: { integrations } });
    });

    // Hermes channel health endpoint — the api.ts mapper calls this
    // when computing chatReady. Returning ok lets the UI render the
    // chat-ready chip.
    await page.route('**/api/hermes-channel/health', async (route) => {
      await route.fulfill({
        json: connectCalled
          ? { ok: true, target: 'gateway', gateway: { ok: true } }
          : { ok: false, error: 'offline' },
      });
    });

    // OpenClaw health stays offline — keep the OpenClaw tab quiet so
    // we're not asserting against incidental behavior from the other
    // adapter.
    await page.route('**/api/openclaw-channel/health', async (route) => {
      await route.fulfill({ json: { ok: false, error: 'offline' } });
    });

    // The Connect POST: synchronously flips connectCalled so the next
    // poll-driven GET sees the chat-ready record. Mirrors the daemon
    // sequence: Connect returns 'connecting' synchronously, attach job
    // settles to ready in the background, polling refresh observes it.
    await page.route('**/api/local-agent-integrations/connect', async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      connectCalled = true;
      await route.fulfill({
        json: {
          ok: true,
          notice: 'Hermes setup started. This chat tab will come online automatically once Hermes finishes setting up.',
          integration: hermesRecord({
            enabled: true,
            runtime: { status: 'connecting', ready: false, lastError: null },
          }),
        },
      });
    });

    await shell.goto();

    const connectBtn = page.getByRole('button', { name: /Connect Hermes/i });
    await expect(connectBtn).toBeVisible();
    await connectBtn.click();

    // The post-condition shared with H-AC-11: the Hermes integration row
    // shows up in the connected-agents tab and chat input becomes available.
    // The exact selector for the Hermes tab is the integration name; we
    // wait for the panel to swap from "Connect Another Agent" into the
    // chat shell.
    await expect(page.getByText(/Hermes connected/i)).toBeVisible({ timeout: 15_000 });
  });

  test('H-AC-11: existing user with stored Hermes profile lands chat-ready without re-Connect', async ({ page, shell }) => {
    // Pre-seed: integrations registry already has Hermes enabled +
    // stored transport + runtime: ready. No Connect call is needed.
    await page.route('**/api/local-agent-integrations', async (route, request) => {
      if (request.method() !== 'GET') return route.fallback();
      await route.fulfill({
        json: {
          integrations: [
            openClawAvailable(),
            hermesRecord({
              enabled: true,
              transport: { kind: 'hermes-openai', gatewayUrl: 'http://127.0.0.1:8642' },
              runtime: { status: 'ready', ready: true, lastError: null },
              metadata: { profileName: 'default', hermesHome: 'C:\\Hermes\\default' },
            }),
          ],
        },
      });
    });

    await page.route('**/api/hermes-channel/health', async (route) => {
      await route.fulfill({ json: { ok: true, target: 'gateway', gateway: { ok: true } } });
    });

    await page.route('**/api/openclaw-channel/health', async (route) => {
      await route.fulfill({ json: { ok: false, error: 'offline' } });
    });

    // Connect should NOT be called in this scenario — the integration
    // is already chat-ready on first paint. Fail loudly if a Connect
    // POST does happen.
    await page.route('**/api/local-agent-integrations/connect', async (route) => {
      await route.fulfill({ status: 500, json: { error: 'Connect should not be called for an already-ready integration' } });
    });

    await shell.goto();

    // Same post-condition as H-AC-06: Hermes tab is chat-ready without
    // any user interaction.
    await expect(page.getByText(/Hermes connected/i)).toBeVisible({ timeout: 15_000 });

    // Connect Hermes button should NOT be visible — Hermes is already in
    // the connected-agents persistent-chat surface, not the
    // 'Connect Another Agent' add tab.
    await expect(page.getByRole('button', { name: /Connect Hermes/i })).toHaveCount(0);
  });
});
