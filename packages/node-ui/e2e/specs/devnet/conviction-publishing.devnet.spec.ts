/**
 * Publisher Conviction NFT (PCA) API smoke against live devnet.
 * Full conviction discount flows live in devnet/conviction-lazy-settle/.
 */
import type { PcaContracts } from '../../../src/ui/api.js';
import { test, expect } from '../../fixtures/base.js';
import { devnetApiFetch, waitForDevnetStatus, requireDevnetPrecondition, requireDevnetNode } from '../../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

type PcaRpcError = { code: number; message: string };
type PcaRpcResponse<T> = { jsonrpc?: '2.0'; id?: number; result?: T; error?: PcaRpcError };
type PcaRpcMethod = 'eth_chainId' | 'eth_blockNumber' | 'eth_getBlockByNumber' | 'eth_sendTransaction';

function numericChainId(chainId: PcaContracts['chainId']): number {
  const tail = String(chainId).match(/(\d+)\s*$/)?.[1];
  const parsed = tail ? Number.parseInt(tail, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Unrecognized PCA chain id: ${chainId}`);
  }
  return parsed;
}

function hexQuantityToNumber(value: string): number {
  expect(value).toMatch(HEX_QUANTITY);
  return Number.parseInt(value.slice(2), 16);
}

async function getPcaContracts(): Promise<PcaContracts> {
  const res = await devnetApiFetch('/api/pca/contracts');
  expect(res.status).toBe(200);
  return (await res.json()) as PcaContracts;
}

async function postPcaRpc<T>(id: number, method: PcaRpcMethod, params: unknown[] = []): Promise<PcaRpcResponse<T>> {
  const res = await devnetApiFetch('/api/pca/rpc', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PcaRpcResponse<T>;
}

function expectRpcSuccess<T>(response: PcaRpcResponse<T>): T {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  return response.result as T;
}

function expectRpcError(response: PcaRpcResponse<unknown>, code: number): PcaRpcError {
  expect(response.error?.code).toBe(code);
  expect(response.error?.message).toBeTruthy();
  return response.error as PcaRpcError;
}

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
    const contracts = await getPcaContracts();

    expect(contracts.nft).toMatch(EVM_ADDRESS);
    expect(contracts.token).toMatch(EVM_ADDRESS);
    expect(String(contracts.chainId)).toMatch(/\d+$/);
    expect(contracts.rpcUrls).toEqual(['/api/pca/rpc']);
    expect(contracts.walletRpcUrls ?? []).not.toContain('/api/pca/rpc');
    expect(JSON.stringify(contracts)).not.toMatch(/SECRETKEY/i);
  });

  test('POST /api/pca/rpc forwards receipt-polling reads and rejects wallet-write RPC', async () => {
    const contracts = await getPcaContracts();
    const chainId = expectRpcSuccess<string>(await postPcaRpc<string>(1, 'eth_chainId'));
    expect(hexQuantityToNumber(chainId)).toBe(numericChainId(contracts.chainId));

    const blockNumber = expectRpcSuccess<string>(await postPcaRpc<string>(2, 'eth_blockNumber'));
    expect(blockNumber).toMatch(HEX_QUANTITY);

    const exactBlock = expectRpcSuccess<unknown>(
      await postPcaRpc<unknown>(3, 'eth_getBlockByNumber', [blockNumber, true]),
    );
    expect(exactBlock).toBeTruthy();

    const writeError = expectRpcError(await postPcaRpc<unknown>(4, 'eth_sendTransaction'), -32601);
    expect(writeError.message).toContain('PCA RPC method not allowed');
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
