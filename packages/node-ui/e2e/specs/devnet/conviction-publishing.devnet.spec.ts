/**
 * Publisher Conviction NFT (PCA) API smoke against live devnet.
 * Full conviction discount flows live in devnet/conviction-lazy-settle/.
 */
import { test, expect } from '../../fixtures/base.js';
import { devnetApiFetch, waitForDevnetStatus, requireDevnetPrecondition, requireDevnetNode } from '../../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

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

  test('GET /api/pca/contracts exposes HW bootstrap addresses and same-origin RPC only', async () => {
    const res = await devnetApiFetch('/api/pca/contracts');
    expect(res.status).toBe(200);

    const json = (await res.json()) as {
      nft?: string;
      token?: string;
      chainId?: string | number;
      rpcUrls?: string[];
      walletRpcUrls?: string[];
    };

    expect(json.nft).toMatch(EVM_ADDRESS);
    expect(json.token).toMatch(EVM_ADDRESS);
    expect(String(json.chainId ?? '')).toMatch(/\d+$/);
    expect(json.rpcUrls).toEqual(['/api/pca/rpc']);
    expect(json.walletRpcUrls ?? []).not.toContain('/api/pca/rpc');
    expect(JSON.stringify(json)).not.toMatch(/SECRETKEY/i);
  });

  test('POST /api/pca/rpc forwards receipt-polling reads and rejects wallet-write RPC', async () => {
    const readRes = await devnetApiFetch('/api/pca/rpc', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    expect(readRes.status).toBe(200);
    const readJson = (await readRes.json()) as { result?: unknown; error?: { message?: string } };
    expect(readJson.error).toBeUndefined();
    expect(String(readJson.result ?? '')).toMatch(HEX_QUANTITY);

    const blockNumberRes = await devnetApiFetch('/api/pca/rpc', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] }),
    });
    expect(blockNumberRes.status).toBe(200);
    const blockNumberJson = (await blockNumberRes.json()) as { result?: unknown; error?: { message?: string } };
    expect(blockNumberJson.error).toBeUndefined();
    const blockNumber = String(blockNumberJson.result ?? '');
    expect(blockNumber).toMatch(HEX_QUANTITY);

    const exactBlockRes = await devnetApiFetch('/api/pca/rpc', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'eth_getBlockByNumber',
        params: [blockNumber, true],
      }),
    });
    expect(exactBlockRes.status).toBe(200);
    const exactBlockJson = (await exactBlockRes.json()) as { result?: unknown; error?: { message?: string } };
    expect(exactBlockJson.error).toBeUndefined();
    expect(exactBlockJson.result).toBeTruthy();

    const writeRes = await devnetApiFetch('/api/pca/rpc', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'eth_sendTransaction', params: [] }),
    });
    expect(writeRes.status).toBe(200);
    const writeJson = (await writeRes.json()) as { error?: { code?: number; message?: string } };
    expect(writeJson.error?.code).toBe(-32601);
    expect(writeJson.error?.message).toContain('PCA RPC method not allowed');
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
