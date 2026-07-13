import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  createLiftJobFailureMetadata,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type LiftJob,
} from '../src/index.js';
import { DEFAULT_WALLET_LOCK_GRAPH_URI, walletLockSubject } from '../src/async-lift-control-plane.js';
import { storeWorkspaceOperationPublicQuads } from '../src/workspace-resolution.js';
import { markWriteAheadCompatibilityBreadcrumb } from '../src/write-ahead-compat.js';

describe('KA async VM publish broadcast progress', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  let graphManager: GraphManager;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
  });

  function createPublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
    publisherStore: TripleStore = store,
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(publisherStore, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  function kaVmPublishRequest(overrides: Partial<Parameters<TripleStoreAsyncLiftPublisher['enqueueKnowledgeAssetVmPublish']>[0]> = {}) {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: ['urn:album:one', 'urn:album:two'],
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: {
          r: (`0x${'34'.repeat(32)}`) as `0x${string}`,
          vs: (`0x${'56'.repeat(32)}`) as `0x${string}`,
        },
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
      reservedUal: `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`,
      ...overrides,
    };
  }

  async function stageShareSnapshot(): Promise<void> {
    await storeWorkspaceOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: 'music-social',
      shareOperationId: 'share-op-1',
      rootEntities: ['urn:album:one', 'urn:album:two'],
      publisherPeerId: 'peer-1',
      quads: [
        { subject: 'urn:album:one', predicate: 'http://schema.org/name', object: '"One"', graph: '' },
        { subject: 'urn:album:two', predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
      ],
    });
  }

  it('persists KA broadcast tx hash from structured write-ahead context', async () => {
    const txHash = `0x${'cd'.repeat(32)}` as `0x${string}`;
    let jobId = '';
    let statusDuringExecutor: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishExecutor: async (input) => {
        expect((await publisher.getStatus(jobId))?.status).toBe('validated');
        await input.publishOptions.onPhase?.('chain:writeahead', 'start', { txHash });
        statusDuringExecutor = await publisher.getStatus(jobId);
        throw new Error('process crashed after tx submit');
      },
    });
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');
    const recovered = await publisher.recover();
    const afterRecover = await publisher.getStatus(jobId);

    expect(statusDuringExecutor?.status).toBe('broadcast');
    expect(statusDuringExecutor?.broadcast?.txHash).toBe(txHash);
    expect(statusDuringExecutor?.broadcast?.walletId).toBe('wallet-1');
    expect(statusDuringExecutor?.broadcast?.merkleRoot).toBe(`0x${'12'.repeat(32)}`);
    expect(processed?.status).toBe('broadcast');
    expect(processed?.broadcast?.txHash).toBe(txHash);
    expect(recovered).toBe(0);
    expect(afterRecover?.status).toBe('broadcast');
    expect(afterRecover?.broadcast?.txHash).toBe(txHash);
  });

  it('persists KA broadcast tx hash from a legacy-only executor before recovery', async () => {
    const txHash = `0x${'ce'.repeat(32)}` as `0x${string}`;
    const controller = new AbortController();
    let jobId = '';
    let statusDuringExecutor: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishExecutor: async (input) => {
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'start',
          { signal: controller.signal },
        );
        statusDuringExecutor = await publisher.getStatus(jobId);
        throw new Error('legacy executor crashed after tx submit');
      },
    });
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(statusDuringExecutor?.status).toBe('broadcast');
    expect(statusDuringExecutor?.broadcast?.txHash).toBe(txHash);
    expect(processed?.status).toBe('broadcast');
    expect(processed?.broadcast?.txHash).toBe(txHash);
  });

  it('ignores the built-in marked legacy breadcrumb until structured write-ahead', async () => {
    const txHash = `0x${'ce'.repeat(32)}` as `0x${string}`;
    const controller = new AbortController();
    let jobId = '';
    let statusDuringExecutor: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishExecutor: async (input) => {
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'start',
          markWriteAheadCompatibilityBreadcrumb({ signal: controller.signal }),
        );
        statusDuringExecutor = await publisher.getStatus(jobId);
        throw new Error('built-in breadcrumb preceded structured write-ahead');
      },
    });
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(statusDuringExecutor?.status).toBe('validated');
    expect(statusDuringExecutor?.broadcast).toBeUndefined();
    expect(processed?.status).toBe('failed');
    expect(processed?.broadcast).toBeUndefined();
  });

  it('ignores an unmarked legacy txsigned event when its supplied signal is aborted', async () => {
    const txHash = `0x${'ca'.repeat(32)}` as `0x${string}`;
    const controller = new AbortController();
    controller.abort();
    let jobId = '';
    let statusDuringExecutor: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishExecutor: async (input) => {
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'start',
          { signal: controller.signal },
        );
        statusDuringExecutor = await publisher.getStatus(jobId);
        throw new Error('aborted legacy executor did not broadcast');
      },
    });
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(statusDuringExecutor?.status).toBe('validated');
    expect(statusDuringExecutor?.broadcast).toBeUndefined();
    expect(processed?.status).toBe('failed');
    expect(processed?.broadcast).toBeUndefined();
  });

  it('keeps KA write-ahead compatible with a TripleStore that omits update()', async () => {
    const txHash = `0x${'cf'.repeat(32)}` as `0x${string}`;
    const storeWithoutUpdate = new Proxy(store, {
      get(target, property) {
        if (property === 'update') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    let jobId = '';
    let statusDuringExecutor: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishExecutor: async (input) => {
        await input.publishOptions.onPhase?.('chain:writeahead', 'start', { txHash });
        statusDuringExecutor = await publisher.getStatus(jobId);
        throw new Error('process crashed after tx submit');
      },
    }, storeWithoutUpdate);
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(statusDuringExecutor?.status).toBe('broadcast');
    expect(statusDuringExecutor?.broadcast?.txHash).toBe(txHash);
    expect(processed?.status).toBe('broadcast');
    expect(processed?.broadcast?.txHash).toBe(txHash);
  });

  it('does not overwrite a concurrent status change with stale broadcast progress', async () => {
    const txHash = `0x${'d0'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher();
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    const expectedJob = await publisher.getStatus(jobId);
    if (!expectedJob) throw new Error('expected validated job');

    const originalUpdate = store.update.bind(store);
    let injectedConcurrentChange = false;
    store.update = async (sparql, options) => {
      if (!injectedConcurrentChange) {
        injectedConcurrentChange = true;
        await publisher.update(jobId, 'failed', {
          failure: createLiftJobFailureMetadata({
            failedFromState: 'validated',
            code: 'canonicalization_failed',
            message: 'concurrent validation failure',
            errorPayloadRef: `urn:dkg:publisher:error:${jobId}`,
          }),
        } as never);
      }
      await originalUpdate(sparql, options);
    };

    const internals = publisher as unknown as {
      recordKnowledgeAssetVmPublishBroadcastProgress(params: {
        jobId: string;
        walletId: string;
        txHash: `0x${string}`;
        merkleRoot: `0x${string}`;
        expectedJob: LiftJob;
      }): Promise<boolean>;
    };
    await expect(internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      jobId,
      walletId: 'wallet-1',
      txHash,
      merkleRoot: `0x${'12'.repeat(32)}`,
      expectedJob,
    })).rejects.toThrow(`changed from validated before the broadcast transition`);

    const committed = await publisher.getStatus(jobId);
    expect(injectedConcurrentChange).toBe(true);
    expect(committed?.status).toBe('failed');
    expect(committed?.failure?.message).toBe('concurrent validation failure');
    expect(committed?.broadcast).toBeUndefined();
  });

  it('rejects an old executor callback after the job is recovered and revalidated', async () => {
    const txHash = `0x${'d2'.repeat(32)}` as `0x${string}`;
    let releaseExecutor!: () => void;
    const executorGate = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    let markExecutorStarted!: () => void;
    const executorStarted = new Promise<void>((resolve) => { markExecutorStarted = resolve; });
    let claimTokens = 0;
    const publisher = createPublisher({
      claimTokenGenerator: () => `attempt-${++claimTokens}`,
      knowledgeAssetVmPublishExecutor: async (input) => {
        markExecutorStarted();
        await executorGate;
        await input.publishOptions.onPhase?.('chain:writeahead', 'start', { txHash });
        throw new Error('old executor must not advance the reclaimed job');
      },
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const oldAttempt = publisher.processNext('wallet-1');
    await executorStarted;
    const validatedA = await publisher.getStatus(jobId);
    expect(validatedA?.status).toBe('validated');
    expect(validatedA?.claim?.claimToken).toContain('attempt-1');

    await expect(publisher.recover()).resolves.toBe(1);
    const claimedB = await publisher.claimNext('wallet-2');
    expect(claimedB?.jobId).toBe(jobId);
    expect(claimedB?.claim?.claimToken).toContain('attempt-2');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'reclaimed-validation',
        transitionType: 'CREATE',
      },
    });
    const validatedB = await publisher.getStatus(jobId);
    expect(validatedB?.status).toBe('validated');

    releaseExecutor();
    const staleResult = await oldAttempt;
    const committed = await publisher.getStatus(jobId);
    expect(staleResult?.status).toBe('validated');
    expect(staleResult?.claim?.walletId).toBe('wallet-2');
    expect(committed?.status).toBe('validated');
    expect(committed?.claim?.walletId).toBe('wallet-2');
    expect(committed?.claim?.claimToken).toBe(validatedB?.claim?.claimToken);
    expect(committed?.validation?.authorityProofRef).toBe('reclaimed-validation');
    expect(committed?.broadcast).toBeUndefined();

    const internals = publisher as unknown as {
      readWalletLock(walletId: string): Promise<{ claimToken?: string } | null>;
    };
    expect(await internals.readWalletLock('wallet-1')).toBeNull();
    expect((await internals.readWalletLock('wallet-2'))?.claimToken).toBe(
      validatedB?.claim?.claimToken,
    );
  });

  it('does not let a stale claimed attempt validate a recovered and re-claimed job', async () => {
    let claimTokens = 0;
    let executorCalls = 0;
    const publisher = createPublisher({
      claimTokenGenerator: () => `attempt-${++claimTokens}`,
      knowledgeAssetVmPublishExecutor: async () => {
        executorCalls += 1;
        throw new Error('stale attempt must not reach the executor');
      },
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const originalUpdate = store.update.bind(store);
    let validatedB: LiftJob | null = null;
    store.update = async (sparql, options) => {
      if (!validatedB) {
        // Attempt A has been claimed and is about to commit validation. Run a
        // complete recovery/reclaim cycle before its conditional write lands.
        await expect(publisher.recover()).resolves.toBe(1);
        const claimedB = await publisher.claimNext('wallet-2');
        expect(claimedB?.claim?.claimToken).toContain('attempt-2');
        await publisher.update(jobId, 'validated', {
          validation: {
            canonicalRoots: ['urn:album:one', 'urn:album:two'],
            canonicalRootMap: {},
            swmQuadCount: 2,
            authorityProofRef: 'attempt-b',
            transitionType: 'CREATE',
          },
        });
        validatedB = await publisher.getStatus(jobId);
      }
      await originalUpdate(sparql, options);
    };

    const staleResult = await publisher.processNext('wallet-1');
    const committed = await publisher.getStatus(jobId);
    expect(executorCalls).toBe(0);
    expect(staleResult?.status).toBe('validated');
    expect(staleResult?.claim?.walletId).toBe('wallet-2');
    expect(committed?.status).toBe('validated');
    expect(committed?.claim?.claimToken).toBe(validatedB?.claim?.claimToken);
    expect(committed?.validation?.authorityProofRef).toBe('attempt-b');
    expect(committed?.broadcast).toBeUndefined();

    const internals = publisher as unknown as {
      readWalletLock(walletId: string): Promise<{ claimToken?: string } | null>;
    };
    expect(await internals.readWalletLock('wallet-1')).toBeNull();
    expect((await internals.readWalletLock('wallet-2'))?.claimToken).toBe(
      validatedB?.claim?.claimToken,
    );
  });

  it('rejects an ABA reclaim that lands between the broadcast read and server CAS', async () => {
    const txHash = `0x${'d3'.repeat(32)}` as `0x${string}`;
    let claimTokens = 0;
    const publisher = createPublisher({
      claimTokenGenerator: () => `attempt-${++claimTokens}`,
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'attempt-a',
        transitionType: 'CREATE',
      },
    });
    const expectedJob = await publisher.getStatus(jobId);
    if (!expectedJob) throw new Error('expected validated attempt A');

    const originalUpdate = store.update.bind(store);
    let validatedB: LiftJob | null = null;
    store.update = async (sparql, options) => {
      if (!validatedB) {
        await expect(publisher.recover()).resolves.toBe(1);
        const claimedB = await publisher.claimNext('wallet-2');
        expect(claimedB?.claim?.claimToken).toContain('attempt-2');
        await publisher.update(jobId, 'validated', {
          validation: {
            canonicalRoots: ['urn:album:one', 'urn:album:two'],
            canonicalRootMap: {},
            swmQuadCount: 2,
            authorityProofRef: 'attempt-b',
            transitionType: 'CREATE',
          },
        });
        validatedB = await publisher.getStatus(jobId);
      }
      await originalUpdate(sparql, options);
    };

    const internals = publisher as unknown as {
      recordKnowledgeAssetVmPublishBroadcastProgress(params: {
        jobId: string;
        walletId: string;
        txHash: `0x${string}`;
        merkleRoot: `0x${string}`;
        expectedJob: LiftJob;
      }): Promise<boolean>;
      readWalletLock(walletId: string): Promise<{ claimToken?: string } | null>;
    };
    await expect(internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      jobId,
      walletId: 'wallet-1',
      txHash,
      merkleRoot: `0x${'12'.repeat(32)}`,
      expectedJob,
    })).rejects.toThrow('changed from validated before the broadcast transition');

    const committed = await publisher.getStatus(jobId);
    expect(committed?.status).toBe('validated');
    expect(committed?.claim?.walletId).toBe('wallet-2');
    expect(committed?.claim?.claimToken).toBe(validatedB?.claim?.claimToken);
    expect(committed?.validation?.authorityProofRef).toBe('attempt-b');
    expect(committed?.broadcast).toBeUndefined();
    expect(await internals.readWalletLock('wallet-1')).toBeNull();
    expect((await internals.readWalletLock('wallet-2'))?.claimToken).toBe(
      validatedB?.claim?.claimToken,
    );
  });

  it('only treats the same tx and wallet as an idempotent broadcast callback', async () => {
    const firstTxHash = `0x${'d5'.repeat(32)}` as `0x${string}`;
    const secondTxHash = `0x${'d6'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher();
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    const expectedJob = await publisher.getStatus(jobId);
    if (!expectedJob) throw new Error('expected validated job');
    const internals = publisher as unknown as {
      recordKnowledgeAssetVmPublishBroadcastProgress(params: {
        jobId: string;
        walletId: string;
        txHash: `0x${string}`;
        merkleRoot: `0x${string}`;
        expectedJob: LiftJob;
      }): Promise<boolean>;
    };
    const base = {
      jobId,
      walletId: 'wallet-1',
      merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
      expectedJob,
    };

    await expect(internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      ...base,
      txHash: firstTxHash,
    })).resolves.toBe(true);
    await expect(internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      ...base,
      txHash: firstTxHash,
    })).resolves.toBe(true);
    await expect(internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      ...base,
      txHash: secondTxHash,
    })).rejects.toThrow('already broadcast by a different transaction attempt');

    const committed = await publisher.getStatus(jobId);
    expect(committed?.status).toBe('broadcast');
    expect(committed?.broadcast?.txHash).toBe(firstTxHash);
    expect(committed?.broadcast?.walletId).toBe('wallet-1');
  });

  it('serializes the no-update fallback with an ordinary concurrent status writer', async () => {
    const txHash = `0x${'d1'.repeat(32)}` as `0x${string}`;
    const storeWithoutUpdate = new Proxy(store, {
      get(target, property) {
        if (property === 'update') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const publisher = createPublisher({}, storeWithoutUpdate);
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    const expectedJob = await publisher.getStatus(jobId);
    if (!expectedJob) throw new Error('expected validated job');

    let releaseWriteLane!: () => void;
    let writeLaneEntered!: () => void;
    const writeLaneGate = new Promise<void>((resolve) => { releaseWriteLane = resolve; });
    const didEnterWriteLane = new Promise<void>((resolve) => { writeLaneEntered = resolve; });
    let failureReachedWriter!: () => void;
    const failureDidReachWriter = new Promise<void>((resolve) => { failureReachedWriter = resolve; });
    const internals = publisher as unknown as {
      withJobWriteLock<T>(fn: () => Promise<T>): Promise<T>;
      writeJob(job: { status: string }, options?: unknown): Promise<unknown>;
      recordKnowledgeAssetVmPublishBroadcastProgress(params: {
        jobId: string;
        walletId: string;
        txHash: `0x${string}`;
        merkleRoot: `0x${string}`;
        expectedJob: LiftJob;
      }): Promise<boolean>;
    };
    const originalWriteJob = internals.writeJob.bind(publisher);
    internals.writeJob = async (job, options) => {
      if (job.status === 'failed') failureReachedWriter();
      return originalWriteJob(job, options);
    };
    const blocker = internals.withJobWriteLock(async () => {
      writeLaneEntered();
      await writeLaneGate;
    });
    await didEnterWriteLane;

    const concurrentFailure = publisher.update(jobId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'validated',
        code: 'canonicalization_failed',
        message: 'concurrent no-update failure',
        errorPayloadRef: `urn:dkg:publisher:error:${jobId}`,
      }),
    } as never);
    await failureDidReachWriter;
    const staleBroadcast = internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      jobId,
      walletId: 'wallet-1',
      txHash,
      merkleRoot: `0x${'12'.repeat(32)}`,
      expectedJob,
    });

    releaseWriteLane();
    await blocker;
    await concurrentFailure;
    await expect(staleBroadcast).rejects.toThrow(
      'changed from validated before the broadcast transition',
    );
    const committed = await publisher.getStatus(jobId);
    expect(committed?.status).toBe('failed');
    expect(committed?.failure?.message).toBe('concurrent no-update failure');
    expect(committed?.broadcast).toBeUndefined();
  });

  it('rejects an ABA reclaim before the no-update fallback commit', async () => {
    const txHash = `0x${'d4'.repeat(32)}` as `0x${string}`;
    const storeWithoutUpdate = new Proxy(store, {
      get(target, property) {
        if (property === 'update') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    let claimTokens = 0;
    const publisher = createPublisher({
      claimTokenGenerator: () => `attempt-${++claimTokens}`,
    }, storeWithoutUpdate);
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'attempt-a',
        transitionType: 'CREATE',
      },
    });
    const expectedJob = await publisher.getStatus(jobId);
    if (!expectedJob) throw new Error('expected validated attempt A');

    const internals = publisher as unknown as {
      writeJob(
        job: LiftJob,
        options?: { expectedJob?: LiftJob; signal?: AbortSignal },
      ): Promise<'written' | 'conflict' | 'unsupported'>;
      recordKnowledgeAssetVmPublishBroadcastProgress(params: {
        jobId: string;
        walletId: string;
        txHash: `0x${string}`;
        merkleRoot: `0x${string}`;
        expectedJob: LiftJob;
      }): Promise<boolean>;
      readWalletLock(walletId: string): Promise<{ claimToken?: string } | null>;
    };
    const originalWriteJob = internals.writeJob.bind(publisher);
    let validatedB: LiftJob | null = null;
    internals.writeJob = async (job, options) => {
      const result = await originalWriteJob(job, options);
      if (!validatedB && options?.expectedJob) {
        // The conditional path just reported unsupported. Move the persisted
        // job through a complete ABA cycle before the fallback re-reads it.
        await expect(publisher.recover()).resolves.toBe(1);
        await publisher.claimNext('wallet-2');
        await publisher.update(jobId, 'validated', {
          validation: {
            canonicalRoots: ['urn:album:one', 'urn:album:two'],
            canonicalRootMap: {},
            swmQuadCount: 2,
            authorityProofRef: 'attempt-b',
            transitionType: 'CREATE',
          },
        });
        validatedB = await publisher.getStatus(jobId);
      }
      return result;
    };

    await expect(internals.recordKnowledgeAssetVmPublishBroadcastProgress({
      jobId,
      walletId: 'wallet-1',
      txHash,
      merkleRoot: `0x${'12'.repeat(32)}`,
      expectedJob,
    })).rejects.toThrow('changed before the broadcast transition');

    const committed = await publisher.getStatus(jobId);
    expect(committed?.status).toBe('validated');
    expect(committed?.claim?.walletId).toBe('wallet-2');
    expect(committed?.claim?.claimToken).toBe(validatedB?.claim?.claimToken);
    expect(committed?.validation?.authorityProofRef).toBe('attempt-b');
    expect(committed?.broadcast).toBeUndefined();
    expect(await internals.readWalletLock('wallet-1')).toBeNull();
    expect((await internals.readWalletLock('wallet-2'))?.claimToken).toBe(
      validatedB?.claim?.claimToken,
    );
  });

  it('does not persist staged tx progress when a later write-ahead listener times out', async () => {
    const txHash = `0x${'de'.repeat(32)}` as `0x${string}`;
    let jobId = '';
    let releaseDelegate!: () => void;
    const delegateGate = new Promise<void>((resolve) => { releaseDelegate = resolve; });
    let delegateStarted!: () => void;
    const delegateDidStart = new Promise<void>((resolve) => { delegateStarted = resolve; });
    const durablePhases: string[] = [];
    let statusAfterLateHook: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;

    const publisher = createPublisher({
      resolvedSliceOverrides: {
        onPhase: async (phase, status, context) => {
          if (phase === 'chain:writeahead' && status === 'start') {
            delegateStarted();
            await delegateGate;
          }
          if (context?.signal?.aborted) return;
          durablePhases.push(`${phase}:${status}`);
        },
      },
      knowledgeAssetVmPublishExecutor: async (input) => {
        const controller = new AbortController();
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'start',
          markWriteAheadCompatibilityBreadcrumb({ signal: controller.signal }),
        );
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'end',
          markWriteAheadCompatibilityBreadcrumb({ signal: controller.signal }),
        );
        const lateHook = input.publishOptions.onPhase?.(
          'chain:writeahead',
          'start',
          { signal: controller.signal, txHash },
        );
        await delegateDidStart;

        // Model the adapter deadline: invalidate the generation first, then
        // allow the delayed listener to resolve.
        controller.abort();
        releaseDelegate();
        await lateHook;
        statusAfterLateHook = await publisher.getStatus(jobId);
        throw new Error('write-ahead hook timed out; transaction not broadcast');
      },
    });
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(statusAfterLateHook?.status).toBe('validated');
    expect(statusAfterLateHook?.broadcast).toBeUndefined();
    expect(durablePhases).toContain(`chain:txsigned:tx-${txHash}:start`);
    expect(durablePhases.some((phase) => phase.startsWith('chain:writeahead:'))).toBe(false);
    expect(processed?.status).toBe('failed');
    expect(processed?.broadcast).toBeUndefined();
  });

  it('does not begin the atomic broadcast transition when cancellation wins at its commit boundary', async () => {
    const txHash = `0x${'df'.repeat(32)}` as `0x${string}`;
    let jobId = '';
    const controller = new AbortController();
    let statusAfterCommit: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishExecutor: async (input) => {
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'start',
          markWriteAheadCompatibilityBreadcrumb({ signal: controller.signal }),
        );
        await input.publishOptions.onPhase?.(
          `chain:txsigned:tx-${txHash}`,
          'end',
          markWriteAheadCompatibilityBreadcrumb({ signal: controller.signal }),
        );
        await input.publishOptions.onPhase?.(
          'chain:writeahead',
          'start',
          { signal: controller.signal, txHash },
        );
        statusAfterCommit = await publisher.getStatus(jobId);
        throw new Error('write-ahead hook timed out; transaction not broadcast');
      },
    });
    const transitionOwner = publisher as unknown as {
      transitionJobIfActive: (params: unknown) => Promise<boolean>;
    };
    const originalTransition = transitionOwner.transitionJobIfActive.bind(publisher);
    transitionOwner.transitionJobIfActive = async (params) => {
      controller.abort();
      return originalTransition(params);
    };
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(controller.signal.aborted).toBe(true);
    expect(statusAfterCommit?.status).toBe('validated');
    expect(statusAfterCommit?.broadcast).toBeUndefined();
    expect(processed?.status).toBe('failed');
    expect(processed?.broadcast).toBeUndefined();
  });

  it('does not reset tx-bearing KA broadcast jobs to accepted on recovery timeout', async () => {
    const txHash = `0x${'ef'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher({ recoveryLookupTimeoutMs: 10 });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['urn:album:one', 'urn:album:two'],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash, walletId: 'wallet-1' },
    });
    now += 20;

    const recovered = await publisher.recover();
    const job = await publisher.getStatus(jobId);
    const lock = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);

    expect(recovered).toBe(1);
    expect(job?.status).toBe('failed');
    expect(job?.failure?.code).toBe('recovery_state_inconsistent');
    expect(job?.failure?.failedFromState).toBe('broadcast');
    expect(job?.failure?.message).toContain(txHash);
    expect(lock.type).toBe('bindings');
    if (lock.type !== 'bindings') return;
    expect(lock.bindings).toHaveLength(0);
  });
});
