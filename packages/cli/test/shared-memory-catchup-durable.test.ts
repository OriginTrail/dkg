import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import type { DurableSyncResult } from '@origintrail-official/dkg-agent';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = (body: string) => {
    res.body = body;
    res.writableEnded = true;
  };
  return res;
}

function fakeReq(body: unknown) {
  return {
    method: 'POST',
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

function buildCatchupCtx(body: unknown, agent: Record<string, any>) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/shared-memory/catchup');
  const ctx = {
    req: fakeReq(body),
    res,
    agent,
    path: url.pathname,
    url,
  } as unknown as RequestContext;
  return { ctx, res };
}

function detailedDurableResult(overrides: Partial<DurableSyncResult> = {}): DurableSyncResult {
  return {
    insertedTriples: 0,
    complete: true,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 2,
    checkpointAdvances: 0,
    deniedPhases: 0,
    emptyResponses: 0,
    metaOnlyResponses: 0,
    verifiedPrivateOnlyResponses: 0,
    dataRejectedMissingMeta: 0,
    rejectedKcs: 0,
    failedPeers: 0,
    failedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
    ...overrides,
  };
}

describe('POST /api/shared-memory/catchup durable leg', () => {
  it('returns a retryable 503 when no connected peer can attempt durable catchup', async () => {
    const agent = {
      peerId: 'self-peer',
      node: { libp2p: { getConnections: vi.fn(() => []) } },
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'durable-no-peer-cg',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'DURABLE_CATCHUP_NO_ELIGIBLE_PEERS',
      durableComplete: false,
      peersAttempted: 0,
      totalDurableInsertedTriples: 0,
      results: [],
    });
    expect(agent.getPeerProtocols).not.toHaveBeenCalled();
  });

  it('supports durable-only recovery without starting either SWM catchup path', async () => {
    const cgId = 'private-durable-only-cg';
    const peerId = 'peer-curator';
    const syncSharedMemoryFromPeerDetailed = vi.fn();
    const syncSharedMemoryFromPeer = vi.fn();
    const catchupSwmFromConnectedHosts = vi.fn();
    const syncFromPeer = vi.fn(async () => 19);
    const agent = {
      peerId: 'self-peer',
      canUseSharedMemoryForContextGraph: vi.fn(async () => true),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => true),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({
        curatorIsLocal: false,
        peerIds: [peerId],
      })),
      syncSharedMemoryFromPeerDetailed,
      syncSharedMemoryFromPeer,
      catchupSwmFromConnectedHosts,
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: cgId,
        peerId,
        includeSharedMemory: false,
        includeDurable: true,
        perPeerDurableBudgetMs: 300_000,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(agent.canUseSharedMemoryForContextGraph).not.toHaveBeenCalled();
    expect(syncSharedMemoryFromPeerDetailed).not.toHaveBeenCalled();
    expect(syncSharedMemoryFromPeer).not.toHaveBeenCalled();
    expect(catchupSwmFromConnectedHosts).not.toHaveBeenCalled();
    expect(syncFromPeer).toHaveBeenCalledTimes(1);
    expect(syncFromPeer).toHaveBeenCalledWith(
      peerId,
      [cgId],
      undefined,
      undefined,
      { totalTimeoutMs: 299_000 },
    );

    const body = JSON.parse(res.body);
    expect(body.includeSharedMemory).toBe(false);
    expect(body.includeDurable).toBe(true);
    expect(body.totalInsertedTriples).toBe(0);
    expect(body.totalDurableInsertedTriples).toBe(19);
    expect(body.hostCatchup).toEqual({
      ranFallback: false,
      triggeredForContextGraphIds: [],
      appliedTotal: 0,
      appliedEnvelopes: 0,
      perContextGraph: [],
    });
  });

  it('preserves committed progress and returns 503 when a timed-out durable phase hard-fails', async () => {
    const syncFromPeer = vi.fn();
    const syncFromPeerDetailed = vi.fn(async () => detailedDurableResult({
      insertedTriples: 77_767,
      insertedMetaTriples: 570,
      insertedDataTriples: 77_197,
      fetchedMetaTriples: 1_200,
      fetchedDataTriples: 159_744,
      completedPhases: 0,
      timedOutPhases: 1,
      failedPhases: 1,
      backoffWorthyFailures: 1,
      complete: false,
    }));
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeer,
      syncFromPeerDetailed,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'agent-blackbox-vm',
        peerId: 'peer-core',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    expect(syncFromPeer).not.toHaveBeenCalled();
    expect(syncFromPeerDetailed).toHaveBeenCalledWith(
      'peer-core',
      ['agent-blackbox-vm'],
      undefined,
      undefined,
      undefined,
      { totalTimeoutMs: 109_000 },
    );
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      durableComplete: false,
      totalDurableInsertedTriples: 77_767,
      results: [{
        peerId: 'peer-core',
        durableInsertedTriples: 77_767,
        durableComplete: false,
        durableError: 'Durable sync did not complete (failedPhases=1)',
      }],
      perContextGraph: [{
        contextGraphId: 'agent-blackbox-vm',
        durableComplete: false,
        perPeer: [{
          durableComplete: false,
          durableDiagnostics: {
            insertedDataTriples: 77_197,
            insertedMetaTriples: 570,
            timedOutPhases: 1,
            failedPhases: 1,
          },
        }],
      }],
    });
  });

  it.each([
    ['rejectedKcs', { rejectedKcs: 1 }],
    ['dataRejectedMissingMeta', { dataRejectedMissingMeta: 1 }],
    ['deniedPhases', { deniedPhases: 1 }],
  ] as const)('returns 503 and preserves progress for a %s hard failure', async (counter, failure) => {
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed: vi.fn(async () => detailedDurableResult({
        insertedTriples: 12,
        insertedDataTriples: 10,
        insertedMetaTriples: 2,
        completedPhases: 1,
        complete: false,
        ...failure,
      })),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'agent-blackbox-vm',
        peerId: 'peer-core',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      durableComplete: false,
      totalDurableInsertedTriples: 12,
      results: [{
        peerId: 'peer-core',
        durableInsertedTriples: 12,
        durableComplete: false,
        durableError: `Durable sync did not complete (${counter}=1)`,
      }],
    });
  });

  it('reports a safely checkpointed timeout as retryable incomplete progress', async () => {
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed: vi.fn(async () => detailedDurableResult({
        insertedTriples: 155_858,
        insertedDataTriples: 155_000,
        insertedMetaTriples: 858,
        timedOutPhases: 1,
        completedPhases: 1,
        checkpointAdvances: 1,
        complete: false,
      })),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'agent-blackbox-vm',
        peerId: 'peer-core',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'DURABLE_CATCHUP_INCOMPLETE',
      durableComplete: false,
      totalDurableInsertedTriples: 155_858,
      results: [{
        peerId: 'peer-core',
        durableInsertedTriples: 155_858,
        durableComplete: false,
      }],
    });
    expect(JSON.parse(res.body).results[0].durableError).toBeUndefined();
  });

  it('returns a retryable 503 for a zero-progress incomplete durable attempt', async () => {
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed: vi.fn(async () => detailedDurableResult({
        insertedTriples: 0,
        insertedDataTriples: 0,
        insertedMetaTriples: 0,
        timedOutPhases: 1,
        completedPhases: 0,
        checkpointAdvances: 0,
        complete: false,
      })),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'agent-blackbox-vm',
        peerId: 'peer-core',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'DURABLE_CATCHUP_ALL_PEERS_FAILED',
      durableComplete: false,
      totalDurableInsertedTriples: 0,
      results: [{
        peerId: 'peer-core',
        durableComplete: false,
        durableError: 'Durable sync did not complete (incompleteWithoutProgress=1)',
      }],
    });
  });

  it('keeps a clean bounded prefix incomplete until the explicit durable contract is terminal', async () => {
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed: vi.fn(async () => detailedDurableResult({
        insertedTriples: 40_000,
        insertedDataTriples: 39_500,
        insertedMetaTriples: 500,
        completedPhases: 1,
        checkpointAdvances: 1,
        complete: false,
      })),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'agent-blackbox-vm',
        peerId: 'peer-core',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'DURABLE_CATCHUP_INCOMPLETE',
      durableComplete: false,
      totalDurableInsertedTriples: 40_000,
      results: [{
        peerId: 'peer-core',
        durableComplete: false,
      }],
      perContextGraph: [{
        contextGraphId: 'agent-blackbox-vm',
        durableComplete: false,
      }],
    });
  });

  it('reports a clean detailed durable result as complete at every response level', async () => {
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed: vi.fn(async () => detailedDurableResult({
        insertedTriples: 42,
        insertedDataTriples: 40,
        insertedMetaTriples: 2,
        completedPhases: 2,
        checkpointAdvances: 2,
        complete: true,
      })),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'agent-blackbox-vm',
        peerId: 'peer-core',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      durableComplete: true,
      totalDurableInsertedTriples: 42,
      results: [{
        peerId: 'peer-core',
        durableInsertedTriples: 42,
        durableComplete: true,
      }],
      perContextGraph: [{
        contextGraphId: 'agent-blackbox-vm',
        durableComplete: true,
        perPeer: [{
          durableComplete: true,
          durableDiagnostics: {
            insertedDataTriples: 40,
            insertedMetaTriples: 2,
            completedPhases: 2,
            checkpointAdvances: 2,
          },
        }],
      }],
    });
  });

  it('uses all-requested-CG AND semantics for durable completion', async () => {
    const peerId = 'peer-core';
    const syncFromPeerDetailed = vi.fn(async (
      _candidate: string,
      contextGraphIds: string[],
    ) => contextGraphIds[0] === 'cg-a'
      ? detailedDurableResult({
          insertedTriples: 10,
          insertedDataTriples: 8,
          insertedMetaTriples: 2,
          complete: true,
        })
      : detailedDurableResult({
          insertedTriples: 5,
          insertedDataTriples: 4,
          insertedMetaTriples: 1,
          completedPhases: 1,
          checkpointAdvances: 1,
          complete: false,
        }));
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: ['cg-a', 'cg-b'],
        peerId,
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncFromPeerDetailed).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'DURABLE_CATCHUP_INCOMPLETE',
      durableComplete: false,
      results: [{ peerId, durableComplete: false }],
      perContextGraph: [
        { contextGraphId: 'cg-a', durableComplete: true },
        { contextGraphId: 'cg-b', durableComplete: false },
      ],
    });
  });

  it('keeps one CG complete when a redundant peer fails', async () => {
    const peers = ['peer-complete', 'peer-failed'];
    const syncFromPeerDetailed = vi.fn(async (candidate: string) => (
      candidate === 'peer-complete'
        ? detailedDurableResult({
            insertedTriples: 10,
            insertedDataTriples: 8,
            insertedMetaTriples: 2,
            complete: true,
          })
        : detailedDurableResult({
            insertedTriples: 5,
            insertedDataTriples: 4,
            insertedMetaTriples: 1,
            completedPhases: 1,
            checkpointAdvances: 1,
            failedPhases: 1,
            complete: false,
          })
    ));
    const agent = {
      peerId: 'self-peer',
      node: {
        libp2p: {
          getConnections: () => peers.map((peerId) => ({
            remotePeer: { toString: () => peerId },
          })),
        },
      },
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncFromPeerDetailed,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'cg-redundant-peers',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncFromPeerDetailed).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      durableComplete: true,
      results: [
        {
          peerId: 'peer-complete',
          durableComplete: true,
        },
        {
          peerId: 'peer-failed',
          durableComplete: false,
          durableError: 'Durable sync did not complete (failedPhases=1)',
        },
      ],
      perContextGraph: [{
        contextGraphId: 'cg-redundant-peers',
        durableComplete: true,
        perPeer: [
          {
            peerId: 'peer-complete',
            durableComplete: true,
          },
          {
            peerId: 'peer-failed',
            durableComplete: false,
            durableError: 'Durable sync did not complete (failedPhases=1)',
          },
        ],
      }],
    });
  });

  it('awaits durable verification and store settlement after the fetch budget', async () => {
    vi.useFakeTimers();
    let resolveDurable!: (inserted: number) => void;
    const syncFromPeer = vi.fn(() => new Promise<number>((resolve) => {
      resolveDurable = resolve;
    }));
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => true),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({
        curatorIsLocal: false,
        peerIds: ['peer-curator'],
      })),
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'private-settlement-cg',
        peerId: 'peer-curator',
        includeSharedMemory: false,
        includeDurable: true,
        perPeerDurableBudgetMs: 1_000,
      },
      agent,
    );

    try {
      const request = handleMemoryRoutes(ctx);
      await vi.advanceTimersByTimeAsync(1_500);
      // The fetch deadline may have elapsed, but returning now would be a false
      // terminal: exact verification/atomic storage still owns the operation.
      expect(res.writableEnded).toBe(false);

      resolveDurable(23);
      await request;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).totalDurableInsertedTriples).toBe(23);
      expect(syncFromPeer).toHaveBeenCalledWith(
        'peer-curator',
        ['private-settlement-cg'],
        undefined,
        undefined,
        { totalTimeoutMs: 1_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a retryable 503 when every durable-only peer fails', async () => {
    const failure = new Error('All multiaddr dials failed for peer-curator');
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => true),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({
        curatorIsLocal: false,
        peerIds: ['peer-curator'],
      })),
      syncFromPeer: vi.fn(async () => { throw failure; }),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'private-durable-failure-cg',
        peerId: 'peer-curator',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'DURABLE_CATCHUP_ALL_PEERS_FAILED',
      totalDurableInsertedTriples: 0,
      results: [
        {
          peerId: 'peer-curator',
          durableInsertedTriples: 0,
          durableError: failure.message,
        },
      ],
    });
  });

  it('keeps a successful durable zero-insert no-op at HTTP 200', async () => {
    const agent = {
      peerId: 'self-peer',
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => true),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({
        curatorIsLocal: false,
        peerIds: ['peer-curator'],
      })),
      syncFromPeer: vi.fn(async () => 0),
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'private-durable-complete-cg',
        peerId: 'peer-curator',
        includeSharedMemory: false,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      totalDurableInsertedTriples: 0,
      results: [
        {
          peerId: 'peer-curator',
          durableInsertedTriples: 0,
        },
      ],
    });
  });

  it('still runs includeDurable when SWM is not currently usable for the CG', async () => {
    const syncSharedMemoryFromPeerDetailed = vi.fn();
    const syncSharedMemoryFromPeer = vi.fn();
    const syncFromPeer = vi.fn(async () => 7);
    const agent = {
      peerId: 'self-peer',
      canUseSharedMemoryForContextGraph: vi.fn(async () => false),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncSharedMemoryFromPeerDetailed,
      syncSharedMemoryFromPeer,
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'review-cg',
        peerId: 'peer-a',
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).not.toHaveBeenCalled();
    expect(syncSharedMemoryFromPeer).not.toHaveBeenCalled();
    expect(syncFromPeer).toHaveBeenCalledTimes(1);
    expect(syncFromPeer).toHaveBeenCalledWith(
      'peer-a',
      ['review-cg'],
      undefined,
      undefined,
      { totalTimeoutMs: 109_000 },
    );

    const body = JSON.parse(res.body);
    expect(body.totalInsertedTriples).toBe(0);
    expect(body.totalDurableInsertedTriples).toBe(7);
    expect(body.peersAttempted).toBe(1);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: 'review-cg',
        insertedTriples: 0,
        durableInsertedTriples: 7,
        perPeer: [
          {
            peerId: 'peer-a',
            insertedTriples: 0,
            durableInsertedTriples: 7,
          },
        ],
      },
    ]);
  });

  it('filters route-selected SWM catchup peers by current protocol and private curator scope', async () => {
    const cgId = 'private-route-cg';
    const curatorPeer = 'peer-curator';
    const nonCuratorPeer = 'peer-non-curator';
    const legacyPeer = 'peer-legacy';
    const syncSharedMemoryFromPeerDetailed = vi.fn(async () => ({ insertedTriples: 5 }));
    const syncFromPeer = vi.fn();
    const agent = {
      peerId: 'self-peer',
      node: {
        libp2p: {
          getConnections: () => [curatorPeer, nonCuratorPeer, legacyPeer].map((peerId) => ({
            remotePeer: { toString: () => peerId },
          })),
        },
      },
      canUseSharedMemoryForContextGraph: vi.fn(async () => true),
      getPeerProtocols: vi.fn(async (peerId: string) => (
        peerId === legacyPeer ? ['/dkg/10.0.1/sync'] : [PROTOCOL_SYNC]
      )),
      isPrivateContextGraph: vi.fn(async () => true),
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({
        curatorIsLocal: false,
        peerIds: [curatorPeer],
      })),
      syncSharedMemoryFromPeerDetailed,
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: cgId,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledTimes(1);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(curatorPeer, [cgId]);
    expect(syncFromPeer).not.toHaveBeenCalled();

    const body = JSON.parse(res.body);
    expect(body.peersAttempted).toBe(1);
    expect(body.results).toEqual([
      {
        peerId: curatorPeer,
        insertedTriples: 5,
        durableInsertedTriples: 0,
      },
    ]);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: cgId,
        insertedTriples: 5,
        durableInsertedTriples: 0,
        perPeer: [
          {
            peerId: curatorPeer,
            insertedTriples: 5,
            durableInsertedTriples: 0,
          },
        ],
      },
    ]);
  });

  it('keeps includeDurable independent from the SWM negative outcome cache', async () => {
    const cgId = 'public-negative-cache-route-cg';
    const negativePeer = 'peer-negative-cache';
    const unknownPeer = 'peer-unknown-cache';
    let connectedPeers = [negativePeer];
    const syncSharedMemoryFromPeerDetailed = vi.fn(async () => ({ insertedTriples: 0 }));
    const syncFromPeer = vi.fn(async (peerId: string) => (peerId === negativePeer ? 11 : 13));
    const agent = {
      peerId: 'self-peer',
      node: {
        libp2p: {
          getConnections: () => connectedPeers.map((peerId) => ({
            remotePeer: { toString: () => peerId },
          })),
        },
      },
      canUseSharedMemoryForContextGraph: vi.fn(async () => true),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncSharedMemoryFromPeerDetailed,
      syncFromPeer,
    };

    const first = buildCatchupCtx(
      {
        contextGraphId: cgId,
        peerId: negativePeer,
        hostCatchupFallback: false,
      },
      agent,
    );
    await handleMemoryRoutes(first.ctx);
    expect(first.res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(negativePeer, [cgId]);
    expect(syncFromPeer).not.toHaveBeenCalled();

    syncSharedMemoryFromPeerDetailed.mockClear();
    syncFromPeer.mockClear();
    connectedPeers = [negativePeer, unknownPeer];
    const second = buildCatchupCtx(
      {
        contextGraphId: cgId,
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );
    await handleMemoryRoutes(second.ctx);

    expect(second.res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledTimes(1);
    expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(unknownPeer, [cgId]);
    expect(syncFromPeer.mock.calls.map(([peerId]) => peerId).sort()).toEqual([
      negativePeer,
      unknownPeer,
    ].sort());
    expect(syncFromPeer).toHaveBeenCalledWith(
      negativePeer,
      [cgId],
      undefined,
      undefined,
      { totalTimeoutMs: 109_000 },
    );
    expect(syncFromPeer).toHaveBeenCalledWith(
      unknownPeer,
      [cgId],
      undefined,
      undefined,
      { totalTimeoutMs: 109_000 },
    );

    const body = JSON.parse(second.res.body);
    expect(body.peersAttempted).toBe(2);
    expect(body.totalDurableInsertedTriples).toBe(24);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: cgId,
        insertedTriples: 0,
        durableInsertedTriples: 24,
        perPeer: expect.arrayContaining([
          {
            peerId: negativePeer,
            insertedTriples: 0,
            durableInsertedTriples: 11,
          },
          {
            peerId: unknownPeer,
            insertedTriples: 0,
            durableInsertedTriples: 13,
          },
        ]),
      },
    ]);
  });
});
