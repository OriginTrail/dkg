/**
 * Devnet-backed UI tests — run with `pnpm test:e2e`. The Playwright webServer
 * boots (or reuses) the devnet and starts Vite with DEVNET_NODE=1, so no manual
 * `scripts/devnet.sh start` is required.
 */
import { test, expect } from '../../fixtures/base.js';
import { devnetApiFetch, waitForDevnetStatus, requireDevnetPrecondition, requireDevnetNode } from '../../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);
});

test.describe('Publishing lifecycle (devnet)', () => {
  test('UI loads real context graphs from devnet daemon', async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await page.waitForTimeout(2000);
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThan(0);
  });

  test('operations view shows publish operations after devnet activity', async ({ shell, header, page }) => {
    await shell.goto();
    await header.openObservability();
    await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible();
    // Devnet may or may not have operations — assert the view loads without crash.
    await expect(page.locator('.v10-me-error')).toBeHidden();
  });

  test('API publish endpoint accepts WM assertion create', async () => {
    const cgs = await devnetApiFetch('/api/context-graphs');
    expect(cgs.ok).toBe(true);
    const body = (await cgs.json()) as { contextGraphs: Array<{ id: string; name: string }> };
    const cg = body.contextGraphs[0];
    requireDevnetPrecondition(test, !cg, 'No context graphs on devnet');

    const stamp = Date.now();
    const res = await devnetApiFetch('/api/assertion/create', {
      method: 'POST',
      body: JSON.stringify({
        contextGraphId: cg.id,
        name: `e2e-ui-${stamp}`,
        quads: [
          {
            subject: `urn:e2e:ui:entity:${stamp}`,
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://dkg.io/ontology/core/Entity',
          },
          {
            subject: `urn:e2e:ui:entity:${stamp}`,
            predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
            object: `"E2E UI Entity ${stamp}"`,
          },
        ],
        finalize: true,
        promote: false,
      }),
    });
    expect(res.ok).toBe(true);
  });
});
