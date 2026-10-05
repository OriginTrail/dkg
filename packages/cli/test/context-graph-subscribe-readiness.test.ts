import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { CatchupJobResult, CatchupRunRequest } from '../src/catchup-runner.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { daemonState } from '../src/daemon/state.js';

interface TestAuthorityDecision {
  outcome: 'allowed' | 'denied' | 'unavailable';
  source: 'registered-chain' | 'legacy-local';
  reason: string;
  metadataBootstrap: 'eligible' | 'forbidden';
  onChainId?: bigint;
  registration?: 'unregistered';
}

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

function privateSharedMemoryMetaOnlyResult(): CatchupJobResult {
  const result = cleanEmptyResult();
  if (!result.diagnostics || !result.cleanPlaneCompletions) {
    throw new Error('catch-up evidence missing');
  }
  // No VM proof and no payload on either plane. The required SWM plane did
  // deliver metadata, but metadata is not positive synchronization proof.
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  result.diagnostics.sharedMemory.fetchedMetaTriples = 7;
  result.diagnostics.sharedMemory.insertedMetaTriples = 1;
  result.diagnostics.sharedMemory.bytesReceived = 90;
  result.cleanPlaneCompletions.durable = { verifiedDataPeers: 0, emptyPeers: 0 };
  result.cleanPlaneCompletions.sharedMemory = { verifiedDataPeers: 0, emptyPeers: 0 };
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
    metadataBootstrapWaitFor?: Promise<void>;
    onMetadataBootstrapStarted?: () => void;
    onCatchupRun?: () => void;
    onEarlyProofAttempt?: () => void;
    catchupRunWaitFor?: Promise<void>;
    finalizedEmptyPrivateVm?: boolean;
    finalizedEmptyPrivateVmAfterCatchup?: boolean;
    invalidateMetaDuringProof?: boolean;
    throwEarlyReadinessCommitOnce?: boolean;
    revokeOnTerminalProof?: boolean;
    authorityDecision?: TestAuthorityDecision;
    authorityAfterCatchup?: TestAuthorityDecision;
    recoverAuthorityForRetry?: boolean;
    metadataInspectionFailsAfterCatchup?: boolean;
    readiness?: {
      version: number;
      durableVerified: boolean;
      sharedMemoryVerified: boolean;
      updatedAt?: number;
    };
    readinessDuringCatchup?: { version: number; durableVerified: boolean; sharedMemoryVerified: boolean };
  }): Promise<{
    response: any;
    responseStatus: number;
    job: any;
    runCalls: number;
    proofAttempts: Array<{ phase: 'early' | 'terminal'; proven: boolean }>;
    earlyReadinessCommitFailureInjected: boolean;
    metadataBootstrapCalls: number;
    metadataBootstrapProofs: Array<unknown>;
    runSawMetadataBootstrap: boolean;
    runRequests: CatchupRunRequest[];
    subscribeCalls: Array<{
      id: string;
      options: { syncMode?: 'on-demand' | 'always-on' } | undefined;
    }>;
    responsibilityCalls: string[];
    state: Record<string, any>;
    patches: Array<Record<string, unknown>>;
    readiness: Record<string, unknown> | undefined;
    statusResponse: any;
    retryResponseStatus?: number;
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
    let catchupCompleted = false;
    let authorityRevoked = false;
    let earlyReadinessCommitFailureInjected = false;
    const proofAttempts: Array<{ phase: 'early' | 'terminal'; proven: boolean }> = [];
    let retrying = false;
    let metadataBootstrapCalls = 0;
    const metadataBootstrapProofs: Array<unknown> = [];
    let metadataBootstrapCompleted = false;
    let runSawMetadataBootstrap = false;
    const runRequests: CatchupRunRequest[] = [];
    const subscribeCalls: Array<{
      id: string;
      options: { syncMode?: 'on-demand' | 'always-on' } | undefined;
    }> = [];
    const responsibilityCalls: string[] = [];
    let readiness = opts.readiness
      ? { ...opts.readiness, updatedAt: opts.readiness.updatedAt ?? Date.now() }
      : undefined;
    let metadataInvalidated = false;

    daemonState.catchupRunner = {
      run: async (request) => {
        runCalls += 1;
        opts.onCatchupRun?.();
        await opts.catchupRunWaitFor;
        if (opts.readinessDuringCatchup) readiness = { ...opts.readinessDuringCatchup, updatedAt: Date.now() };
        runSawMetadataBootstrap = metadataBootstrapCompleted;
        runRequests.push(request);
        catchupCompleted = true;
        return opts.result ?? cleanEmptyResult();
      },
      close: async () => {},
    };

    const agent = {
      resolveContextGraphSubscriptionBootstrapAuthority: async () => (
        authorityRevoked
          ? { outcome: 'denied' as const, source: 'registered-chain' as const,
            reason: 'agent-not-in-chain-roster', metadataBootstrap: 'forbidden' as const }
          : retrying
          // Model the legacy-local admission guard after the transient store
          // outage recovers. A wrongly persisted pendingMeta poisons retries.
          ? state.get(contextGraphId)?.pendingMeta === true
            ? { outcome: 'unavailable', source: 'legacy-local', reason: 'pending-authoritative-metadata', metadataBootstrap: 'eligible' }
            : opts.authorityDecision
          : catchupCompleted ? opts.authorityAfterCatchup ?? opts.authorityDecision : opts.authorityDecision
      ) ?? ({
        outcome: 'allowed' as const,
        source: 'legacy-local' as const,
        reason: 'test-public',
        metadataBootstrap: 'eligible' as const,
      }),
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
        if (opts.throwEarlyReadinessCommitOnce && patch.synced === true && !catchupCompleted) {
          opts.throwEarlyReadinessCommitOnce = false;
          earlyReadinessCommitFailureInjected = true;
          throw new Error('test readiness write failure');
        }
        patches.push({ ...patch });
        state.set(id, { ...state.get(id), ...patch });
      },
      reconcileRfc64CatalogResponsibilityV1: async (id: string) => {
        responsibilityCalls.push(id);
      },
      bootstrapRfc64CatalogContextGraphMetadataFromPeersV1: async (
        _id: string, _signal: AbortSignal | undefined, proof: unknown,
      ) => {
        metadataBootstrapCalls += 1;
        metadataBootstrapProofs.push(proof);
        opts.onMetadataBootstrapStarted?.();
        await opts.metadataBootstrapWaitFor;
        metadataBootstrapCompleted = true;
        return 'no-accepted-public-policy';
      },
      hasConfirmedMetaState: async () => {
        if (metadataInvalidated) return false;
        if (catchupCompleted && opts.metadataInspectionFailsAfterCatchup) {
          throw new Error('transient metadata store failure');
        }
        return catchupCompleted
          ? opts.hasConfirmedMetaAfterCatchup ?? opts.hasConfirmedMeta
          : opts.hasConfirmedMeta;
      },
      isPrivateContextGraph: async () => opts.isPrivate ?? false,
      proveRegisteredPrivateEmptyVmV1: async (
        _id: string, _caller: string, commit?: () => void,
      ) => {
        if (opts.invalidateMetaDuringProof && !metadataInvalidated) {
          metadataInvalidated = true;
          state.set(contextGraphId, {
            ...state.get(contextGraphId), synced: false,
            metaSynced: false, pendingMeta: true,
          });
          return false;
        }
        if (metadataInvalidated) return false;
        const phase = catchupCompleted ? 'terminal' : 'early';
        if (phase === 'early') opts.onEarlyProofAttempt?.();
        if (phase === 'terminal' && opts.revokeOnTerminalProof) {
          authorityRevoked = true;
          proofAttempts.push({ phase, proven: false });
          return false;
        }
        const proven = phase === 'terminal'
          ? opts.finalizedEmptyPrivateVmAfterCatchup ?? opts.finalizedEmptyPrivateVm ?? false
          : opts.finalizedEmptyPrivateVm ?? false;
        proofAttempts.push({ phase, proven });
        if (proven) commit?.();
        return proven;
      },
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
        requestAgentAddress: undefined,
        authentication: requestAuthentication({ kind: 'nodeOperator' }),
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

    let retryResponseStatus: number | undefined;
    if (opts.recoverAuthorityForRetry) {
      retrying = true;
      const retry = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextGraphId, includeSharedMemory: true }),
      });
      retryResponseStatus = retry.status;
      await retry.json();
    }

    return {
      response,
      responseStatus: httpResponse.status,
      job: jobId ? catchupTracker.jobs.get(jobId) : undefined,
      runCalls,
      proofAttempts,
      earlyReadinessCommitFailureInjected,
      metadataBootstrapCalls,
      metadataBootstrapProofs,
      runSawMetadataBootstrap,
      runRequests,
      subscribeCalls,
      responsibilityCalls,
      state: state.get(contextGraphId) ?? {},
      patches,
      readiness,
      statusResponse,
      retryResponseStatus,
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
    expect(result.responsibilityCalls).toEqual([expect.any(String)]);
    expect(result.runSawMetadataBootstrap).toBe(true);
    expect(result.metadataBootstrapCalls).toBe(1);
  });

  it('opens only first-write VM readiness before an empty private catch-up completes', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    try {
      const result = await subscribe({
        hasConfirmedMeta: true,
        isPrivate: true,
        initial: { subscribed: false, sharedMemorySynced: false },
        finalizedEmptyPrivateVm: true,
        catchupRunWaitFor,
        authorityDecision: {
          outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
          metadataBootstrap: 'eligible', onChainId: 7n,
        },
      });
      expect(result.responseStatus).toBe(200);
      expect(result.job.status).toBe('running');
      expect(result.state).toMatchObject({
        subscribed: true, synced: true, metaSynced: true, sharedMemorySynced: false,
      });
      expect(result.readiness).toMatchObject({
        durableVerified: true, sharedMemoryVerified: false,
      });
    } finally {
      finishCatchup();
    }
  });

  it('returns the minted catch-up job if best-effort early readiness persistence throws', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    try {
      const result = await subscribe({
        hasConfirmedMeta: true, isPrivate: true,
        finalizedEmptyPrivateVm: true,
        throwEarlyReadinessCommitOnce: true,
        catchupRunWaitFor,
        authorityDecision: {
          outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
          metadataBootstrap: 'eligible', onChainId: 7n,
        },
      });
      expect(result.responseStatus).toBe(200);
      expect(result.response.catchup.jobId).toBeTruthy();
      expect(result.job.status).toBe('running');
      expect(result.earlyReadinessCommitFailureInjected).toBe(true);
      expect(result.proofAttempts).toContainEqual({ phase: 'early', proven: true });
    } finally {
      finishCatchup();
    }
  });

  it('commits a later finalized empty-VM proof after private metadata-only catch-up', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      initial: { subscribed: false, sharedMemorySynced: false },
      finalizedEmptyPrivateVm: false,
      finalizedEmptyPrivateVmAfterCatchup: true,
      catchupRunWaitFor,
      onEarlyProofAttempt: finishCatchup,
      result: privateSharedMemoryMetaOnlyResult(),
      authorityDecision: {
        outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
        metadataBootstrap: 'eligible', onChainId: 7n,
      },
    });
    expect(result.responseStatus).toBe(200);
    expect(result.job.finishedAt).toBeDefined();
    expect(result.proofAttempts).toEqual([
      { phase: 'early', proven: false },
      { phase: 'terminal', proven: true },
    ]);
    expect(result.state).toMatchObject({
      subscribed: true, synced: true, metaSynced: true,
      sharedMemorySynced: false,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: true, sharedMemoryVerified: false,
    });
  });

  it('clears early VM readiness if membership is revoked during terminal proof', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    const result = await subscribe({
      hasConfirmedMeta: true, isPrivate: true,
      initial: { subscribed: false, sharedMemorySynced: false },
      finalizedEmptyPrivateVm: true,
      revokeOnTerminalProof: true,
      catchupRunWaitFor,
      onEarlyProofAttempt: finishCatchup,
      result: privateSharedMemoryMetaOnlyResult(),
      authorityDecision: {
        outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
        metadataBootstrap: 'eligible', onChainId: 7n,
      },
    });
    expect(result.responseStatus).toBe(200);
    expect(result.job.status).toBe('denied');
    expect(result.proofAttempts).toEqual([
      { phase: 'early', proven: true },
      { phase: 'terminal', proven: false },
    ]);
    expect(result.state).toMatchObject({ synced: false, sharedMemorySynced: false });
    expect(result.readiness).toMatchObject({
      durableVerified: false, sharedMemoryVerified: false,
    });
  });

  it('keeps a denied catch-up status while an independent proof opens VM readiness', async () => {
    const deniedRound = privateSharedMemoryMetaOnlyResult();
    deniedRound.denied = true;
    deniedRound.deniedPeers = 1;
    deniedRound.peersSucceeded = 0;
    const result = await subscribe({
      hasConfirmedMeta: true, isPrivate: true,
      initial: { subscribed: false, sharedMemorySynced: false },
      finalizedEmptyPrivateVm: true,
      result: deniedRound,
      authorityDecision: {
        outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
        metadataBootstrap: 'eligible', onChainId: 7n,
      },
    });
    expect(result.job.status).toBe('denied');
    expect(result.state).toMatchObject({ synced: true, sharedMemorySynced: false });
    expect(result.readiness).toMatchObject({
      durableVerified: true, sharedMemoryVerified: false,
    });
  });

  it('does not restore readiness after metadata invalidates during an empty-VM proof', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      initial: { subscribed: false, sharedMemorySynced: false },
      finalizedEmptyPrivateVm: true,
      invalidateMetaDuringProof: true,
      result: privateMetaOnlyResult(),
      authorityDecision: {
        outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
        metadataBootstrap: 'eligible', onChainId: 7n,
      },
    });
    expect(result.job.finishedAt).toBeDefined();
    expect(result.state).toMatchObject({
      synced: false, metaSynced: false, pendingMeta: true,
    });
    expect(result.readiness).toMatchObject({
      durableVerified: false, sharedMemoryVerified: false,
    });
  });

  it('waits for metadata bootstrap to finish before starting catch-up', async () => {
    let releaseBootstrap!: () => void;
    let signalBootstrapStarted!: () => void;
    const bootstrapWait = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    const bootstrapStarted = new Promise<void>((resolve) => { signalBootstrapStarted = resolve; });
    let catchupRuns = 0;
    const pending = subscribe({
      hasConfirmedMeta: false,
      metadataBootstrapWaitFor: bootstrapWait,
      onMetadataBootstrapStarted: signalBootstrapStarted,
      onCatchupRun: () => { catchupRuns += 1; },
    });
    try {
      await bootstrapStarted;
      await new Promise((resolve) => setImmediate(resolve));
      expect(catchupRuns).toBe(0);
    } finally {
      releaseBootstrap();
    }
    const result = await pending;
    expect(catchupRuns).toBe(1);
    expect(result.runSawMetadataBootstrap).toBe(true);
  });

  it.each([
    ['chain-public', { contextGraphId: expect.any(String), onChainId: '7' }],
    ['chain-participant', undefined],
  ] as const)('passes registered public proof only for %s admission', async (reason, proof) => {
    const startedAt = Date.now();
    const result = await subscribe({
      hasConfirmedMeta: false,
      authorityDecision: {
        outcome: 'allowed', source: 'registered-chain', reason,
        metadataBootstrap: 'eligible', onChainId: 7n,
      },
    });
    expect(result.responseStatus).toBe(200);
    expect(result.metadataBootstrapProofs).toEqual([proof]);
    if (reason === 'chain-public') expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it.each([
    ['unavailable', 503, 'eligible'],
    ['denied', 403, 'forbidden'],
  ] as const)('leaves no subscription or catch-up side effect when authority is %s', async (
    outcome,
    expectedStatus,
    metadataBootstrap,
  ) => {
    const result = await subscribe({
      hasConfirmedMeta: false,
      authorityDecision: {
        outcome,
        source: 'registered-chain',
        reason: outcome === 'unavailable'
          ? 'finalized-name-absence-unaccepted'
          : 'agent-not-in-chain-roster',
        metadataBootstrap,
      },
    });

    expect(result.responseStatus).toBe(expectedStatus);
    expect(result.subscribeCalls).toEqual([]);
    expect(result.responsibilityCalls).toEqual([]);
    expect(result.runCalls).toBe(0);
    expect(result.metadataBootstrapCalls).toBe(0);
    expect(result.job).toBeUndefined();
    expect(result.state).toEqual({});
    expect(result.patches).toEqual([]);
  });

  it('logs a bounded unavailable reason without exposing arbitrary decision text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await subscribe({
        hasConfirmedMeta: false,
        authorityDecision: {
          outcome: 'unavailable', source: 'registered-chain',
          reason: 'private diagnostic text', metadataBootstrap: 'eligible',
        },
      });
      expect(result.responseStatus).toBe(503);
      expect(warn).toHaveBeenCalledWith(
        '[context-graph-subscribe] authority unavailable: reason=other dependency=undefined',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private diagnostic text');
    } finally {
      warn.mockRestore();
    }
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

  it('preserves newer catalog proof delivered while a foreground metadata-only job runs', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true, isPrivate: true, result: privateMetaOnlyResult(), forceCatchup: true,
      authorityDecision: { outcome: 'allowed', source: 'legacy-local', reason: 'approved-private-replica', metadataBootstrap: 'eligible', registration: 'unregistered' },
      initial: { subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: true },
      readinessDuringCatchup: { version: 1, durableVerified: false, sharedMemoryVerified: true },
    });
    expect(result.job.status).toBe('done');
    expect(result.job.durablePlane).toBe('not-applicable');
    expect(result.state).toMatchObject({ synced: true, sharedMemorySynced: true });
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: true });
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

  const unregisteredAuthority = {
    outcome: 'allowed' as const,
    source: 'legacy-local' as const,
    reason: 'approved-private-replica',
    metadataBootstrap: 'eligible' as const,
    registration: 'unregistered' as const,
  };

  it('completes an authoritatively unregistered private SWM graph without inventing VM proof', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      authorityDecision: unregisteredAuthority,
      result: privateSharedMemoryOnlyResult(),
    });
    expect(result.job).toMatchObject({ status: 'done', durablePlane: 'not-applicable' });
    expect(result.job.error).toBeUndefined();
    expect(result.statusResponse.durablePlane).toBe('not-applicable');
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: true });
  });

  it('re-derives VM applicability for the already-ready shortcut after restart', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      authorityDecision: unregisteredAuthority,
      readiness: { version: 1, durableVerified: false, sharedMemoryVerified: true },
      initial: { subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true },
    });
    expect(result.runCalls).toBe(0);
    expect(result.job).toMatchObject({ status: 'done', durablePlane: 'not-applicable' });
    expect(result.readiness?.durableVerified).toBe(false);
  });

  it('keeps VM required for a legacy registered-metadata participant fallback, including the ready shortcut', async () => {
    const { registration: _registration, ...legacyReadFallback } = unregisteredAuthority;
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      authorityDecision: legacyReadFallback,
      readiness: { version: 1, durableVerified: false, sharedMemoryVerified: true },
      initial: { subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true },
      result: privateSharedMemoryOnlyResult(),
    });
    expect(result.runCalls).toBe(1);
    expect(result.job).toMatchObject({ status: 'unreachable', durablePlane: 'required' });
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: true });
  });

  it('requires VM when the graph registers during catch-up', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      authorityDecision: unregisteredAuthority,
      authorityAfterCatchup: {
        outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
        metadataBootstrap: 'eligible', onChainId: 42n,
      },
      result: privateSharedMemoryOnlyResult(),
    });
    expect(result.job).toMatchObject({ status: 'unreachable', durablePlane: 'required' });
    expect(result.readiness?.durableVerified).toBe(false);
  });

  it.each(['denied', 'unavailable'] as const)('does not carry unregistered readiness through authority becoming %s', async (outcome) => {
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      authorityDecision: unregisteredAuthority,
      authorityAfterCatchup: {
        outcome, source: 'registered-chain', reason: 'authority-lost', metadataBootstrap: 'forbidden',
      },
      result: privateSharedMemoryOnlyResult(),
    });
    expect(result.job.status).toBe(outcome === 'denied' ? 'denied' : 'unreachable');
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: false });
    expect(result.state.synced).toBe(false);
  });

  it.each([true, false])('does not turn metadata-only private SWM into readiness even when VM is inapplicable (typed completions=%s)', async (typedCompletions) => {
    const metadataOnly = privateSharedMemoryMetaOnlyResult();
    if (!typedCompletions) delete metadataOnly.cleanPlaneCompletions;
    const result = await subscribe({
      hasConfirmedMeta: true,
      isPrivate: true,
      authorityDecision: unregisteredAuthority,
      result: metadataOnly,
    });
    expect(result.job).toMatchObject({ status: 'unreachable', durablePlane: 'not-applicable' });
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: false });
    expect(result.state.synced).toBe(false);
    expect(result.state.sharedMemorySynced).toBe(false);
  });

  it('preserves confirmed metadata after no response and transient completion-authority failure, so recovery admits a retry', async () => {
    const noResponse = cleanEmptyResult();
    noResponse.peersResponded = 0;
    noResponse.peersSucceeded = 0;
    noResponse.cleanPlaneCompletions = {
      durable: { verifiedDataPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    };
    noResponse.diagnostics!.durable.emptyResponses = 0;
    noResponse.diagnostics!.sharedMemory.emptyResponses = 0;
    const result = await subscribe({
      hasConfirmedMeta: true, isPrivate: true, forceCatchup: true,
      initial: { subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true, pendingMeta: false },
      readiness: { version: 1, durableVerified: false, sharedMemoryVerified: true },
      authorityDecision: unregisteredAuthority,
      authorityAfterCatchup: { outcome: 'unavailable', source: 'legacy-local', reason: 'store-failure', metadataBootstrap: 'eligible' },
      result: noResponse, recoverAuthorityForRetry: true,
    });
    expect(result.job.status).toBe('unreachable');
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: false });
    expect(result.state).toMatchObject({ synced: false, sharedMemorySynced: false, metaSynced: true, pendingMeta: false });
    expect(result.retryResponseStatus).toBe(200);
  });

  it('preserves metadata flags when a completion metadata inspection fails', async () => {
    const result = await subscribe({
      hasConfirmedMeta: true, isPrivate: true, forceCatchup: true,
      initial: { subscribed: true, synced: true, sharedMemorySynced: true, metaSynced: true, pendingMeta: false },
      readiness: { version: 1, durableVerified: false, sharedMemoryVerified: true },
      authorityDecision: unregisteredAuthority,
      result: privateSharedMemoryOnlyResult(), metadataInspectionFailsAfterCatchup: true,
    });
    expect(result.job.status).toBe('unreachable');
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: false });
    expect(result.state).toMatchObject({ synced: false, sharedMemorySynced: false, metaSynced: true, pendingMeta: false });
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
