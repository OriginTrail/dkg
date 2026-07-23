import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeFinalizationMessage,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  type FinalizationMessageMsg,
} from '@origintrail-official/dkg-core';
import {
  MockChainAdapter,
  type CanonicalFinalizationReceipt,
  type ChainAdapter,
} from '@origintrail-official/dkg-chain';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import {
  parseGraphScopedFinalization,
} from '../src/finalization-graph-envelope.js';
import {
  FinalizationRecovery,
} from '../src/finalization-recovery.js';
import {
  openSqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';

const CONTEXT_GRAPH = 'finalization-recovery-admission';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const PUBLISHER = '0x2222222222222222222222222222222222222222';
const UAL = `did:dkg:base:84532/${AUTHOR}/7`;
const PACKED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

function message(overrides: Partial<FinalizationMessageMsg> = {}): FinalizationMessageMsg {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH,
    kcMerkleRoot: new Uint8Array(32),
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 123,
    batchId: PACKED_KA_ID,
    startKAId: PACKED_KA_ID,
    endKAId: PACKED_KA_ID,
    publisherAddress: PUBLISHER,
    rootEntities: [],
    timestampMs: Date.now(),
    operationId: 'recovery-admission-test',
    targetContextGraphId: '42',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    ...overrides,
  };
}

function parsedMessage(overrides: Partial<FinalizationMessageMsg> = {}) {
  const parsed = parseGraphScopedFinalization(message(overrides), CONTEXT_GRAPH);
  if (!parsed.ok) throw new Error(`unexpected admission failure: ${parsed.reason}`);
  return parsed.value;
}

function confirmedReceipt(
  overrides: Partial<CanonicalFinalizationReceipt> = {},
): CanonicalFinalizationReceipt {
  return {
    txHash: message().txHash,
    blockNumber: 123,
    blockHash: BLOCK_HASH,
    txIndex: 4,
    merkleRoot: new Uint8Array(32),
    publisherAddress: PUBLISHER,
    authorAddress: AUTHOR,
    batchId: PACKED_KA_ID,
    kaId: PACKED_KA_ID,
    startKAId: PACKED_KA_ID,
    endKAId: PACKED_KA_ID,
    ...overrides,
  };
}

function recoveryChain(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    chainId: 'base:84532',
    getLatestMerkleRoot: async () => new Uint8Array(32),
    getMerkleRootCount: async () => 1n,
    getKAContextGraphId: async () => 42n,
    resolveCanonicalFinalizationReceipt: async () => ({
      status: 'confirmed',
      receipt: confirmedReceipt(),
    }),
    ...overrides,
  } as ChainAdapter;
}

function recoveryMaterializer() {
  return {
    prepare: async () => ({
      onChainContextGraphId: '42',
      localTopicOnChainContextGraphId: '42',
      publisherPeerId: '12D3KooWPublisher',
      accessPolicy: 'public' as const,
      allowedPeers: [],
    }),
    apply: async () => 'applied' as const,
    replayVerified: async () => 'promoted' as const,
    invalidateVerified: async () => 'invalidated' as const,
    isRetryableError: (error: unknown) => error instanceof StoreSchedulerBusyError,
  };
}

