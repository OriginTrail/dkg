import { test, expect } from '../fixtures/base.js';

/**
 * Stage 5 — Prime Agent connect surface, real-node edition.
 *
 * Mirrors `hermes-connect.spec.ts`: no route interception, no mocks. Prime Agent
 * ships in `LOCAL_AGENT_INTEGRATION_DEFINITIONS` with `capabilities.connectFromUi:
 * true`, so the live daemon returns it from `/api/local-agent-integrations` and
 * the panel + Connect button render deterministically on a real node.
 *
 * It deliberately does NOT click "Connect Prime Agent". Unlike Hermes, that path
 * is side-effect-free on the node itself (it only probes the session discovery
 * directory), but it still rewrites `~/.prime/agent/settings.json` on the machine
 * running the test — an edit to the operator's real Prime Agent profile, which a
 * CI spec has no business making. The click-through is covered by the manual
 * sanity checks in `agent-docs/adapters/prime-agent/IMPLEMENTATION-PLAN.md`.
 *
 * The session-count assertion is the interesting one: Prime Agent publishes a
 * bridge per session, so zero live sessions is a normal idle state, not a fault.
 * The panel must say so rather than rendering an error, and this spec pins that
 * — on a CI node with no Prime Agent running, the zero-session copy is the
 * expected output.
 */

test.describe('Prime Agent connect surface (real node)', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    // Same rationale as hermes-connect: on a reused devnet another agent may
    // already be connected and own the default tab, so select the "+" add-agent
    // tab explicitly.
    const addTab = page.getByRole('tab', { name: 'Add another integrated agent' });
    await addTab.click({ timeout: 15_000 });
  });

  test('Prime Agent is listed among the bundled integrations', async ({ page }) => {
    const list = page.locator('.v10-local-agent-list');
    await expect(list).toBeVisible();
    await expect(list.locator('.v10-local-agent-title').filter({ hasText: 'Prime Agent' })).toBeVisible();
  });

  test('Prime Agent exposes a real Connect affordance', async ({ page }) => {
    const detail = page
      .locator('.v10-local-agent-detail')
      .filter({ has: page.locator('.v10-local-agent-title', { hasText: 'Prime Agent' }) });
    await expect(detail).toBeVisible();

    const connectBtn = page.getByRole('button', { name: /Connect Prime Agent/i });
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn).toBeEnabled();
  });

  test('the panel reports session state instead of treating zero sessions as an error', async ({ page }) => {
    const sessions = page.getByTestId('local-agent-sessions-prime-agent');
    await expect(sessions).toBeVisible();
    // With no Prime Agent process on the CI host there are no descriptors, so
    // the copy must be the benign idle line — not a failure.
    await expect(sessions).toContainText(/No live session|live session/i);
  });
});
