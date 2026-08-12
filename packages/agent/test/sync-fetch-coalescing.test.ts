import { describe, expect, it, vi } from 'vitest';
import {
  createOperationContext,
  PROTOCOL_SYNC,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKGAgent,
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
} from '../src/index.js';
import type { ContextGraphMembershipStore, SwmSnapshotCoverage } from '../src/dkg-agent-types.js';
import {
  getSyncBackpressureSnapshot,
  resolveSyncGlobalBackpressure,
  SyncBackpressureBusyError,
  withGlobalSyncBackpressure,
} from '../src/sync/backpressure.js';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import type { SyncCheckpointScope } from '../src/sync/checkpoint/state.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import {
  VmReconcileQueueClosedError,
  VmReconcileShutdownTimeoutError,
} from '../src/vm-reconcile-service.js';
import { stubLifecycleFetch } from './_helpers/sync-fetch-coalescing.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PEER_B = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';
const DEFAULT_DEADLINE = Date.UTC(2100, 0, 1);

type FetchArgs = {
  remotePeerId?: string;
  contextGraphId?: string;
  includeSharedMemory?: boolean;
  phase?: SyncPhase;
  graphUri?: string;
  deadline?: number;
  snapshotRef?: string;
  sinceBatchId?: string;
  signal?: AbortSignal;
  recovery?: boolean;
  manifestDigest?: `sha256:${string}`;
  assetUals?: string[];
  returnAcceptedPrefixOnRetryableTransportFailure?: boolean;
  requesterScope?: SyncCheckpointScope;
  maxAcceptedQuads?: number;
  maxAcceptedHeapBytesEstimate?: number;
};

const EXACT_UAL_7 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
const EXACT_UAL_8 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function cleanDurableSyncResult() {
  return {
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
  };
}

function cleanSharedMemorySyncResult() {
  return {
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 1,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
  };
}

function emptySyncPage(phase: string): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    responderSessionStartedFresh: true,
    nextOffset: 0,
    checkpointKey: `checkpoint:${phase}`,
    completed: true,
    timedOut: false,
  };
}

async function createAgentWithSend(
  sendToPeer: (...args: unknown[]) => Promise<Uint8Array>,
  backpressure?: {
    syncGlobalMaxInflight: number;
    syncGlobalQueueLimit: number;
    syncContextGraphPriorities?: Record<string, number>;
  },
  contextGraphMembershipStore?: ContextGraphMembershipStore,
): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'SyncFetchCoalescing',
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    contextGraphMembershipStore,
    ...backpressure,
  });
  (agent as any).messenger = { sendToPeer };
  (agent as any).buildSyncRequest = async () => new Uint8Array([1, 2, 3]);
  return agent;
}

describe('exact VM recovery lifecycle', () => {
  it('reopens reconcile and membership persistence admission on same-object restart', async () => {
    const membershipUpsert = vi.fn(async () => undefined);
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      undefined,
      {
        loadAll: async () => [],
        upsert: membershipUpsert,
        delete: async () => undefined,
      },
    );
    try {
      await agent.start();
      const initialGeneration = (agent as any).vmReconcileLifecycleGeneration;
      await agent.stop();
      expect((agent as any).vmReconcileRotationClosed).toBe(true);
      expect((agent as any).vmReconcileLifecycleGeneration).toBe(initialGeneration + 1);
      expect((agent as any).contextGraphMembershipPersistence.status().closed).toBe(true);

      await agent.start();
      expect((agent as any).vmReconcileRotationClosed).toBe(false);
      expect((agent as any).vmReconcileLifecycleGeneration).toBe(initialGeneration + 1);
      expect((agent as any).vmReconcileDispatcher.snapshot().closed).toBe(false);
      expect((agent as any).contextGraphMembershipPersistence.status().closed).toBe(false);
      const upsertsBeforeRestartProbe = membershipUpsert.mock.calls.length;
      await agent.upsertContextGraphMember({
        contextGraphId: 'restart-membership',
        principalType: 'node',
        principalId: PEER_A,
        status: 'active',
      }, { strict: true });
      expect(membershipUpsert).toHaveBeenCalledTimes(upsertsBeforeRestartProbe + 1);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('quarantines a physically active reconcile until shutdown is retried', async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
      ...timeoutDescriptor,
      value: 1,
    });
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const targetEntered = deferred<void>();
    const releaseTarget = deferred<void>();
    const heal = vi.fn(async () => undefined);
    try {
      await agent.start();
      const oldDispatcher = (agent as any).vmReconcileDispatcher;
      (agent as any).resolveVmReconcileTarget = async () => {
        targetEntered.resolve();
        await releaseTarget.promise;
        return {};
      };
      (agent as any).healStrandedScopedKCs = heal;

      const oldRun = (agent as any).runVmReconcileForCg('restart-retirement', 'manual');
      const oldOutcome = oldRun.catch((error: unknown) => error);
      await targetEntered.promise;
      await expect(agent.stop()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
      expect(oldDispatcher.snapshot()).toMatchObject({ active: 0, closed: true });
      await expect(oldOutcome).resolves.toBeInstanceOf(VmReconcileQueueClosedError);
      await expect(agent.start()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);

      releaseTarget.resolve();
      await (agent as any).vmReconcileRetirement;
      expect(heal).not.toHaveBeenCalled();
      await agent.stop();

      await agent.start();
      const newDispatcher = (agent as any).vmReconcileDispatcher;
      expect(newDispatcher).not.toBe(oldDispatcher);
      expect(newDispatcher.snapshot().closed).toBe(false);
    } finally {
      releaseTarget.resolve();
      await agent.stop().catch(() => {});
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS',
        timeoutDescriptor,
      );
    }
  });
});

