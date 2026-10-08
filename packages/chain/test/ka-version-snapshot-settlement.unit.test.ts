// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3098 — a failed tuple slot must not abandon its still-live sibling HTTP
 * requests. This drives the actual snapshot, vendored ABI and canonical ethers
 * providers against loopback servers; only Hub initialization is bypassed.
 */
import { Contract, Interface, ZeroAddress, type JsonRpcProvider } from 'ethers';
import { describe, expect, it } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import {
  CHAIN_ID_HEX,
  createLoopbackJsonRpcTestHarness,
  sendJsonRpcError,
  sendJsonRpcResult,
} from './loopback-rpc-harness.js';

const KA_ID = 7n;
const KAS_ADDRESS = `0x${'33'.repeat(20)}`;
const AUTHOR = `0x${'44'.repeat(20)}`;
const PUBLISHER = `0x${'55'.repeat(20)}`;
const FALLBACK_ROOT = `0x${'bb'.repeat(32)}`;
const BLOCK_NUMBER = 500;
const BLOCK_HASH = `0x${'66'.repeat(32)}`;
const ABI = loadAbi('DKGKnowledgeAssets');
const iface = new Interface(ABI);

function blockResult() {
  const zeroHash = `0x${'00'.repeat(32)}`;
  return {
    number: `0x${BLOCK_NUMBER.toString(16)}`, hash: BLOCK_HASH,
    parentHash: zeroHash, timestamp: '0x1', nonce: '0x0000000000000000',
    difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: ZeroAddress,
    extraData: '0x', transactions: [], baseFeePerGas: '0x1',
  };
}

function resultFor(method: string): string {
  switch (method) {
    case 'getLatestMerkleRoot':
      return iface.encodeFunctionResult(method, [FALLBACK_ROOT]);
    case 'getKnowledgeAssetUpdateContext':
      return iface.encodeFunctionResult(method, [5n, 1n, 100n, 1n, 0n, false, 2n]);
    case 'getLatestMerkleRootAuthor':
      return iface.encodeFunctionResult(method, [AUTHOR]);
    case 'getLatestMerkleRootPublisher':
      return iface.encodeFunctionResult(method, [PUBLISHER]);
    default:
      throw new Error(`Unexpected contract method ${method}`);
  }
}