describe('graph-scoped finalization recovery admission', () => {
  it('returns a typed parsed envelope for a valid singleton finalization', () => {
    expect(parseGraphScopedFinalization(message(), CONTEXT_GRAPH)).toMatchObject({
      ok: true,
      value: {
        assertionVersion: '1',
        kaId: PACKED_KA_ID,
        publicTripleCount: 1,
      },
    });
  });

  it('names invalid identity and access-envelope rejection reasons', () => {
    expect(parseGraphScopedFinalization(
      message({ ual: 'not-a-canonical-ual' }),
      CONTEXT_GRAPH,
    )).toEqual({ ok: false, reason: 'invalid-identity' });
    expect(parseGraphScopedFinalization(message({
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWReader', '12D3KooWReader'],
    }), CONTEXT_GRAPH)).toEqual({ ok: false, reason: 'invalid-allowed-peers' });
  });

  it('persists RECEIVED before a store-heavy operation can fail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-wiring-'));
    let agent: DKGAgent | undefined;
    try {
      agent = await DKGAgent.create({
        name: 'FinalizationRecoveryWiringBot',
        dataDir: directory,
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
      });
      const preStartHandler = agent.getOrCreateFinalizationHandler();
      await agent.start();
      expect(agent.getOrCreateFinalizationHandler()).toBe(preStartHandler);
      const originalQuery = agent.store.query.bind(agent.store);
      agent.store.query = async () => {
        throw new StoreSchedulerBusyError(
          'queue_wait_timeout',
          'normal',
          'finalization-runtime-wiring.query',
        );
      };
      try {
        await preStartHandler.handleFinalizationMessage(
          encodeFinalizationMessage(message()),
          CONTEXT_GRAPH,
          '12D3KooWPublisher',
        );
      } finally {
        agent.store.query = originalQuery;
      }
      expect(await agent.getFinalizationRecoveryHealth()).toMatchObject({
        available: true,
        stateCounts: { RECEIVED: 1 },
      });
      await agent.stop();
      expect(agent.getOrCreateFinalizationHandler()).toBe(preStartHandler);
      expect(await agent.getFinalizationRecoveryHealth()).toMatchObject({
        available: false,
        ready: false,
        degradedReason: 'not-configured',
      });
    } finally {
      await agent?.stop().catch(() => {});
      await agent?.store.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('selects only chain-current entries and marks a newer assertion SUPERSEDED', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-select-'));
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      let rootCount = 1n;
      const chainReads = { root: 0, count: 0, binding: 0 };
      const chain = recoveryChain({
        getLatestMerkleRoot: async () => {
          chainReads.root += 1;
          return new Uint8Array(32);
        },
        getMerkleRootCount: async () => {
          chainReads.count += 1;
          return rootCount;
        },
        getKAContextGraphId: async () => {
          chainReads.binding += 1;
          return 42n;
        },
      });
      const recovery = new FinalizationRecovery(
        store,
        chain,
        { info: () => {}, warn: () => {} },
        recoveryMaterializer(),
      );
      const entry = await recovery.receive({
        rawMessage: encodeFinalizationMessage(message()),
        contextGraphId: CONTEXT_GRAPH,
        sourcePeerId: '12D3KooWPublisher',
        candidate: parsedMessage(),
      });
      expect(entry?.state).toBe('RECEIVED');
      const secondTxHash = `0x${'bc'.repeat(32)}`;
      const secondEntry = await recovery.receive({
        rawMessage: encodeFinalizationMessage(message({ txHash: secondTxHash })),
        contextGraphId: CONTEXT_GRAPH,
        sourcePeerId: '12D3KooWPublisher',
        candidate: parsedMessage({ txHash: secondTxHash }),
      });
      expect(secondEntry?.state).toBe('RECEIVED');
      await expect(recovery.matchingEntries({
        chainId: chain.chainId,
        contextGraphId: CONTEXT_GRAPH,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: `0x${'00'.repeat(32)}`,
        kaId: PACKED_KA_ID.toString(),
      })).resolves.toHaveLength(2);
      expect(chainReads).toEqual({ root: 1, count: 1, binding: 1 });

      rootCount = 2n;
      await expect(recovery.matchingEntries({
        chainId: chain.chainId,
        contextGraphId: CONTEXT_GRAPH,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: `0x${'00'.repeat(32)}`,
        kaId: PACKED_KA_ID.toString(),
      })).resolves.toEqual([]);
      expect(await store.list()).toMatchObject([
        { state: 'SUPERSEDED' },
        { state: 'SUPERSEDED' },
      ]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('distinguishes reorged block placement from permanent receipt content mismatch', async () => {
    const resolve = async (receipt: CanonicalFinalizationReceipt) => {
      const recovery = new FinalizationRecovery(
        undefined,
        recoveryChain({
          resolveCanonicalFinalizationReceipt: async () => ({
            status: 'confirmed',
            receipt,
          }),
        }),
        { info: () => {}, warn: () => {} },
        recoveryMaterializer(),
      );
      return recovery.resolveCanonicalReceipt(parsedMessage());
    };

    await expect(resolve(confirmedReceipt({ blockNumber: 124 })))
      .resolves.toEqual({ status: 'reorged' });
    await expect(resolve(confirmedReceipt({
      merkleRoot: Uint8Array.from({ length: 32 }, () => 1),
    }))).resolves.toEqual({ status: 'rejected' });
  });

  it.each([
    ['a later block', 124],
    ['a same-height replacement block', 123],
  ] as const)(
    'revalidates SETTLED provenance when the same transaction moves to %s',
    async (_case, replacementBlockNumber) => {
      const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-settled-reorg-'));
      let store: Awaited<ReturnType<typeof openSqliteFinalizationRecoveryStore>> | undefined;
      try {
        store = await openSqliteFinalizationRecoveryStore(directory);
        const replacementBlockHash = `0x${'ef'.repeat(32)}`;
        let phase: 'block-a' | 'block-b' = 'block-a';
        const receiptOptions: Array<{ expectedBlockHash?: string; expectedBlockNumber?: number }> = [];
        const applied: Array<{ blockNumber: number; txIndex: number }> = [];
        const chain = recoveryChain({
          resolveCanonicalFinalizationReceipt: async (_txHash, options = {}) => {
            receiptOptions.push(options);
            if (phase === 'block-a') {
              return { status: 'confirmed', receipt: confirmedReceipt() };
            }
            if (
              options.expectedBlockHash?.toLowerCase() === BLOCK_HASH.toLowerCase()
              && options.expectedBlockNumber === 123
            ) return { status: 'reorged' };
            return {
              status: 'confirmed',
              receipt: confirmedReceipt({
                blockNumber: replacementBlockNumber,
                blockHash: replacementBlockHash,
                txIndex: 5,
              }),
            };
          },
        });
        const recovery = new FinalizationRecovery(
          store,
          chain,
          { info: () => {}, warn: () => {} },
          {
            ...recoveryMaterializer(),
            apply: async ({ blockNumber, txIndex }) => {
              applied.push({ blockNumber, txIndex });
              return 'applied' as const;
            },
          },
        );
        const initialMessage = message();
        await expect(recovery.processLive({
          rawMessage: encodeFinalizationMessage(initialMessage),
          contextGraphId: CONTEXT_GRAPH,
          sourcePeerId: '12D3KooWPublisher',
          candidate: parsedMessage(initialMessage),
        })).resolves.toBe(true);
        expect(await store.list()).toMatchObject([{
          state: 'SETTLED',
          generation: 0,
          verifiedEvidence: {
            blockNumber: 123,
            blockHash: BLOCK_HASH,
            txIndex: 4,
          },
        }]);

        phase = 'block-b';
        await store.close();
        store = await openSqliteFinalizationRecoveryStore(directory);
        const reopenedRecovery = new FinalizationRecovery(
          store,
          chain,
          { info: () => {}, warn: () => {} },
          {
            ...recoveryMaterializer(),
            apply: async ({ blockNumber, txIndex }) => {
              applied.push({ blockNumber, txIndex });
              return 'applied' as const;
            },
          },
        );
        await expect(reopenedRecovery.replayMatching({
          chainId: chain.chainId,
          contextGraphId: CONTEXT_GRAPH,
          onChainCgId: '42',
          ual: UAL,
          merkleRoot: `0x${'00'.repeat(32)}`,
          kaId: PACKED_KA_ID.toString(),
        })).resolves.toBe(true);

        expect(receiptOptions).toContainEqual({
          expectedBlockHash: BLOCK_HASH,
          expectedBlockNumber: 123,
        });
        expect(receiptOptions.at(-1)).toEqual({});
        expect(applied).toEqual([
          { blockNumber: 123, txIndex: 4 },
          { blockNumber: replacementBlockNumber, txIndex: 5 },
        ]);
        expect(await store.list()).toMatchObject([{
          state: 'SETTLED',
          generation: 1,
          verifiedEvidence: {
            blockNumber: replacementBlockNumber,
            blockHash: replacementBlockHash,
            txIndex: 5,
          },
        }]);
      } finally {
        await store?.close().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('fails closed when a SETTLED replacement changes a non-placement field', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-settled-conflict-'));
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      let receiptCalls = 0;
      let applyCalls = 0;
      const recovery = new FinalizationRecovery(
        store,
        recoveryChain({
          resolveCanonicalFinalizationReceipt: async () => {
            receiptCalls += 1;
            return { status: 'confirmed', receipt: confirmedReceipt() };
          },
        }),
        { info: () => {}, warn: () => {} },
        {
          ...recoveryMaterializer(),
          apply: async () => {
            applyCalls += 1;
            return 'applied' as const;
          },
        },
      );
      const initialMessage = message();
      await recovery.processLive({
        rawMessage: encodeFinalizationMessage(initialMessage),
        contextGraphId: CONTEXT_GRAPH,
        sourcePeerId: '12D3KooWPublisher',
        candidate: parsedMessage(initialMessage),
      });
      const conflictingMessage = message({
        blockNumber: 124,
        publicTripleCount: 2,
        accessPolicy: 'allowList',
        allowedPeers: ['12D3KooWReader'],
      });
      await recovery.processLive({
        rawMessage: encodeFinalizationMessage(conflictingMessage),
        contextGraphId: CONTEXT_GRAPH,
        sourcePeerId: '12D3KooWPublisher',
        candidate: parsedMessage(conflictingMessage),
      });

      expect(receiptCalls).toBe(1);
      expect(applyCalls).toBe(1);
      expect(await store.list()).toMatchObject([{
        state: 'SETTLED',
        generation: 0,
        verifiedEvidence: { blockNumber: 123, blockHash: BLOCK_HASH },
      }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('backs off transient SETTLED disappearance before bounded invalidation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-settled-missing-'));
    let store: Awaited<ReturnType<typeof openSqliteFinalizationRecoveryStore>> | undefined;
    try {
      let now = 1_000;
      let missing = false;
      let receiptCalls = 0;
      let invalidations = 0;
      store = await openSqliteFinalizationRecoveryStore(directory, { now: () => now });
      const chain = recoveryChain({
        resolveCanonicalFinalizationReceipt: async () => {
          receiptCalls += 1;
          return missing
            ? { status: 'not-found' as const }
            : { status: 'confirmed' as const, receipt: confirmedReceipt() };
        },
      });
      const recovery = new FinalizationRecovery(
        store,
        chain,
        { info: () => {}, warn: () => {} },
        {
          ...recoveryMaterializer(),
          invalidateVerified: async () => {
            invalidations += 1;
            return 'invalidated' as const;
          },
        },
      );
      await recovery.processLive({
        rawMessage: encodeFinalizationMessage(message()),
        contextGraphId: CONTEXT_GRAPH,
        sourcePeerId: '12D3KooWPublisher',
        candidate: parsedMessage(),
      });
      missing = true;
      const replay = {
        chainId: chain.chainId,
        contextGraphId: CONTEXT_GRAPH,
        onChainCgId: '42',
        ual: UAL,
        merkleRoot: `0x${'00'.repeat(32)}`,
        kaId: PACKED_KA_ID.toString(),
      };

      await expect(recovery.replayMatching(replay)).resolves.toBe(false);
      let [deferred] = await store.list();
      expect(deferred).toMatchObject({
        state: 'SETTLED',
        attemptCount: 1,
        lastError: 'settled canonical receipt is not-found',
      });
      now = deferred.nextAttemptAt!;
      missing = false;
      await expect(recovery.replayMatching(replay)).resolves.toBe(true);
      expect(await store.list()).toMatchObject([{
        state: 'SETTLED',
        attemptCount: 0,
      }]);
      missing = true;

      for (let attempt = 1; attempt < 5; attempt += 1) {
        await expect(recovery.replayMatching(replay)).resolves.toBe(false);
        [deferred] = await store.list();
        expect(deferred).toMatchObject({
          state: 'SETTLED',
          attemptCount: attempt,
          lastError: 'settled canonical receipt is not-found',
        });
        expect(deferred.nextAttemptAt).toBeGreaterThan(now);
        const callsBeforeBackoffProbe = receiptCalls;
        await expect(recovery.replayMatching(replay)).resolves.toBe(false);
        expect(receiptCalls).toBe(callsBeforeBackoffProbe);
        now = deferred.nextAttemptAt!;
      }

      await expect(recovery.replayMatching(replay)).resolves.toBe(true);
      expect(invalidations).toBe(1);
      expect(await store.list()).toMatchObject([{
        state: 'REJECTED',
        attemptCount: 4,
        lastError: 'canonical receipt disappeared after bounded retries',
      }]);
    } finally {
      await store?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('makes unsupported adapter capability explicit without fabricating ordering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-finalization-recovery-unsupported-'));
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory);
      const chain = recoveryChain({ resolveCanonicalFinalizationReceipt: undefined });
      const recovery = new FinalizationRecovery(
        store,
        chain,
        { info: () => {}, warn: () => {} },
        recoveryMaterializer(),
      );
      const entry = await recovery.receive({
        rawMessage: encodeFinalizationMessage(message()),
        contextGraphId: CONTEXT_GRAPH,
        candidate: parsedMessage(),
      });
      expect(await recovery.resolveCanonicalReceipt(parsedMessage())).toEqual({
        status: 'unsupported',
      });
      if (!entry) throw new Error('expected durable RECEIVED entry');
      await recovery.markUnsupported(entry);
      expect(await store.list()).toMatchObject([{ state: 'UNSUPPORTED' }]);
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
