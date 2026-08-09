// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: TEST_PRIVATE_KEY,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

function adapterWithUpdateContext(response: unknown): {
  adapter: EVMChainAdapter;
  calls: unknown[][];
  storage: object;
} {
  const adapter = new EVMChainAdapter(minimalConfig());
  const mutable = adapter as unknown as {
    init: () => Promise<void>;
    contracts: { knowledgeAssetStorage: object };
    readContractWithOptions: (...args: unknown[]) => Promise<unknown>;
  };
  const storage = {};
  const calls: unknown[][] = [];
  mutable.init = async () => undefined;
  mutable.contracts.knowledgeAssetStorage = storage;
  mutable.readContractWithOptions = async (...args: unknown[]) => {
    calls.push(args);
    return response;
  };
  return { adapter, calls, storage };
}

describe('EVMChainAdapter KA scalar update context', () => {
  it('returns the typed descriptor through one abortable RPC read', async () => {
    const response = Object.assign(
      [3n, 41n, 12_345n, 500n, 99n, false, 77n],
      {
        merkleRootsCount: 3n,
        minted: 41n,
        byteSize: 12_345n,
        endEpoch: 500n,
        tokenAmount: 99n,
        isImmutable: false,
        merkleLeafCount: 77n,
      },
    );
    const { adapter, calls, storage } = adapterWithUpdateContext(response);
    const controller = new AbortController();

    await expect(adapter.getKnowledgeAssetUpdateContext(42n, {
      signal: controller.signal,
    })).resolves.toEqual({
      merkleRootsCount: 3n,
      minted: 41n,
      byteSize: 12_345n,
      endEpoch: 500n,
      tokenAmount: 99n,
      isImmutable: false,
      merkleLeafCount: 77,
    });

    expect(calls).toEqual([[
      storage,
      'kas.getKnowledgeAssetUpdateContext',
      'getKnowledgeAssetUpdateContext',
      [42n],
      { signal: controller.signal },
    ]]);
  });

  it('decodes positional tuples without downcasting bytes or dropping known zeros', async () => {
    const aboveSafeIntegerBytes = BigInt(Number.MAX_SAFE_INTEGER) + 123n;
    const { adapter } = adapterWithUpdateContext([
      9n, 0n, aboveSafeIntegerBytes, 0n, 0n, false, 0n,
    ]);

    await expect(adapter.getKnowledgeAssetUpdateContext(7n)).resolves.toEqual({
      merkleRootsCount: 9n,
      minted: 0n,
      byteSize: aboveSafeIntegerBytes,
      endEpoch: 0n,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: 0,
    });
  });

  it('preserves getMerkleRootCount as a single cancellable scalar read', async () => {
    const { adapter, calls } = adapterWithUpdateContext([11n]);
    const controller = new AbortController();

    await expect(adapter.getMerkleRootCount(8n, {
      signal: controller.signal,
    })).resolves.toBe(11n);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[4]).toEqual({ signal: controller.signal });
  });

  it('uses the same named descriptor fields for update token sizing', async () => {
    const response = Object.assign(
      [99n, 99n, 10_000n, 1_000n, 99n, true, 999n],
      {
        merkleRootsCount: 3n,
        minted: 41n,
        byteSize: 100n,
        endEpoch: 10n,
        tokenAmount: 99n,
        isImmutable: false,
        merkleLeafCount: 77n,
      },
    );
    const { adapter, storage } = adapterWithUpdateContext(response);
    const chronos = {};
    const askStorage = {};
    const calls: string[] = [];
    const mutable = adapter as unknown as {
      contracts: {
        knowledgeAssetStorage: object;
        chronos: object;
        askStorage: object;
      };
      readContract: (
        contract: object,
        label: string,
        method: string,
        ...args: unknown[]
      ) => Promise<unknown>;
    };
    mutable.contracts.knowledgeAssetStorage = storage;
    mutable.contracts.chronos = chronos;
    mutable.contracts.askStorage = askStorage;
    mutable.readContract = async (_contract, label) => {
      calls.push(label);
      if (label === 'kas.getKnowledgeAssetUpdateContext') return response;
      if (label === 'chronos.getCurrentEpoch') return 5n;
      if (label === 'askStorage.getStakeWeightedAverageAsk') return 1_024n;
      throw new Error(`Unexpected contract read: ${label}`);
    };

    await expect(adapter.computeUpdateNewTokenAmount({
      kaId: 42n,
      newByteSize: 101n,
      currentTokenAmount: 99n,
    })).resolves.toBe(104n);
    expect(calls).toEqual([
      'kas.getKnowledgeAssetUpdateContext',
      'chronos.getCurrentEpoch',
      'askStorage.getStakeWeightedAverageAsk',
    ]);
  });

  it('fails closed when a required sizing field is absent', async () => {
    const { adapter } = adapterWithUpdateContext([
      1n, 1n, 100n, 10n, 1n, false,
    ]);

    await expect(adapter.getKnowledgeAssetUpdateContext(404n))
      .rejects.toThrow('Missing merkleLeafCount in update context for KA 404');
  });
});