function fetchPages(agent: DKGAgent, args: FetchArgs = {}): Promise<SyncPageResult> {
  return (agent as any).fetchSyncPages(
    createOperationContext('sync'),
    args.remotePeerId ?? PEER_A,
    args.contextGraphId ?? 'coalesced-cg',
    args.includeSharedMemory ?? false,
    args.phase ?? 'data',
    args.graphUri ?? 'did:dkg:context-graph:coalesced-cg',
    args.deadline ?? DEFAULT_DEADLINE,
    {
      snapshotRef: args.snapshotRef,
      sinceBatchId: args.sinceBatchId,
      signal: args.signal,
      recovery: args.recovery,
      manifestDigest: args.manifestDigest,
      assetUals: args.assetUals,
      returnAcceptedPrefixOnRetryableTransportFailure:
        args.returnAcceptedPrefixOnRetryableTransportFailure,
      requesterScope: args.requesterScope,
      maxAcceptedQuads: args.maxAcceptedQuads,
      maxAcceptedHeapBytesEstimate: args.maxAcceptedHeapBytesEstimate,
    },
  );
}

describe('DKGAgent sync fetch coalescing', () => {
  it('normalizes the legacy positional fetch tail without losing snapshot scope', async () => {
    const buildSyncRequest = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    (agent as any).buildSyncRequest = buildSyncRequest;

    try {
      await agent.fetchSyncPages(
        createOperationContext('sync'),
        PEER_A,
        'legacy-positional-cg',
        true,
        'snapshot',
        '',
        DEFAULT_DEADLINE,
        'legacy-snapshot-ref',
        'legacy-batch-id',
        undefined,
        true,
        true,
        [EXACT_UAL_7],
      );

      expect(buildSyncRequest).toHaveBeenCalledWith(
        'legacy-positional-cg',
        0,
        expect.any(Number),
        true,
        PEER_A,
        'snapshot',
        'legacy-snapshot-ref',
        'legacy-batch-id',
        undefined,
        true,
        [EXACT_UAL_7],
      );
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('joins concurrent identical fetches onto one sync page sequence', async () => {
    const response = deferred<Uint8Array>();
    let sends = 0;
    const agent = await createAgentWithSend(async () => {
      sends++;
      return response.promise;
    });

    try {
      const first = fetchPages(agent);
      await flushMicrotasks();
      const second = fetchPages(agent);
      await flushMicrotasks();

      expect(sends).toBe(1);
      response.resolve(new Uint8Array(0));
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(secondResult);
      expect(firstResult.quads).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not coalesce different sync identity keys', async () => {
    const cases: Array<{ name: string; base: FetchArgs; variant: FetchArgs }> = [
      { name: 'remotePeerId', base: {}, variant: { remotePeerId: PEER_B } },
      { name: 'contextGraphId', base: {}, variant: { contextGraphId: 'other-cg', graphUri: 'did:dkg:context-graph:other-cg' } },
      { name: 'includeSharedMemory', base: {}, variant: { includeSharedMemory: true, graphUri: 'did:dkg:context-graph:coalesced-cg/_shared_memory' } },
      { name: 'phase', base: {}, variant: { phase: 'meta', graphUri: 'did:dkg:context-graph:coalesced-cg/_meta' } },
      { name: 'graphUri', base: {}, variant: { graphUri: 'did:dkg:context-graph:coalesced-cg/_alternate' } },
      {
        name: 'snapshotRef',
        base: { includeSharedMemory: true, phase: 'snapshot', graphUri: '', snapshotRef: 'snapshot-a' },
        variant: { includeSharedMemory: true, phase: 'snapshot', graphUri: '', snapshotRef: 'snapshot-b' },
      },
      { name: 'sinceBatchId', base: { sinceBatchId: '10' }, variant: { sinceBatchId: '11' } },
      { name: 'recovery', base: { includeSharedMemory: true, recovery: false }, variant: { includeSharedMemory: true, recovery: true } },
      {
        name: 'manifestDigest',
        base: { manifestDigest: `sha256:${'aa'.repeat(32)}` },
        variant: { manifestDigest: `sha256:${'bb'.repeat(32)}` },
      },
      // Exact VM batches: different asset filters must never share a page
      // sequence, and an exact batch must never join a full sync.
      { name: 'assetUals', base: { assetUals: [EXACT_UAL_7] }, variant: { assetUals: [EXACT_UAL_8] } },
      { name: 'assetUals-vs-full', base: {}, variant: { assetUals: [EXACT_UAL_7] } },
      {
        name: 'returnAcceptedPrefixOnRetryableTransportFailure',
        base: {},
        variant: { returnAcceptedPrefixOnRetryableTransportFailure: true },
      },
      { name: 'requesterScope', base: {}, variant: { requesterScope: 'selected-swm-meta:test' } },
      { name: 'maxAcceptedQuads', base: {}, variant: { maxAcceptedQuads: 10 } },
      { name: 'maxAcceptedHeapBytesEstimate', base: {}, variant: { maxAcceptedHeapBytesEstimate: 4096 } },
    ];

    for (const testCase of cases) {
      const response = deferred<Uint8Array>();
      let sends = 0;
      const agent = await createAgentWithSend(async () => {
        sends++;
        return response.promise;
      });

      try {
        const first = fetchPages(agent, testCase.base);
        await flushMicrotasks();
        const second = fetchPages(agent, testCase.variant);
        await flushMicrotasks();

        expect(sends, testCase.name).toBe(2);
        response.resolve(new Uint8Array(0));
        await Promise.all([first, second]);
      } finally {
        await agent.stop().catch(() => {});
      }
    }
  });

  it('coalesces equivalent fetches whose callers computed different deadlines', async () => {
    const response = deferred<Uint8Array>();
    let sends = 0;
    const agent = await createAgentWithSend(async () => {
      sends++;
      return response.promise;
    });

    try {
      const first = fetchPages(agent, { deadline: DEFAULT_DEADLINE });
      await flushMicrotasks();
      const second = fetchPages(agent, { deadline: DEFAULT_DEADLINE + 1 });
      await flushMicrotasks();

      expect(sends).toBe(1);
      response.resolve(new Uint8Array(0));
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(secondResult);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('clears the in-flight entry after success and after failure', async () => {
    let sends = 0;
    let failParser = true;
    const agent = await createAgentWithSend(async () => {
      sends++;
      return new TextEncoder().encode('<not-valid-nquads>');
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      parseAndFilter: async () => {
        if (failParser) throw new Error('parse failed');
        return { quads: [], totalQuads: 0 };
      },
    });

    try {
      await expect(fetchPages(agent)).rejects.toThrow('parse failed');
      expect(sends).toBe(1);

      failParser = false;
      await expect(fetchPages(agent)).resolves.toMatchObject({ quads: [] });
      expect(sends).toBe(2);

      await expect(fetchPages(agent)).resolves.toMatchObject({ quads: [] });
      expect(sends).toBe(3);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('isolates a signal-bounded fetch from a background shared fetch', async () => {
    const response = deferred<Uint8Array>();
    let sends = 0;
    const agent = await createAgentWithSend(async () => {
      sends++;
      return response.promise;
    });
    const abort = new AbortController();

    try {
      const first = fetchPages(agent);
      await flushMicrotasks();
      const second = fetchPages(agent, { signal: abort.signal });
      await flushMicrotasks();
      expect(sends).toBe(2);

      abort.abort(new Error('waiter aborted'));
      await expect(second).rejects.toMatchObject({ name: 'AbortError', message: 'waiter aborted' });

      response.resolve(new Uint8Array(0));
      await expect(first).resolves.toMatchObject({ quads: [] });
      expect(sends).toBe(2);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('aborts the shared fetch when the last waiter aborts', async () => {
    let sends = 0;
    let sendSignal: AbortSignal | undefined;
    const abortObserved = deferred<void>();
    const agent = await createAgentWithSend(async (...args: unknown[]) => {
      sends++;
      const options = args[3] as { signal?: AbortSignal };
      sendSignal = options.signal;
      return new Promise<Uint8Array>((_resolve, reject) => {
        const rejectAbort = () => {
          abortObserved.resolve();
          const err = new Error('shared fetch aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal?.aborted) {
          rejectAbort();
          return;
        }
        options.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    });
    const abort = new AbortController();

    try {
      const waiter = fetchPages(agent, { signal: abort.signal });
      await flushMicrotasks();
      expect(sends).toBe(1);
      expect(sendSignal?.aborted).toBe(false);

      abort.abort(new Error('only waiter aborted'));
      await expect(waiter).rejects.toMatchObject({ name: 'AbortError', message: 'only waiter aborted' });
      await abortObserved.promise;
      expect(sendSignal?.aborted).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('joins concurrent direct durable syncs and clears the entry after settle', async () => {
    const firstMetaFetch = deferred<SyncPageResult>();
    let fetchCalls = 0;
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
    );
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      const first = (agent as any).syncFromPeerDetailed(PEER_A, ['coalesced-cg']);
      const second = (agent as any).syncFromPeerDetailed(PEER_A, ['coalesced-cg']);
      await waitFor(() => fetchCalls === 1);
      expect(fetchCalls).toBe(1);

      firstMetaFetch.resolve(emptySyncPage('meta'));
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(secondResult);
      expect(fetchCalls).toBe(2);

      const third = (agent as any).syncFromPeerDetailed(PEER_A, ['coalesced-cg']);
      await expect(third).resolves.toMatchObject({ failedPeers: 0 });
      expect(fetchCalls).toBe(4);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not join direct durable syncs with different admission priorities', async () => {
    let fetchCalls = 0;
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      const background = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { priority: 0 },
      );
      const foreground = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { priority: FOREGROUND_CATCHUP_SYNC_PRIORITY },
      );

      const [backgroundResult, foregroundResult] = await Promise.all([background, foreground]);
      expect(backgroundResult).not.toBe(foregroundResult);
      expect(fetchCalls).toBe(4);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not single-flight exact VM syncs with different asset batches', async () => {
    let fetchCalls = 0;
    const exactRecoveryDeadlineHeadroom: number[] = [];
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    stubLifecycleFetch(agent, async ({ phase, deadline }) => {
      fetchCalls++;
      exactRecoveryDeadlineHeadroom.push(deadline - Date.now());
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      // Different exact batches: two separate runs (2 phases each).
      const first = (agent as any).syncExactKnowledgeAssetsFromPeer(PEER_A, 'coalesced-cg', [EXACT_UAL_7]);
      const second = (agent as any).syncExactKnowledgeAssetsFromPeer(PEER_A, 'coalesced-cg', [EXACT_UAL_8]);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).not.toBe(secondResult);
      expect(fetchCalls).toBe(4);

      // The identical exact batch single-flights onto one run.
      fetchCalls = 0;
      const third = (agent as any).syncExactKnowledgeAssetsFromPeer(PEER_A, 'coalesced-cg', [EXACT_UAL_7]);
      const fourth = (agent as any).syncExactKnowledgeAssetsFromPeer(PEER_A, 'coalesced-cg', [EXACT_UAL_7]);
      const [thirdResult, fourthResult] = await Promise.all([third, fourth]);
      expect(thirdResult).toBe(fourthResult);
      expect(fetchCalls).toBe(2);
      expect(exactRecoveryDeadlineHeadroom).toHaveLength(6);
      expect(exactRecoveryDeadlineHeadroom.every(
        (remainingMs) => remainingMs > 599_000 && remainingMs <= 600_000,
      )).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('shares one physical exact outcome across public and detailed joiners', async () => {
    const firstMetaFetch = deferred<SyncPageResult>();
    let fetchCalls = 0;
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      consumedUnpersistedMetaTriples: 0,
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      const publicResult = (agent as any).syncExactKnowledgeAssetsFromPeer(
        PEER_A,
        'coalesced-cg',
        [EXACT_UAL_7],
      );
      await waitFor(() => fetchCalls === 1);
      const detailedResult = (agent as any).syncExactKnowledgeAssetsFromPeerDetailed(
        PEER_A,
        'coalesced-cg',
        [EXACT_UAL_7],
      );
      firstMetaFetch.resolve(emptySyncPage('meta'));

      const [projected, detailed] = await Promise.all([publicResult, detailedResult]);
      expect(fetchCalls).toBe(2);
      expect(projected).toBe(detailed.result);
      expect(projected).not.toHaveProperty('disposition');
      expect(detailed.disposition).toBe('clean-absent');

      fetchCalls = 0;
      const firstDetailed = (agent as any).syncExactKnowledgeAssetsFromPeerDetailed(
        PEER_A,
        'coalesced-cg',
        [EXACT_UAL_7],
      );
      const secondDetailed = (agent as any).syncExactKnowledgeAssetsFromPeerDetailed(
        PEER_A,
        'coalesced-cg',
        [EXACT_UAL_7],
      );
      const [first, second] = await Promise.all([firstDetailed, secondDetailed]);
      expect(fetchCalls).toBe(2);
      expect(first.result).toBe(second.result);
      expect(first.disposition).toBe('clean-absent');
      expect(second.disposition).toBe('clean-absent');

      fetchCalls = 0;
      const forwardOrder = (agent as any).syncExactKnowledgeAssetsFromPeer(
        PEER_A,
        'coalesced-cg',
        [EXACT_UAL_7, EXACT_UAL_8],
      );
      const reverseOrder = (agent as any).syncExactKnowledgeAssetsFromPeerDetailed(
        PEER_A,
        'coalesced-cg',
        [EXACT_UAL_8, EXACT_UAL_7],
      );
      const [forward, reverse] = await Promise.all([forwardOrder, reverseOrder]);
      expect(fetchCalls).toBe(2);
      expect(forward).toBe(reverse.result);
      expect(reverse.disposition).toBe('clean-absent');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('serializes different-budget durable syncs for the same peer and Context Graph', async () => {
    const firstMetaFetch = deferred<SyncPageResult>();
    let fetchCalls = 0;
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      { syncGlobalMaxInflight: 2, syncGlobalQueueLimit: 2 },
    );
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      const automatic = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs: 120_000 },
      );
      const recovery = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs: 299_000 },
      );
      await waitFor(() => fetchCalls === 1);
      // Different budgets remain separate operations, but the second physical
      // stream must wait outside admission instead of racing/superseding the
      // first session or occupying a second scarce slow-lane slot.
      expect(fetchCalls).toBe(1);
      expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 1, queued: 0 });

      firstMetaFetch.resolve(emptySyncPage('meta'));
      const [automaticResult, recoveryResult] = await Promise.all([automatic, recovery]);
      expect(automaticResult).not.toBe(recoveryResult);
      expect(fetchCalls).toBe(4);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not join direct durable syncs with callback side effects', async () => {
    let fetchCalls = 0;
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      await Promise.all([
        (agent as any).syncFromPeerDetailed(PEER_A, ['coalesced-cg'], () => undefined),
        (agent as any).syncFromPeerDetailed(PEER_A, ['coalesced-cg'], () => undefined),
      ]);
      expect(fetchCalls).toBe(4);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('joins concurrent direct shared-memory syncs and clears the entry after settle', async () => {
    const firstMetaFetch = deferred<SyncPageResult>();
    let fetchCalls = 0;
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
    );
    const sharedMemorySyncPlan = {
      eligibleContextGraphIds: ['coalesced-cg'],
      publicContextGraphIds: ['coalesced-cg'],
      privateRecoverFromCurator: [],
    };
    (agent as any).listSubGraphs = async () => [];
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 1,
        entityCreators: [],
      }),
    });

    try {
      const first = (agent as any).syncSharedMemoryFromPeerDetailed(PEER_A, ['coalesced-cg'], { sharedMemorySyncPlan });
      const second = (agent as any).syncSharedMemoryFromPeerDetailed(PEER_A, ['coalesced-cg'], { sharedMemorySyncPlan });
      await waitFor(() => fetchCalls === 1);
      expect(fetchCalls).toBe(1);

      firstMetaFetch.resolve(emptySyncPage('meta'));
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(secondResult);
      expect(fetchCalls).toBe(2);

      const third = (agent as any).syncSharedMemoryFromPeerDetailed(PEER_A, ['coalesced-cg'], { sharedMemorySyncPlan });
      await expect(third).resolves.toMatchObject({ failedPeers: 0 });
      expect(fetchCalls).toBe(4);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not join direct shared-memory syncs with different admission priorities', async () => {
    let fetchCalls = 0;
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const sharedMemorySyncPlan = {
      eligibleContextGraphIds: ['coalesced-cg'],
      publicContextGraphIds: ['coalesced-cg'],
      privateRecoverFromCurator: [],
    };
    (agent as any).listSubGraphs = async () => [];
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      return emptySyncPage(phase);
    });
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 1,
        entityCreators: [],
      }),
    });

    try {
      const background = (agent as any).syncSharedMemoryFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        { sharedMemorySyncPlan, priority: 0 },
      );
      const foreground = (agent as any).syncSharedMemoryFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        { sharedMemorySyncPlan, priority: FOREGROUND_CATCHUP_SYNC_PRIORITY },
      );

      const [backgroundResult, foregroundResult] = await Promise.all([background, foreground]);
      expect(backgroundResult).not.toBe(foregroundResult);
      expect(fetchCalls).toBe(4);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it.each([
    {
      name: 'private-only',
      eligibleContextGraphIds: ['private-cg'],
      publicContextGraphIds: [] as string[],
      privateRecoverFromCurator: ['private-cg'],
      expectedAdmissionLanes: ['swm-recovery:'],
    },
    {
      name: 'mixed public/private',
      eligibleContextGraphIds: ['public-cg', 'private-cg'],
      publicContextGraphIds: ['public-cg'],
      privateRecoverFromCurator: ['private-cg'],
      expectedAdmissionLanes: ['shared-memory:', 'swm-recovery:'],
      syncContextGraphPriorities: { 'private-cg': 100, 'public-cg': -10 },
    },
  ])('uses per-CG global admission for $name shared-memory aggregation', async ({
    eligibleContextGraphIds,
    publicContextGraphIds,
    privateRecoverFromCurator,
    expectedAdmissionLanes,
    syncContextGraphPriorities,
  }) => {
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0, syncContextGraphPriorities },
    );
    const backpressureLogs: string[] = [];
    (agent as any).log.info = (_ctx: unknown, message: string) => {
      if (message.startsWith('Sync backpressure ')) backpressureLogs.push(message);
    };
    (agent as any).listSubGraphs = async () => [];
    stubLifecycleFetch(agent, async ({ phase }) => emptySyncPage(phase));
    (agent as any).getOrCreateSyncVerifyWorker = () => ({
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 1,
        entityCreators: [],
      }),
    });

    try {
      await expect((agent as any).syncSharedMemoryFromPeerDetailed(
        PEER_A,
        eligibleContextGraphIds,
        {
          sharedMemorySyncPlan: {
            eligibleContextGraphIds,
            publicContextGraphIds,
            privateRecoverFromCurator,
          },
        },
      )).resolves.toMatchObject({ failedPeers: 0 });
      const runningAdmissions = backpressureLogs.filter((message) => (
        message.startsWith('Sync backpressure running ')
      ));
      expect(runningAdmissions).toHaveLength(expectedAdmissionLanes.length);
      for (const expectedLane of expectedAdmissionLanes) {
        expect(runningAdmissions.some((message) => message.includes(`running ${expectedLane}`))).toBe(true);
      }
      expect(runningAdmissions.map((message) => (
        expectedAdmissionLanes.find((lane) => message.includes(`running ${lane}`))
      ))).toEqual(syncContextGraphPriorities
        ? ['swm-recovery:', 'shared-memory:']
        : expectedAdmissionLanes);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('keeps standalone shared-memory recovery behind global admission', async () => {
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      { syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
    );
    const occupied = deferred<void>();
    const holder = withGlobalSyncBackpressure(
      {
        policy: resolveSyncGlobalBackpressure((agent as any).config),
        ctx: createOperationContext('sync'),
        label: 'occupied-slot',
      },
      () => occupied.promise,
    );
    await flushMicrotasks();

    try {
      await expect(
        agent.recoverContextGraphSwmFromPeer(PEER_A, 'private-cg'),
      ).rejects.toThrow(SyncBackpressureBusyError);
    } finally {
      occupied.resolve();
      await holder;
      await agent.stop().catch(() => {});
    }
  });

  it('joins concurrent catch-up rounds for the same context graph and mode', async () => {
    let durableResponse = deferred<ReturnType<typeof cleanDurableSyncResult>>();
    let durableSyncs = 0;
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const remotePeer = { toString: () => PEER_A };

    try {
      await agent.start();
      (agent as any).isPrivateContextGraph = async () => false;
      (agent as any).resolvePreferredSyncPeerId = async () => undefined;
      (agent as any).primeCatchupConnections = async () => undefined;
      (agent as any).ensurePeerAdmittedForRecovery = async () => true;
      (agent as any).waitForSyncProtocol = async () => true;
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent.node.libp2p as any).getConnections = () => [{ remotePeer }];
      (agent.node.libp2p.peerStore as any).get = async () => ({ protocols: [PROTOCOL_SYNC] });
      (agent as any).syncFromPeerDetailed = async () => {
        durableSyncs++;
        return durableResponse.promise;
      };

      const first = agent.syncContextGraphFromConnectedPeers('coalesced-cg');
      const second = agent.syncContextGraphFromConnectedPeers('coalesced-cg');
      await waitFor(() => durableSyncs === 1);

      expect(durableSyncs).toBe(1);
      durableResponse.resolve(cleanDurableSyncResult());
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(secondResult);
      expect(firstResult.peersTried).toBe(1);

      durableResponse = deferred<ReturnType<typeof cleanDurableSyncResult>>();
      const third = agent.syncContextGraphFromConnectedPeers('coalesced-cg');
      await waitFor(() => durableSyncs === 2);
      expect(durableSyncs).toBe(2);
      durableResponse.resolve(cleanDurableSyncResult());
      await expect(third).resolves.toMatchObject({ peersTried: 1 });
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('retries foreground durable admission before starting SWM in the agent path', async () => {
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const remotePeer = { toString: () => PEER_A };
    const order: string[] = [];
    const priorities: Array<number | undefined> = [];
    const sources: Array<string | undefined> = [];
    let durableCalls = 0;

    try {
      await agent.start();
      (agent as any).waitForSyncProtocol = async () => true;
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent as any).syncFromPeerDetailed = async (
        _peerId: string,
        _contextGraphIds: string[],
        _onPhase: unknown,
        _onAccessDenied: unknown,
        _sinceBatchIdFor: unknown,
        options: { priority?: number; source?: string } | undefined,
      ) => {
        durableCalls += 1;
        priorities.push(options?.priority);
        sources.push(options?.source);
        order.push(`durable-${durableCalls}`);
        return durableCalls === 1
          ? {
              ...cleanDurableSyncResult(),
              completedPhases: 0,
              deferredBackpressure: 1,
            }
          : cleanDurableSyncResult();
      };
      (agent as any).syncSharedMemoryFromPeerDetailed = async (
        _peerId: string,
        _contextGraphIds: string[],
        options: { priority?: number; source?: string } | undefined,
      ) => {
        priorities.push(options?.priority);
        sources.push(options?.source);
        order.push('shared');
        return cleanSharedMemorySyncResult();
      };

      const result = await (agent as any).runCatchupOverPeers(
        'coalesced-cg',
        true,
        [remotePeer],
        { mode: 'foreground' },
      );

      expect(result.deferredBackpressure).toBe(0);
      expect(order).toEqual(['durable-1', 'durable-2', 'shared']);
      expect(priorities).toEqual([
        FOREGROUND_CATCHUP_SYNC_PRIORITY,
        FOREGROUND_CATCHUP_SYNC_PRIORITY,
        FOREGROUND_CATCHUP_SYNC_PRIORITY,
      ]);
      // The admission ORIGIN travels with the priority on the in-agent runner
      // too: dropping it here while keeping the priority would silently report
      // inline foreground catch-up as `durable:unspecified` in node-wide
      // scheduler diagnostics (issue #2006).
      expect(sources).toEqual([
        'catchup-foreground',
        'catchup-foreground',
        'catchup-foreground',
      ]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not promote catch-up readiness when durable integrity verification rejects a KA', async () => {
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const remotePeer = { toString: () => PEER_A };

    try {
      await agent.start();
      agent.subscribeToContextGraph('coalesced-cg');
      (agent as any).isPrivateContextGraph = async () => false;
      (agent as any).resolvePreferredSyncPeerId = async () => undefined;
      (agent as any).primeCatchupConnections = async () => undefined;
      (agent as any).ensurePeerAdmittedForRecovery = async () => true;
      (agent as any).waitForSyncProtocol = async () => true;
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent.node.libp2p as any).getConnections = () => [{ remotePeer }];
      (agent.node.libp2p.peerStore as any).get = async () => ({ protocols: [PROTOCOL_SYNC] });
      (agent as any).syncFromPeerDetailed = async () => ({
        ...cleanDurableSyncResult(),
        insertedTriples: 3,
        insertedDataTriples: 3,
        rejectedKcs: 1,
      });

      const result = await agent.syncContextGraphFromConnectedPeers('coalesced-cg');

      expect(result.peersResponded).toBe(1);
      expect(result.peersSucceeded).toBe(0);
      expect(result.dataSynced).toBe(3);
      expect(result.diagnostics.durable.rejectedKcs).toBe(1);
      expect(agent.getSubscribedContextGraphs().get('coalesced-cg')?.synced).not.toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not promote subscription readiness from an explicitly incomplete durable result', async () => {
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const remotePeer = { toString: () => PEER_A };

    try {
      await agent.start();
      agent.subscribeToContextGraph('coalesced-cg');
      (agent as any).isPrivateContextGraph = async () => false;
      (agent as any).resolvePreferredSyncPeerId = async () => undefined;
      (agent as any).primeCatchupConnections = async () => undefined;
      (agent as any).ensurePeerAdmittedForRecovery = async () => true;
      (agent as any).waitForSyncProtocol = async () => true;
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent.node.libp2p as any).getConnections = () => [{ remotePeer }];
      (agent.node.libp2p.peerStore as any).get = async () => ({ protocols: [PROTOCOL_SYNC] });
      (agent as any).syncFromPeerDetailed = async () => ({
        ...cleanDurableSyncResult(),
        complete: false,
        insertedTriples: 40_000,
        fetchedDataTriples: 40_000,
        insertedDataTriples: 40_000,
        checkpointAdvances: 1,
      });

      const result = await agent.syncContextGraphFromConnectedPeers('coalesced-cg');

      expect(result.peersResponded).toBe(1);
      expect(result.dataSynced).toBe(40_000);
      expect(agent.getSubscribedContextGraphs().get('coalesced-cg')?.synced).not.toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not join catch-up rounds with different shareable identity fields', async () => {
    const cases: Array<{
      name: string;
      firstOptions?: {
        includeSharedMemory?: boolean;
        maxPeers?: number;
        peerRotationKey?: string;
        mode?: 'background' | 'foreground';
      };
      secondOptions?: {
        includeSharedMemory?: boolean;
        maxPeers?: number;
        peerRotationKey?: string;
        mode?: 'background' | 'foreground';
      };
    }> = [
      { name: 'includeSharedMemory', firstOptions: {}, secondOptions: { includeSharedMemory: true } },
      { name: 'maxPeers', firstOptions: { maxPeers: 1 }, secondOptions: { maxPeers: 2 } },
      { name: 'peerRotationKey', firstOptions: { peerRotationKey: 'a' }, secondOptions: { peerRotationKey: 'b' } },
      { name: 'mode', firstOptions: { mode: 'background' }, secondOptions: { mode: 'foreground' } },
    ];

    for (const testCase of cases) {
      let durableSyncs = 0;
      const agent = await createAgentWithSend(async () => new Uint8Array(0));
      const remotePeer = { toString: () => PEER_A };

      try {
        await agent.start();
        (agent as any).isPrivateContextGraph = async () => false;
        (agent as any).resolvePreferredSyncPeerId = async () => undefined;
        (agent as any).primeCatchupConnections = async () => undefined;
        (agent as any).ensurePeerAdmittedForRecovery = async () => true;
        (agent as any).waitForSyncProtocol = async () => true;
        (agent as any).refreshMetaSyncedFlags = async () => undefined;
        (agent.node.libp2p as any).getConnections = () => [{ remotePeer }];
        (agent.node.libp2p.peerStore as any).get = async () => ({ protocols: [PROTOCOL_SYNC] });
        (agent as any).syncFromPeerDetailed = async () => {
          durableSyncs++;
          return cleanDurableSyncResult();
        };
        (agent as any).syncSharedMemoryFromPeerDetailed = async () => cleanSharedMemorySyncResult();

        await Promise.all([
          agent.syncContextGraphFromConnectedPeers('coalesced-cg', testCase.firstOptions),
          agent.syncContextGraphFromConnectedPeers('coalesced-cg', testCase.secondOptions),
        ]);
        expect(durableSyncs, testCase.name).toBe(2);
      } finally {
        await agent.stop().catch(() => {});
      }
    }
  });

  // #2050. The IN-AGENT catch-up walk (`runCatchupOverPeers`) has to publish the
  // same SWM diagnostics the worker-backed CLI runner does, or a job that happens
  // to take the inline path reports a shortfall it cannot name while an identical
  // job through the worker names it fully. The aggregation is three statements
  // inside the `if (r.shared)` arm; deleting them leaves every other suite green,
  // which is exactly why this row exists.
  //
  // TWO peers, not one. With a single peer `+=` is indistinguishable from `=`, and
  // last-writer-wins is indistinguishable from whole-record selection — a one-peer
  // fixture here passes against a completely broken aggregator.
  it('preserves whole-record SWM coverage and sums snapshot-phase counters across catch-up peers', async () => {
    // Peer A: a LARGER manifest that is still 72 refs short. Peer B: a smaller
    // manifest that fully converged. This pair is chosen precisely because the
    // two plausible wrong reductions produce visibly wrong answers:
    //   - independent field-wise maxima yield 200/250, a state NO peer reported
    //     and one nothing downstream can detect as synthetic;
    //   - ranking by resolved/total picks B's 200/200 and reports "0 outstanding"
    //     on a graph that is 72 Knowledge Assets short.
    // `selectSwmSnapshotCoverage` ranks by LARGEST manifest, so A must win WHOLE.
    // Weakening either peer to the same snapshotsTotal would collapse the tie into
    // the peerIdSuffix tiebreak and stop testing the selection rule at all.
    const peerACoverage = (): SwmSnapshotCoverage => ({
      contextGraphId: 'coalesced-cg',
      peerIdSuffix: PEER_A.slice(-8),
      snapshotsResolved: 178,
      snapshotsTotal: 250,
      manifestComplete: true,
      // resolved + missing === total, by construction. A fixture that broke this
      // would be asserting a state the producer cannot emit.
      missingCount: 72,
      missingSample: ['swm-ref-a1', 'swm-ref-a2'],
      // Legal only because missingCount > 0: `materializationFailures > 0` with
      // `missingCount === 0` is unrepresentable (see SwmSnapshotCoverage docs).
      materializationFailures: 3,
      fromAuthority: false,
    });
    const peerBCoverage = (): SwmSnapshotCoverage => ({
      contextGraphId: 'coalesced-cg',
      peerIdSuffix: PEER_B.slice(-8),
      snapshotsResolved: 200,
      snapshotsTotal: 200,
      manifestComplete: true,
      missingCount: 0,
      missingSample: [],
      materializationFailures: 0,
      fromAuthority: false,
    });

    // Distinct NON-ZERO values on both peers for every summed counter, and sums
    // that equal neither operand. If either peer contributed 0, or the two
    // contributed the same value, `=` would be indistinguishable from `+=`.
    // Per-peer `bytesReceived` is kept equal to replay + snapshot so the
    // aggregate preserves the documented identity
    // `replayPhaseBytesReceived + snapshotPhaseBytesReceived === bytesReceived`.
    const peerARound = {
      swmCoverage: peerACoverage(),
      snapshotPlaneIncomplete: 1,
      replayPhaseBytesReceived: 4_096,
      snapshotPhaseBytesReceived: 65_536,
      bytesReceived: 69_632,
    };
    const peerBRound = {
      swmCoverage: peerBCoverage(),
      snapshotPlaneIncomplete: 2,
      replayPhaseBytesReceived: 1_024,
      snapshotPhaseBytesReceived: 16_384,
      bytesReceived: 17_408,
    };

    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const peerA = { toString: () => PEER_A };
    const peerB = { toString: () => PEER_B };
    const sharedSyncPeers: string[] = [];

    try {
      await agent.start();
      (agent as any).isPrivateContextGraph = async () => false;
      // No preferred peer and no core peers, so `orderCatchupPeers` returns the
      // connection order untouched: A is walked first, B last. That ordering is
      // load-bearing — it is what makes last-writer-wins select B and fail the
      // whole-record assertion below.
      (agent as any).resolvePreferredSyncPeerId = async () => undefined;
      (agent as any).primeCatchupConnections = async () => undefined;
      (agent as any).ensurePeerAdmittedForRecovery = async () => true;
      (agent as any).waitForSyncProtocol = async () => true;
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent.node.libp2p as any).getConnections = () => [
        { remotePeer: peerA },
        { remotePeer: peerB },
      ];
      (agent.node.libp2p.peerStore as any).get = async () => ({ protocols: [PROTOCOL_SYNC] });
      (agent as any).syncFromPeerDetailed = async () => cleanDurableSyncResult();
      (agent as any).syncSharedMemoryFromPeerDetailed = async (remotePeerId: string) => {
        sharedSyncPeers.push(remotePeerId);
        // Fresh objects per call: returning a shared const would let an
        // in-place mutation of the coverage record pass unnoticed, because the
        // expected value below would mutate with it.
        return {
          ...cleanSharedMemorySyncResult(),
          ...(remotePeerId === PEER_A ? peerARound : peerBRound),
          swmCoverage: remotePeerId === PEER_A ? peerACoverage() : peerBCoverage(),
        };
      };

      const result = await (agent as any).runCatchupOverPeers(
        'coalesced-cg',
        true,
        [peerA, peerB],
        { swmCatchupPassConfig: { budgetMs: 0, maxPasses: 4 } },
      );

      // Guard the fixture itself: if the SWM plane were skipped (for example by
      // a durable result carrying deferredBackpressure), every assertion below
      // would read zeros and "pass" a broken aggregator by accident.
      expect(sharedSyncPeers.sort()).toEqual([PEER_A, PEER_B].sort());
      expect(result.peersTried).toBe(2);

      const swm = result.diagnostics.sharedMemory;

      // WHOLE-RECORD selection. Compared as one object on purpose: a per-field
      // reduction that took max(resolved)=200 from B and max(total)=250 from A
      // would satisfy any pair of independent per-field assertions while
      // describing a round no peer ever ran.
      expect(swm.swmCoverage).toEqual(peerACoverage());
      // Spelled out as well, because these three are the fields an operator
      // reads and the ones a synthetic mix corrupts: all three must come from A.
      expect(swm.swmCoverage?.snapshotsResolved).toBe(178);
      expect(swm.swmCoverage?.snapshotsTotal).toBe(250);
      expect(swm.swmCoverage?.peerIdSuffix).toBe(PEER_A.slice(-8));
      // B's converged record must not survive anywhere in the selected row.
      expect(swm.swmCoverage?.missingCount).toBe(72);

      // SUMMATION across both peers. Each expected value differs from both
      // operands, so neither `=` (last write) nor a dropped forward can produce it.
      expect(swm.snapshotPlaneIncomplete).toBe(3); // 1 + 2
      expect(swm.replayPhaseBytesReceived).toBe(5_120); // 4_096 + 1_024
      expect(swm.snapshotPhaseBytesReceived).toBe(81_920); // 65_536 + 16_384
      // The documented split identity has to survive aggregation, not just hold
      // per round: replay + snapshot must still account for every byte received.
      expect(swm.bytesReceived).toBe(87_040); // 69_632 + 17_408
      expect(
        (swm.replayPhaseBytesReceived ?? 0) + (swm.snapshotPhaseBytesReceived ?? 0),
      ).toBe(swm.bytesReceived);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('runs the bounded SWM continuation policy on the inline agent path', async () => {
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    const remotePeer = { toString: () => PEER_A };
    const durableCalls: string[] = [];
    const sharedCalls: string[] = [];

    const coverage = (resolved: number): SwmSnapshotCoverage => ({
      contextGraphId: 'coalesced-cg',
      peerIdSuffix: PEER_A.slice(-8),
      snapshotsResolved: resolved,
      snapshotsTotal: 3,
      manifestComplete: true,
      missingCount: 3 - resolved,
      missingSample: resolved < 3 ? ['sha256:remaining'] : [],
      materializationFailures: 0,
    });

    try {
      await agent.start();
      (agent as any).isPrivateContextGraph = async () => false;
      (agent as any).resolvePreferredSyncPeerId = async () => undefined;
      (agent as any).primeCatchupConnections = async () => undefined;
      (agent as any).ensurePeerAdmittedForRecovery = async () => true;
      (agent as any).waitForSyncProtocol = async () => true;
      (agent as any).refreshMetaSyncedFlags = async () => undefined;
      (agent.node.libp2p as any).getConnections = () => [{ remotePeer }];
      (agent.node.libp2p.peerStore as any).get = async () => ({ protocols: [PROTOCOL_SYNC] });
      (agent as any).syncFromPeerDetailed = async (peerId: string) => {
        durableCalls.push(peerId);
        return cleanDurableSyncResult();
      };
      (agent as any).syncSharedMemoryFromPeerDetailed = async (peerId: string) => {
        sharedCalls.push(peerId);
        const resolved = sharedCalls.length === 1 ? 2 : 3;
        return {
          ...cleanSharedMemorySyncResult(),
          ...(resolved < 3 ? { failedPhases: 1, snapshotPlaneIncomplete: 1 } : {}),
          swmCoverage: coverage(resolved),
        };
      };

      const result = await agent.syncContextGraphFromConnectedPeers('coalesced-cg', {
        includeSharedMemory: true,
      });

      expect(durableCalls).toEqual([PEER_A]);
      expect(sharedCalls).toEqual([PEER_A, PEER_A]);
      expect(result.diagnostics.sharedMemory.swmCoverage).toEqual(coverage(3));
      expect(result.diagnostics.sharedMemory.continuationPasses).toBe(1);
      expect(result.diagnostics.sharedMemory.continuationStopReason).toBe('no-capable-peers');
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
