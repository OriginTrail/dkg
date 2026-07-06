/**
 * Publisher Conviction NFT (PCA) API smoke against live devnet.
 * Full conviction discount flows live in devnet/conviction-lazy-settle/.
 */
import { test, expect } from '../../fixtures/base.js';
import { devnetApiFetch, waitForDevnetStatus, requireDevnetPrecondition, requireDevnetNode } from '../../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await requireDevnetNode(test, 1);
  await waitForDevnetStatus(1);
});

test.describe('Conviction NFT (PCA) API', () => {
  test('GET /api/pca/1 returns account info or structured 404/503', async () => {
    const res = await devnetApiFetch('/api/pca/1');
    expect([200, 404, 503]).toContain(res.status);
    const json = (await res.json()) as { error?: string; accountId?: string };
    if (res.status === 200) {
      expect(json.accountId).toBeTruthy();
    } else {
      expect(json.error).toBeTruthy();
    }
  });

  test('publish without PCA registration uses the KA lifecycle path', async () => {
    const { runWmSwmVmPipeline, listContextGraphs } = await import('../../helpers/devnet-publish.js');
    const cgs = await listContextGraphs(1);
    requireDevnetPrecondition(test, cgs.length === 0, 'No CGs');
    const result = await runWmSwmVmPipeline({ contextGraphId: cgs[0]!.id });
    expect(result.assertionName).toBeTruthy();
  });
});

test.describe('Non-conviction publishing (baseline)', () => {
  test('named KA VM publish responds for devnet CG', async () => {
    const cgsRes = await devnetApiFetch('/api/context-graphs');
    const { contextGraphs } = (await cgsRes.json()) as { contextGraphs: Array<{ id: string }> };
    requireDevnetPrecondition(test, contextGraphs.length === 0, 'No CGs');
    const { createWmAssertion, promoteAssertion, publishToVm, buildTestQuads } = await import('../../helpers/devnet-publish.js');
    const { withSwmLock } = await import('../../helpers/swm-lock.js');
    const cgId = contextGraphs[0]!.id;
    const stamp = Date.now();
    const name = `e2e-non-conviction-${stamp}`;
    // This is the ONE spec that publishes with `clearAfter: true` — a CG-wide
    // shared-memory wipe. Hold the SWM mutation lock across the whole
    // create→promote→publish(clear) so the wipe can never land between another
    // parallel pipeline's promote and publish (which would 500 that pipeline
    // with "No quads in shared memory ... matching selection"). See swm-lock.ts.
    await withSwmLock(async () => {
      const wm = await createWmAssertion({
        contextGraphId: cgId,
        name,
        quads: buildTestQuads(cgId, stamp, `Non-conviction ${stamp}`),
      });
      expect(wm.ok).toBe(true);
      const promote = await promoteAssertion({ contextGraphId: cgId, assertionName: name });
      expect(promote.ok).toBe(true);
      const published = await publishToVm({ contextGraphId: cgId, assertionName: name, clearAfter: true });
      expect(published.status).toBeTruthy();
    });
  });
});