describe('coherent snapshot tuple settlement over real HTTP', () => {
  it('keeps a failed tuple under its deadline until a hung sibling is cancelled before recovery completes', async () => {
    const harness = createLoopbackJsonRpcTestHarness();
    let adapter: EVMChainAdapter | undefined;
    let markHungStarted!: () => void;
    const hungStarted = new Promise<void>((resolve) => { markHungStarted = resolve; });
    let hungAborts = 0;
    const primaryMethods: string[] = [];
    const fallbackMethods: string[] = [];

    try {
      const primary = await harness.start(async (request, response) => {
        if (request.method === 'eth_chainId') {
          sendJsonRpcResult(response, request, CHAIN_ID_HEX);
          return;
        }
        if (request.method === 'eth_getBlockByNumber') {
          sendJsonRpcResult(response, request, blockResult());
          return;
        }
        if (request.method !== 'eth_call') throw new Error(`Unexpected RPC ${request.method}`);
        const call = request.params[0] as { data: string };
        const method = iface.parseTransaction({ data: call.data })!.name;
        primaryMethods.push(method);
        if (method === 'getKnowledgeAssetUpdateContext') {
          response.once('close', () => { if (!response.writableEnded) hungAborts += 1; });
          markHungStarted();
          return; // A real physical request remains open until its attempt is cancelled.
        }
        if (method === 'getLatestMerkleRoot') {
          // Ensure the sibling really reached HTTP before the fast failed slot
          // rejects. Returning an immediate error without this handshake could
          // race the sibling's dispatch and fail to demonstrate abandonment.
          await hungStarted;
          sendJsonRpcError(response, request, 3, 'execution reverted: unusable pinned state', '0x');
          return;
        }
        sendJsonRpcResult(response, request, resultFor(method));
      });
      const fallback = await harness.start((request, response) => {
        if (request.method === 'eth_chainId') {
          sendJsonRpcResult(response, request, CHAIN_ID_HEX);
          return;
        }
        if (request.method === 'eth_getBlockByNumber') {
          sendJsonRpcResult(response, request, blockResult());
          return;
        }
        if (request.method !== 'eth_call') throw new Error(`Unexpected RPC ${request.method}`);
        const call = request.params[0] as { data: string };
        const method = iface.parseTransaction({ data: call.data })!.name;
        fallbackMethods.push(method);
        sendJsonRpcResult(response, request, resultFor(method));
      });

      adapter = new EVMChainAdapter({
        rpcUrl: primary.url,
        rpcUrls: [primary.url, fallback.url],
        // Public local development key; these loopback servers implement reads only.
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        hubAddress: `0x${'11'.repeat(20)}`,
        chainId: 'evm:31337', staticNetwork: false, finalityConfirmations: 1,
      });
      const mutable = adapter as unknown as {
        initialized: boolean;
        providers: JsonRpcProvider[];
        contracts: { knowledgeAssetStorage: Contract };
      };
      mutable.initialized = true;
      mutable.contracts.knowledgeAssetStorage = new Contract(KAS_ADDRESS, ABI, mutable.providers[0]);

      const startedAt = performance.now();
      const snapshot = await adapter.readKnowledgeAssetVersionSnapshot(KA_ID);
      expect(snapshot).toMatchObject({
        knowledgeAssetId: KA_ID, latestRoot: FALLBACK_ROOT, rootCount: 5n,
        latestAuthor: AUTHOR, latestPublisher: PUBLISHER,
        blockNumber: BLOCK_NUMBER, blockHash: BLOCK_HASH,
        knowledgeAssetStorageAddress: KAS_ADDRESS, knowledgeAssetStorageGeneration: 0,
      });

      // Promise.all rejects immediately and clears the endpoint timer, so the
      // pre-fix implementation has a successful fallback but NEVER closes this
      // sibling socket. Observe cancellation before teardown can manufacture it.
      await expect.poll(() => hungAborts, { timeout: 700, interval: 10 }).toBe(1);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(RPC_READ_STALL_TIMEOUT_MS - 100);
      expect(performance.now() - startedAt).toBeLessThan(RPC_READ_STALL_TIMEOUT_MS + 1_500);
      const tupleMethods = [
        'getLatestMerkleRoot', 'getKnowledgeAssetUpdateContext',
        'getLatestMerkleRootAuthor', 'getLatestMerkleRootPublisher',
      ].sort();
      expect([...primaryMethods].sort()).toEqual(tupleMethods);
      expect([...fallbackMethods].sort()).toEqual(tupleMethods);
      for (const endpoint of [primary, fallback]) {
        expect(endpoint.calls.filter((call) => call.method === 'eth_call')
          .every((call) => call.params[1] === `0x${BLOCK_NUMBER.toString(16)}`)).toBe(true);
      }
      const primaryRequestsAtCompletion = primary.calls.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(primary.calls).toHaveLength(primaryRequestsAtCompletion);
      expect(hungAborts).toBe(1);
    } finally {
      adapter?.destroy();
      await harness.stopAll();
    }
  }, 6_000);

  it('local admission pressure promptly cancels a started hung tuple without retry or fallback', async () => {
    const harness = createLoopbackJsonRpcTestHarness();
    const cleanup = new AbortController();
    let adapter: EVMChainAdapter | undefined;
    let result: Promise<unknown> | undefined;
    let markHungStarted!: () => void;
    const hungStarted = new Promise<void>((resolve) => { markHungStarted = resolve; });
    let hungAborts = 0;
    let pressureFailures = 0;
    let pressureAt: number | undefined;
    let settled = false;
    let snapshot: unknown;
    let snapshotError: unknown;
    const primaryMethods: string[] = [];

    try {
      const primary = await harness.start((request, response) => {
        if (request.method === 'eth_chainId') {
          sendJsonRpcResult(response, request, CHAIN_ID_HEX);
          return;
        }
        if (request.method === 'eth_getBlockByNumber') {
          sendJsonRpcResult(response, request, blockResult());
          return;
        }
        if (request.method !== 'eth_call') throw new Error(`Unexpected RPC ${request.method}`);
        const call = request.params[0] as { data: string };
        const method = iface.parseTransaction({ data: call.data })!.name;
        primaryMethods.push(method);
        if (method === 'getKnowledgeAssetUpdateContext') {
          response.once('close', () => { if (!response.writableEnded) hungAborts += 1; });
          markHungStarted();
          return; // Physical HTTP stays open; only operation cancellation can retire it promptly.
        }
        sendJsonRpcResult(response, request, resultFor(method));
      });
      const fallback = await harness.start((request, response) => {
        if (request.method === 'eth_chainId') {
          sendJsonRpcResult(response, request, CHAIN_ID_HEX);
          return;
        }
        if (request.method === 'eth_getBlockByNumber') {
          sendJsonRpcResult(response, request, blockResult());
          return;
        }
        if (request.method !== 'eth_call') throw new Error(`Unexpected RPC ${request.method}`);
        const call = request.params[0] as { data: string };
        const method = iface.parseTransaction({ data: call.data })!.name;
        sendJsonRpcResult(response, request, resultFor(method));
      });

      adapter = new EVMChainAdapter({
        rpcUrl: primary.url,
        rpcUrls: [primary.url, fallback.url],
        // Public local development key; the actual servers expose reads only.
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        hubAddress: `0x${'11'.repeat(20)}`,
        chainId: 'evm:31337', staticNetwork: false, finalityConfirmations: 1,
      });
      const mutable = adapter as unknown as {
        initialized: boolean;
        providers: JsonRpcProvider[];
        contracts: { knowledgeAssetStorage: Contract };
        rebindContract: (contract: Contract, provider: JsonRpcProvider) => Contract;
      };
      mutable.initialized = true;
      mutable.contracts.knowledgeAssetStorage = new Contract(KAS_ADDRESS, ABI, mutable.providers[0]);
      const originalRebind = mutable.rebindContract.bind(adapter);
      mutable.rebindContract = (contract, provider) => {
        const bound = originalRebind(contract, provider);
        if (provider !== mutable.providers[0]) return bound;
        return {
          getLatestMerkleRoot: (kaId: bigint, at: { blockTag: number }) =>
            bound.getLatestMerkleRoot(kaId, at),
          getKnowledgeAssetUpdateContext: (kaId: bigint, at: { blockTag: number }) =>
            bound.getKnowledgeAssetUpdateContext(kaId, at),
          getLatestMerkleRootAuthor: async (_kaId: bigint, at: { blockTag: number }) => {
            // Queue pressure is local, so inject the native typed error at this
            // getter only AFTER a real sibling request has reached HTTP. Without
            // this handshake, cancellation could win before dispatch and the
            // test would never demonstrate retirement of physical work.
            await hungStarted;
            expect(at.blockTag).toBe(BLOCK_NUMBER);
            pressureFailures += 1;
            pressureAt = performance.now();
            throw new RpcRequestGovernorQueueFullError(1);
          },
          getLatestMerkleRootPublisher: (kaId: bigint, at: { blockTag: number }) =>
            bound.getLatestMerkleRootPublisher(kaId, at),
        } as unknown as Contract;
      };

      result = adapter.readKnowledgeAssetVersionSnapshot(KA_ID, { signal: cleanup.signal })
        .then(
          (view) => { snapshot = view; settled = true; return view; },
          (error) => { snapshotError = error; settled = true; return undefined; },
        );
      await expect.poll(() => pressureFailures, { timeout: 1_500, interval: 10 }).toBe(1);
      // Both verdict and socket retirement must precede teardown and the 4s
      // endpoint cap. The pre-fix allSettled scan waits for the hung slot, so
      // it cannot satisfy either bounded assertion below.
      await Promise.all([
        expect.poll(() => settled, { timeout: 1_000, interval: 10 }).toBe(true),
        expect.poll(() => hungAborts, { timeout: 1_000, interval: 10 }).toBe(1),
      ]);
      expect(snapshotError).toBeUndefined();
      expect(snapshot).toBeNull();
      expect(pressureAt).toBeDefined();
      expect(performance.now() - pressureAt!).toBeLessThan(1_500);
      expect(performance.now() - pressureAt!).toBeLessThan(RPC_READ_STALL_TIMEOUT_MS);
      expect(pressureFailures).toBe(1);
      expect(fallback.calls).toEqual([]);
      expect(primary.calls.filter((call) => call.method === 'eth_getBlockByNumber')).toHaveLength(1);
      expect(primaryMethods.filter((method) => method === 'getKnowledgeAssetUpdateContext')).toHaveLength(1);
      expect(primary.calls.filter((call) => call.method === 'eth_call')
        .every((call) => call.params[1] === `0x${BLOCK_NUMBER.toString(16)}`)).toBe(true);

      const primaryRequestsAtCompletion = primary.calls.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(primary.calls).toHaveLength(primaryRequestsAtCompletion);
      expect(pressureFailures).toBe(1);
      expect(hungAborts).toBe(1);
      expect(fallback.calls).toEqual([]);
    } finally {
      cleanup.abort();
      adapter?.destroy();
      await harness.stopAll();
      await result?.catch(() => {});
    }
  }, 4_000);

});
