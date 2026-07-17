import { describe, expect, it } from 'vitest';
import { createOperationContext, PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { resolveSyncGlobalBackpressure, SyncBackpressureBusyError, withGlobalSyncBackpressure } from '../src/sync/backpressure.js';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

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
};

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
): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'SyncFetchCoalescing',
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    ...backpressure,
  });
  (agent as any).messenger = { sendToPeer };
  (agent as any).buildSyncRequest = async () => new Uint8Array([1, 2, 3]);
  return agent;
}

function fetchPages(agent: DKGAgent, args: FetchArgs = {}): Promise<SyncPageResult> {
  return (agent as any).fetchSyncPages(
    createOperationContext('sync'),
    args.remotePeerId ?? PEER_A,
    args.contextGraphId ?? 'coalesced-cg',
    args.includeSharedMemory ?? false,
    args.phase ?? 'data',
    args.graphUri ?? 'did:dkg:context-graph:coalesced-cg',
    args.deadline ?? DEFAULT_DEADLINE,
    args.snapshotRef,
    args.sinceBatchId,
    args.signal,
    args.recovery,
  );
}

describe('DKGAgent sync fetch coalescing', () => {
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

  it('lets one waiter abort without aborting the shared fetch for another waiter', async () => {
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
      expect(sends).toBe(1);

      abort.abort(new Error('waiter aborted'));
      await expect(second).rejects.toMatchObject({ name: 'AbortError', message: 'waiter aborted' });

      response.resolve(new Uint8Array(0));
      await expect(first).resolves.toMatchObject({ quads: [] });
      expect(sends).toBe(1);
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
    (agent as any).fetchSyncPages = async (...args: unknown[]) => {
      fetchCalls++;
      const phase = String(args[4]);
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    };
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

  it('serializes different-budget durable syncs for the same peer and Context Graph', async () => {
    const firstMetaFetch = deferred<SyncPageResult>();
    let fetchCalls = 0;
    const agent = await createAgentWithSend(
      async () => new Uint8Array(0),
      { syncGlobalMaxInflight: 2, syncGlobalQueueLimit: 2 },
    );
    (agent as any).fetchSyncPages = async (...args: unknown[]) => {
      fetchCalls++;
      const phase = String(args[4]);
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    };
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
      // stream must wait instead of racing/superseding the first session.
      expect(fetchCalls).toBe(1);

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
    (agent as any).fetchSyncPages = async (...args: unknown[]) => {
      fetchCalls++;
      return emptySyncPage(String(args[4]));
    };
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
    (agent as any).fetchSyncPages = async (...args: unknown[]) => {
      fetchCalls++;
      const phase = String(args[4]);
      if (fetchCalls === 1) return firstMetaFetch.promise;
      return emptySyncPage(phase);
    };
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
    (agent as any).fetchSyncPages = async (...args: unknown[]) => emptySyncPage(String(args[4]));
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

  it('does not join catch-up rounds with different shareable identity fields', async () => {
    const cases: Array<{
      name: string;
      firstOptions?: { includeSharedMemory?: boolean; maxPeers?: number; peerRotationKey?: string };
      secondOptions?: { includeSharedMemory?: boolean; maxPeers?: number; peerRotationKey?: string };
    }> = [
      { name: 'includeSharedMemory', firstOptions: {}, secondOptions: { includeSharedMemory: true } },
      { name: 'maxPeers', firstOptions: { maxPeers: 1 }, secondOptions: { maxPeers: 2 } },
      { name: 'peerRotationKey', firstOptions: { peerRotationKey: 'a' }, secondOptions: { peerRotationKey: 'b' } },
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
});
