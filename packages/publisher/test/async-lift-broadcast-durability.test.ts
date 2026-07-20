import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import { storeKnowledgeAssetOperationPublicQuads } from '../src/workspace-resolution.js';

// Regression: the mutable 'broadcast' record must be fsync-durable BEFORE the
// on-chain send. It is written inside the write-ahead hook (onBroadcast, awaited
// strictly before the tx sends). Without a flush there, a daemon crash in the
// flush->send window loses the record; on restart the job reads back as
// 'validated', recover() resets it, and it re-broadcasts with a fresh hash — a
// double on-chain submission. writeJob must flush on the execute-capable
// 'broadcast' transition, and only there (to avoid a whole-store snapshot on
// every state change). A flush FAILURE must not leave a phantom 'broadcast'
// record: the tx was never sent (the adapter fails closed), so the job must
// stay retryable from its pre-broadcast state, never enter chain recovery.
describe('async lift publisher broadcast durability', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  const tempDirs: string[] = [];

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function createPublisher(
    targetStore: OxigraphStore = store,
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(targetStore, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  function kaVmPublishRequest() {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: [] as string[],
      contentScopeVersion: 2 as const,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(),
      reservedUal: kaUal,
    };
  }

  const VALIDATION_DATA = {
    validation: {
      canonicalRoots: [] as string[],
      canonicalRootMap: {},
      swmQuadCount: 2,
      authorityProofRef: 'knowledge-asset-lifecycle',
      transitionType: 'CREATE' as const,
    },
  };

  const TX_HASH = `0x${'cd'.repeat(32)}` as `0x${string}`;

  async function driveToValidated(
    publisher: TripleStoreAsyncLiftPublisher,
  ): Promise<string> {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', VALIDATION_DATA);
    return jobId;
  }

  async function stageShareSnapshot(targetStore: OxigraphStore): Promise<void> {
    const request = kaVmPublishRequest();
    await storeKnowledgeAssetOperationPublicQuads({
      store: targetStore,
      graphManager: new GraphManager(targetStore),
      contextGraphId: 'music-social',
      shareOperationId: 'share-op-1',
      kaUal: request.kaUal,
      assertionVersion: request.assertionVersion,
      publisherPeerId: 'peer-1',
      quads: [
        { subject: 'urn:album:one', predicate: 'http://schema.org/name', object: '"One"', graph: '' },
        { subject: 'urn:album:two', predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
      ],
    });
  }

  it('fsyncs the store on the broadcast transition, and not on earlier transitions', async () => {
    const publisher = createPublisher();

    let flushCount = 0;
    const orig = store.flush?.bind(store);
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      flushCount += 1;
      await orig?.();
    };

    const jobId = await driveToValidated(publisher);
    // accepted / claimed / validated are not execute-capable — no fsync.
    expect(flushCount).toBe(0);

    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: TX_HASH, walletId: 'wallet-1' },
    });
    // broadcast is written inside the pre-send write-ahead hook — must fsync.
    expect(flushCount).toBe(1);

    const persisted = await publisher.getStatus(jobId);
    expect(persisted?.status).toBe('broadcast');
    expect(persisted?.broadcast?.txHash).toBe(TX_HASH);
  });

  it('awaits the broadcast fsync before the transition resolves', async () => {
    // Proves the fsync is AWAITED, not fire-and-forget: a regression that dropped
    // `await` (calling flush without waiting) would let update() resolve before
    // the record is durable, reopening the flush->send crash window.
    const publisher = createPublisher();

    const gate: { release: () => void } = { release: () => {} };
    let flushStarted = false;
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      flushStarted = true;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    };

    const jobId = await driveToValidated(publisher);

    let settled = false;
    const transition = publisher
      .update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet-1' } })
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

    // Let microtasks + a macrotask drain: the transition must still be pending,
    // blocked on the in-flight fsync.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flushStarted).toBe(true);
    expect(settled).toBe(false);

    gate.release();
    await transition;
    expect(settled).toBe(true);

    const persisted = await publisher.getStatus(jobId);
    expect(persisted?.status).toBe('broadcast');
  });

  it('persists the broadcast record across a restart (fresh store from disk)', async () => {
    // Proves durability, not just that flush() was called: drive to broadcast on
    // a persistent store, then reopen a FRESH store+publisher from the same path
    // and confirm the record survived. A crash-recovery reads 'broadcast' (the
    // chain-recovery path) instead of 'validated' (reset-and-resend).
    const dir = mkdtempSync(join(tmpdir(), 'lift-broadcast-durability-'));
    tempDirs.push(dir);
    const persistPath = join(dir, 'store.nq');

    const store1 = new OxigraphStore(persistPath);
    const publisher1 = createPublisher(store1);
    const jobId = await driveToValidated(publisher1);
    await publisher1.update(jobId, 'broadcast', {
      broadcast: { txHash: TX_HASH, walletId: 'wallet-1', merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}` },
    });

    const store2 = new OxigraphStore(persistPath);
    const publisher2 = createPublisher(store2);
    const recovered = await publisher2.getStatus(jobId);

    expect(recovered?.status).toBe('broadcast');
    expect(recovered?.broadcast?.txHash).toBe(TX_HASH);
    expect(recovered?.broadcast?.walletId).toBe('wallet-1');
  });

  it('does not send or leave a phantom broadcast when the write-ahead fsync fails', async () => {
    // Regression (#1851 review): the write-ahead fsync runs AFTER the in-memory
    // 'broadcast' transition. If it throws, the store would show 'broadcast'
    // although the adapter fails closed and never sends the tx. The job must roll
    // back to a retryable pre-broadcast state, never be reported/left as
    // 'broadcast' (which recovery would chase as an on-chain tx that never landed).
    let sent = false;
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          try {
            // Records 'broadcast' (write-ahead) -> writeJob -> flush (rejects).
            await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          } catch (hookErr) {
            // Mirror the adapter's fail-closed rewrap (evm-adapter-base.ts:1609):
            // a rejected write-ahead hook aborts the broadcast, tx never sent.
            throw new Error(
              `chain:writeahead hook failed before publish broadcast: ${(hookErr as Error).message}`,
            );
          }
          sent = true; // real adapter's eth_sendRawTransaction — must NOT run
          throw new Error('unreachable: send happened after a failed write-ahead flush');
        },
      },
    });

    // fsync is only invoked on the 'broadcast' transition; fault-inject it.
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      throw new Error('ENOSPC: no space left on device');
    };

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    // The tx was never sent.
    expect(sent).toBe(false);
    // The job is not left or reported as 'broadcast'.
    expect(processed?.status).toBe('failed');
    expect(processed?.status).not.toBe('broadcast');
    expect(processed?.failure?.failedFromState).toBe('validated');

    const persisted = await publisher.getStatus(jobId);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.status).not.toBe('broadcast');

    // Recovery must NOT treat it as an on-chain tx: a broadcast/included failure
    // would be a retry_recovery job that chases a tx hash that never landed. A
    // pre-broadcast failure is resolved off the chain-recovery track.
    expect(processed?.failure?.resolution).not.toBe('retry_recovery');
    const recovered = await publisher.recover();
    expect(recovered).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
  });
});
