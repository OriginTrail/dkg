import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { CatchupJobResult, CatchupRunRequest } from '../src/catchup-runner.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { daemonState } from '../src/daemon/state.js';

function cleanEmptyResult(): CatchupJobResult {
  return {
    connectedPeers: 1,
    totalPeers: 1,
    selectedPeers: 1,
    syncCapablePeers: 1,
    peersTried: 1,
    peersResponded: 1,
    peersSucceeded: 1,
    dataSynced: 0,
    sharedMemorySynced: 0,
    denied: false,
    deniedPeers: 0,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, emptyPeers: 1 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 1 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 2,
        checkpointAdvances: 0,
        emptyResponses: 1,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 2,
        checkpointAdvances: 0,
        emptyResponses: 1,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
      },
    },
  };
}

function privateMetaOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.durable) throw new Error('durable diagnostics missing');
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.durable.fetchedMetaTriples = 7;
  result.diagnostics.durable.insertedMetaTriples = 1;
  result.diagnostics.durable.metaOnlyResponses = 1;
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.cleanPlaneCompletions.durable.emptyPeers = 0;
  return result;
}

function privateDataOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.durable || !result.diagnostics.sharedMemory) {
    throw new Error('catch-up diagnostics missing');
  }
  result.dataSynced = 3;
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.durable.fetchedDataTriples = 3;
  result.diagnostics.durable.insertedDataTriples = 3;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.completedPhases = 0;
  result.diagnostics.sharedMemory.timedOutPhases = 1;
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.cleanPlaneCompletions.durable = { verifiedDataPeers: 1, emptyPeers: 0 };
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 0, emptyPeers: 0 };
  return result;
}

function privateSharedMemoryOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.sharedMemory) {
    throw new Error('shared-memory diagnostics missing');
  }
  result.sharedMemorySynced = 4;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.fetchedDataTriples = 4;
  result.diagnostics.sharedMemory.insertedDataTriples = 4;
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 1, emptyPeers: 0 };
  return result;
}

function publicDurableAndSharedMemoryResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics?.durable || !result.diagnostics.sharedMemory) {
    throw new Error('catch-up diagnostics missing');
  }
  if (!result.cleanPlaneCompletions) throw new Error('clean completion proof missing');
  result.dataSynced = 3;
  result.sharedMemorySynced = 4;
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.durable.fetchedDataTriples = 3;
  result.diagnostics.durable.insertedDataTriples = 3;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.fetchedDataTriples = 4;
  result.diagnostics.sharedMemory.insertedDataTriples = 4;
  result.cleanPlaneCompletions.durable = { verifiedDataPeers: 1, emptyPeers: 0 };
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 1, emptyPeers: 0 };
  return result;
}