describe('MockChainAdapter KA scalar update context', () => {
  it('initializes the legacy V8 scalar context without changing its defaults', async () => {
    const adapter = new MockChainAdapter();
    await adapter.createKnowledgeAsset({
      merkleRoot: new Uint8Array(32).fill(0x11),
      knowledgeAssetsCount: 4,
      signatures: [],
    });

    await expect(adapter.getKnowledgeAssetUpdateContext(1n)).resolves.toEqual({
      merkleRootsCount: 1n,
      minted: 4n,
      byteSize: 0n,
      endEpoch: 2n,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: 0,
    });
  });

  it('initializes fixture registration through the grouped scalar context', async () => {
    const adapter = new MockChainAdapter();
    adapter.__registerKC({
      kaId: 55n,
      contextGraphId: 7n,
      merkleRootHex: `0x${'22'.repeat(32)}`,
      chunks: [
        { chunkId: 0n, chunk: `0x${'33'.repeat(32)}` },
        { chunkId: 1n, chunk: `0x${'44'.repeat(32)}` },
      ],
      merkleLeafCount: 9,
      byteSize: 8_192n,
      startEpoch: 3n,
      endEpoch: 8n,
      tokenAmount: 123n,
    });

    await expect(adapter.getKnowledgeAssetUpdateContext(55n)).resolves.toEqual({
      merkleRootsCount: 1n,
      minted: 1n,
      byteSize: 8_192n,
      endEpoch: 8n,
      tokenAmount: 123n,
      isImmutable: false,
      merkleLeafCount: 9,
    });
  });

  it('restates the current version, bytes and leaves after growth and shrink updates', async () => {
    const adapter = new MockChainAdapter();
    await adapter.ensureProfile();
    const signature = { r: new Uint8Array(32), vs: new Uint8Array(32) };
    const result = await adapter.createKnowledgeAssets({
      publishOperationId: 'update-context-test',
      contextGraphId: 5n,
      merkleRoot: new Uint8Array(32).fill(0xab),
      knowledgeAssetsAmount: 3,
      byteSize: 12_345n,
      epochs: 2,
      tokenAmount: 99n,
      isImmutable: false,
      merkleLeafCount: 77,
      publisherNodeIdentityId: 1n,
      author: {
        address: adapter.signerAddress,
        signature,
        schemeVersion: 1,
      },
      ackSignatures: [{ identityId: 1n, ...signature }],
    });

    const update = async (byteSize: bigint, merkleLeafCount: number, tokenAmount: bigint) => {
      await adapter.updateKnowledgeCollectionV10({
        kaId: result.batchId,
        newMerkleRoot: new Uint8Array(32).fill(merkleLeafCount),
        newByteSize: byteSize,
        newMerkleLeafCount: merkleLeafCount,
        newTokenAmount: tokenAmount,
        authorAddress: adapter.signerAddress,
        authorR: new Uint8Array(32),
        authorVS: new Uint8Array(32),
      });
    };
    await update(20_000n, 100, 101n);
    await update(4_096n, 25, 102n);

    await expect(adapter.getKnowledgeAssetUpdateContext(result.batchId)).resolves.toEqual({
      merkleRootsCount: 3n,
      minted: 1n,
      byteSize: 4_096n,
      endEpoch: 3n,
      tokenAmount: 102n,
      isImmutable: false,
      merkleLeafCount: 25,
    });
  });
});
