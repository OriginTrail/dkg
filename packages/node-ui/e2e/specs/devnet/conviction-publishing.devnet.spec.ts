/**
 * Publishing Conviction NFT (PCA) API smoke against live devnet.
 * Full conviction discount flows live in devnet/conviction-lazy-settle/.
 */
import { test, expect } from '../../fixtures/base.js';
import { isDevnetAvailable, devnetApiFetch, waitForDevnetStatus } from '../../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
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

  test('publish without PCA registration uses standard shared-memory path', async () => {
    const { runWmSwmVmPipeline, listContextGraphs } = await import('../../helpers/devnet-publish.js');
    const cgs = await listContextGraphs(1);
    test.skip(cgs.length === 0, 'No CGs');
    const result = await runWmSwmVmPipeline({ contextGraphId: cgs[0]!.id });
    expect(result.assertionName).toBeTruthy();
  });
});

test.describe('Non-conviction publishing (baseline)', () => {
  test('shared-memory publish endpoint responds for devnet CG', async () => {
    const cgsRes = await devnetApiFetch('/api/context-graphs');
    const { contextGraphs } = (await cgsRes.json()) as { contextGraphs: Array<{ id: string }> };
    test.skip(contextGraphs.length === 0, 'No CGs');
    const { createWmAssertion, promoteAssertion, publishToVm, buildTestQuads } = await import('../../helpers/devnet-publish.js');
    const cgId = contextGraphs[0]!.id;
    const stamp = Date.now();
    const name = `e2e-non-conviction-${stamp}`;
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