describe('context graph subscribe readiness requires authoritative metadata', () => {
  const previousCatchupRunner = daemonState.catchupRunner;
  let server: Server | undefined;

  afterEach(async () => {
    daemonState.catchupRunner = previousCatchupRunner;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  async function subscribe(opts: {
    initial?: Record<string, unknown>;
    hasConfirmedMeta: boolean;
    hasConfirmedMetaAfterCatchup?: boolean;
    isPrivate?: boolean;
    allowedAgents?: string[];
    callerAddress?: string;
    result?: CatchupJobResult;
    includeSharedMemory?: boolean;
    syncMode?: unknown;
    forceCatchup?: unknown;
    readiness?: {
      version: number;
      durableVerified: boolean;
      sharedMemoryVerified: boolean;
      updatedAt?: number;
    };
  }): Promise<{
    response: any;
    responseStatus: number;
    job: any;
    runCalls: number;
    runRequests: CatchupRunRequest[];
    subscribeCalls: Array<{
      id: string;
      options: { syncMode?: 'on-demand' | 'always-on' } | undefined;
    }>;
    state: Record<string, any>;
    patches: Array<Record<string, unknown>>;
    readiness: Record<string, unknown> | undefined;
    statusResponse: any;
  }> {
    const contextGraphId = `readiness-${Math.random().toString(36).slice(2, 8)}`;
    const state = new Map<string, Record<string, any>>();
    if (opts.initial) state.set(contextGraphId, { ...opts.initial });
    const patches: Array<Record<string, unknown>> = [];
    const catchupTracker = {
      jobs: new Map<string, any>(),
      latestByContextGraph: new Map<string, string>(),
    };
    let runCalls = 0;
    const runRequests: CatchupRunRequest[] = [];
    const subscribeCalls: Array<{
      id: string;
      options: { syncMode?: 'on-demand' | 'always-on' } | undefined;
    }> = [];
    let readiness = opts.readiness
      ? { ...opts.readiness, updatedAt: opts.readiness.updatedAt ?? Date.now() }
      : undefined;

    daemonState.catchupRunner = {
      run: async (request) => {
        runCalls += 1;
        runRequests.push(request);
        return opts.result ?? cleanEmptyResult();
      },
      close: async () => {},
    };

    const agent = {
      getContextGraphAllowedAgents: async () => opts.allowedAgents ?? [],
      getSubscribedContextGraphs: () => state,
      subscribeToContextGraph: (
        id: string,
        options?: { syncMode?: 'on-demand' | 'always-on' },
      ) => {
        subscribeCalls.push({ id, options });
        const previous = state.get(id);
        const effectiveSyncMode = previous?.subscribed && previous.syncMode === 'always-on'
          ? 'always-on'
          : options?.syncMode ?? previous?.syncMode ?? 'always-on';
        const applied = {
          ...previous,
          subscribed: true,
          synced: previous?.synced ?? false,
          syncMode: effectiveSyncMode,
        };
        state.set(id, applied);
        return applied;
      },
      markContextGraphSubscriptionState: (id: string, patch: Record<string, unknown>) => {
        patches.push({ ...patch });
        state.set(id, { ...state.get(id), ...patch });
      },
      hasConfirmedMetaState: async () => {
        return runCalls > 0
          ? opts.hasConfirmedMetaAfterCatchup ?? opts.hasConfirmedMeta
          : opts.hasConfirmedMeta;
      },
      isPrivateContextGraph: async () => opts.isPrivate ?? false,
      resolveAgentByToken: () => undefined,
      getDefaultAgentAddress: () => opts.callerAddress ?? '0x0000000000000000000000000000000000000001',
      getRfc64SelectedSwmGraphSyncStatus: () => ({
        mechanism: 'rfc64-selected-on-connect',
        state: 'inactive',
        configuredProviderCount: 0,
        retryRequiredProviderCount: 0,
        terminalProviderCount: 0,
      }),
    };

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const routeContext = {
        req,
        res,
        agent,
        publisherControl: {},
        publisherRuntime: null,
        config: { auth: { enabled: false } },
        startedAt: Date.now(),
        dashDb: {
          getContextGraphReadinessProvenance: () => readiness ?? null,
          setContextGraphReadinessProvenance: (_id: string, next: Record<string, unknown>) => {
            readiness = { ...next, updatedAt: Date.now() } as typeof readiness;
          },
        },
        opWallets: {},
        network: {},
        tracker: {},
        memoryManager: {},
        bridgeAuthToken: undefined,
        nodeVersion: 'test',
        nodeCommit: 'test',
        catchupTracker,
        extractionRegistry: {},
        fileStore: {},
        extractionStatus: new Map(),
        assertionImportLocks: new Map(),
        vectorStore: {},
        embeddingProvider: null,
        validTokens: new Set(),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestToken: undefined,
        requestAgentAddress: undefined,
        requestPrincipal: { kind: 'nodeOperator' },
      } as any;
      await handleContextGraphRoutes(routeContext);
      if (!res.writableEnded) await handleQueryRoutes(routeContext);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('route test server did not bind');

    const httpResponse = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contextGraphId,
        includeSharedMemory: opts.includeSharedMemory ?? true,
        ...(opts.syncMode !== undefined ? { syncMode: opts.syncMode } : {}),
        ...(opts.forceCatchup !== undefined ? { forceCatchup: opts.forceCatchup } : {}),
      }),
    });
    const response = await httpResponse.json() as any;
    const jobId = response.catchup?.jobId as string | undefined;

    for (let i = 0; jobId && i < 50; i++) {
      if (catchupTracker.jobs.get(jobId)?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const statusResponse = jobId
      ? await fetch(
        `http://127.0.0.1:${address.port}/api/sync/catchup-status?jobId=${encodeURIComponent(jobId)}`,
      ).then((result) => result.json())
      : null;

    return {
      response,
      responseStatus: httpResponse.status,
      job: jobId ? catchupTracker.jobs.get(jobId) : undefined,
      runCalls,
      runRequests,
      subscribeCalls,
      state: state.get(contextGraphId) ?? {},
      patches,
      readiness,
      statusResponse,
    };
  }

  it('keeps omitted sync mode backward-compatible as always-on', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
    });

    expect(result.response.syncMode).toBe('always-on');
    expect(result.subscribeCalls).toEqual([
      { id: expect.any(String), options: { syncMode: 'always-on' } },
    ]);
    expect(result.state.syncMode).toBe('always-on');
  });

  it('forwards explicit on-demand edge intent without making it always-on', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      syncMode: 'on-demand',
    });

    expect(result.response.syncMode).toBe('on-demand');
    expect(result.subscribeCalls).toEqual([
      { id: expect.any(String), options: { syncMode: 'on-demand' } },
    ]);
    expect(result.state.syncMode).toBe('on-demand');
  });

  it('reports the agent-applied mode when an on-demand open cannot downgrade always-on', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      syncMode: 'on-demand',
      initial: {
        subscribed: true,
        syncMode: 'always-on',
        synced: false,
      },
    });

    expect(result.subscribeCalls).toEqual([
      { id: expect.any(String), options: { syncMode: 'on-demand' } },
    ]);
    expect(result.response.syncMode).toBe('always-on');
    expect(result.state.syncMode).toBe('always-on');
  });

  it('rejects unknown sync modes before changing subscription state', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      syncMode: 'sometimes',
    });

    expect(result.responseStatus).toBe(400);
    expect(result.response.error).toContain('Invalid "syncMode"');
    expect(result.subscribeCalls).toEqual([]);
    expect(result.runCalls).toBe(0);
  });

  it('does not turn a clean empty response with no authoritative metadata into ready state', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('authoritative context-graph metadata'),
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(result.patches).not.toContainEqual(expect.objectContaining({ synced: true }));
  });

  it('bypasses synthetic done and heals poisoned ready flags when metaSynced is false', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: false,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
    expect(result.patches[0]).toEqual({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('revalidates a stale metaSynced=true bit before returning synthetic done', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
    });
  });

  it('does not restore stale true provenance after metadata arrives during an unclean catch-up', async () => {
    const metadataOnlyUnclean = privateMetaOnlyResult();
    if (!metadataOnlyUnclean.diagnostics?.durable ||
      !metadataOnlyUnclean.diagnostics.sharedMemory ||
      !metadataOnlyUnclean.cleanPlaneCompletions) {
      throw new Error('catch-up diagnostics missing');
    }
    metadataOnlyUnclean.diagnostics.durable.timedOutPhases = 1;
    metadataOnlyUnclean.diagnostics.sharedMemory.emptyResponses = 0;
    metadataOnlyUnclean.cleanPlaneCompletions.sharedMemory.emptyPeers = 0;

    const result = await subscribe({
      hasConfirmedMeta: false,
      hasConfirmedMetaAfterCatchup: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: metadataOnlyUnclean,
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('clears stale v1 proof when subscription flags are already fail-closed', async () => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      hasConfirmedMetaAfterCatchup: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: privateMetaOnlyResult(),
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
        pendingMeta: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('metadata-only responses cannot prove'),
    });
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('keeps clean-empty completion valid when authoritative public metadata exists', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('done');
    expect(result.job.error).toBeUndefined();
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  it('backfills both public planes and exposes the completed subscription job through catchup status', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      // Publishing is allowlisted to a different wallet. Explicit public read
      // policy must still bypass the private membership gate.
      allowedAgents: ['0x1111111111111111111111111111111111111111'],
      callerAddress: '0x2222222222222222222222222222222222222222',
      result: publicDurableAndSharedMemoryResult(),
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.response.catchup).toMatchObject({
      status: 'queued',
      jobId: expect.any(String),
    });
    expect(result.runRequests).toEqual([{
      contextGraphId: result.response.subscribed,
      includeSharedMemory: true,
    }]);
    expect(result.statusResponse).toMatchObject({
      jobId: result.response.catchup.jobId,
      status: 'done',
      jobStatus: 'done',
      graphSync: {
        state: 'inactive',
      },
      result: {
        dataSynced: 3,
        sharedMemorySynced: 4,
      },
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: true,
      sharedMemoryVerified: true,
    });
  });

  // Issue #2006: an empty response cannot distinguish "hosts an empty graph"
  // from "never heard of this graph", so a clean-empty peer only proves the
  // plane when the whole round was content-free and failure-free. A denial or a
  // failed data-bearing peer means we did not hear from everyone.
  it('does not keep a public clean-empty peer valid when another peer denies', async () => {
    const mixed = cleanEmptyResult();
    mixed.connectedPeers = 2;
    mixed.totalPeers = 2;
    mixed.selectedPeers = 2;
    mixed.syncCapablePeers = 2;
    mixed.peersTried = 2;
    mixed.peersResponded = 2;
    mixed.denied = true;
    mixed.deniedPeers = 1;
    if (!mixed.diagnostics?.durable) throw new Error('durable diagnostics missing');
    mixed.diagnostics.durable.deniedPhases = 1;

    const result = await subscribe({
      hasConfirmedMeta: true,
      includeSharedMemory: false,
      result: mixed,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).not.toBe('done');
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({ synced: false });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('does not settle as done when a data-bearing peer failed and an unrelated peer answered empty', async () => {
    // The reported field shape: 122,705 data triples fetched, five failed
    // phases, nothing verified, and unrelated peers answering empty — which
    // previously settled the job as `done` with 1 KA out of 40.
    const masked = cleanEmptyResult();
    masked.connectedPeers = 6;
    masked.totalPeers = 6;
    masked.selectedPeers = 6;
    masked.syncCapablePeers = 6;
    masked.peersTried = 6;
    masked.peersResponded = 6;
    if (!masked.diagnostics?.durable) throw new Error('durable diagnostics missing');
    masked.diagnostics.durable.fetchedDataTriples = 122_705;
    masked.diagnostics.durable.failedPhases = 5;

    const result = await subscribe({
      hasConfirmedMeta: true,
      includeSharedMemory: false,
      result: masked,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).not.toBe('done');
    expect(result.state).toMatchObject({ synced: false });
    expect(result.readiness).toMatchObject({ durableVerified: false });
  });

  it('does not promote private data readiness from unrelated empty responders after metadata is local', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('cannot prove a private graph is fully synchronized'),
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
  });

  it('does not promote a private CG from metadata-only diagnostics without verified payload', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      result: privateMetaOnlyResult(),
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
  });

  it('keeps private durable-only catch-up partial when shared-memory sync was requested', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      result: privateDataOnlyResult(),
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('shared-memory catch-up did not complete'),
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: false,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: false,
    });
  });

  it('records clean private shared-memory progress without reporting VM-complete catch-up', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      result: privateSharedMemoryOnlyResult(),
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({
      status: 'unreachable',
      error: expect.stringContaining('durable VM catch-up did not complete'),
    });
    expect(result.job.result).toMatchObject({
      dataSynced: 0,
      sharedMemorySynced: 4,
    });
    expect(result.state).toMatchObject({
      subscribed: true,
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
      pendingMeta: false,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: true,
    });
  });

  it('does not promote positive durable inserts when the plane also timed out', async () => {
    const partial = privateDataOnlyResult();
    if (!partial.diagnostics?.durable) throw new Error('durable diagnostics missing');
    if (!partial.cleanPlaneCompletions) throw new Error('clean completion proof missing');
    partial.diagnostics.durable.timedOutPhases = 1;
    partial.cleanPlaneCompletions.durable.verifiedDataPeers = 0;

    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: partial,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job).toMatchObject({
      status: 'partial',
      error: expect.stringContaining('bounded catch-up job ended'),
    });
    expect(result.statusResponse).toMatchObject({
      status: 'unreachable',
      jobStatus: 'partial',
    });
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('does not promote positive durable inserts when the plane was also denied', async () => {
    const partial = privateDataOnlyResult();
    if (!partial.diagnostics?.durable) throw new Error('durable diagnostics missing');
    if (!partial.cleanPlaneCompletions) throw new Error('clean completion proof missing');
    partial.denied = true;
    partial.deniedPeers = 1;
    partial.diagnostics.durable.deniedPhases = 1;
    partial.cleanPlaneCompletions.durable.verifiedDataPeers = 0;

    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: partial,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).toBe('partial');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('promotes a clean private plane when another peer denies and times out', async () => {
    const mixed = privateDataOnlyResult();
    if (!mixed.diagnostics?.durable) throw new Error('durable diagnostics missing');
    mixed.denied = true;
    mixed.deniedPeers = 1;
    mixed.diagnostics.durable.deniedPhases = 1;
    mixed.diagnostics.durable.timedOutPhases = 1;

    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: mixed,
      initial: {
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
    });

    expect(result.job.status).toBe('done');
    expect(result.job.error).toBeUndefined();
    expect(result.state).toMatchObject({
      synced: true,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: true,
      sharedMemoryVerified: false,
    });
  });

  it('forces a corrective catch-up for a confirmed private legacy row without provenance', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('unreachable');
    expect(result.state).toMatchObject({
      synced: false,
      sharedMemorySynced: false,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      version: 1,
      durableVerified: false,
      sharedMemoryVerified: false,
    });
  });

  it('does not synthesize done from existing SWM-only provenance when VM is unverified', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      includeSharedMemory: false,
      result: privateSharedMemoryOnlyResult(),
      readiness: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.job.status).toBe('partial');
    expect(result.state).toMatchObject({
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false,
      sharedMemoryVerified: true,
    });
  });

  it('only returns synthetic done when all ready flags include metaSynced=true', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('done');
    expect(result.runCalls).toBe(0);
    expect(result.job.status).toBe('done');
    expect(result.patches).toEqual([]);
  });

  it('forces RFC-64 catch-up for an already-ready graph when requested', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      forceCatchup: true,
      result: publicDurableAndSharedMemoryResult(),
      readiness: {
        version: 1,
        durableVerified: true,
        sharedMemoryVerified: true,
      },
      initial: {
        subscribed: true,
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      },
    });

    expect(result.response.catchup.status).toBe('queued');
    expect(result.runCalls).toBe(1);
    expect(result.runRequests).toEqual([
      expect.objectContaining({ includeSharedMemory: true }),
    ]);
    expect(result.job.status).toBe('done');
    // Repair must not make an already-ready graph unavailable while the
    // bounded reconciliation runs.
    expect(result.patches).toEqual([
      expect.objectContaining({
        synced: true,
        sharedMemorySynced: true,
        metaSynced: true,
      }),
    ]);
    expect(result.state).toMatchObject({
      synced: true,
      sharedMemorySynced: true,
      metaSynced: true,
    });
  });

  it('rejects a non-boolean forceCatchup value without starting work', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      forceCatchup: 'true',
    });

    expect(result.responseStatus).toBe(400);
    expect(result.response.error).toContain('Invalid "forceCatchup"');
    expect(result.runCalls).toBe(0);
    expect(result.job).toBeUndefined();
  });
});
