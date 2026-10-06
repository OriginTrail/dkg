import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { CatchupJobResult } from '../src/catchup-runner.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { daemonState } from '../src/daemon/state.js';
import { catchupReadinessResult, durableDiagnostics, sharedMemoryDiagnostics } from './_helpers/catchup-readiness-fixtures.js';

// The real agent mixins own metadata/authority fencing, proof composition,
// cancellation, and the synchronous commit. Only their finalized-proof leaf
// is controlled here; these tests exercise the HTTP subscribe lifecycle.
const proofLeaf = vi.hoisted(() => ({ attempt: vi.fn() }));
vi.mock('../../agent/dist/registered-private-empty-vm-attempt-v1.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../agent/dist/registered-private-empty-vm-attempt-v1.js')>(),
  attemptRegisteredPrivateEmptyVmV1: proofLeaf.attempt,
}));
import { DKGAgent } from '@origintrail-official/dkg-agent';

const CALLER = `0x${'11'.repeat(20)}`;
const ALLOWED = {
  outcome: 'allowed' as const, source: 'registered-chain' as const,
  reason: 'chain-participant', metadataBootstrap: 'eligible' as const, onChainId: 7n,
};

function emptyPeerRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 1, totalPeers: 1, selectedPeers: 1, syncCapablePeers: 1,
    peersTried: 1, peersResponded: 1, peersSucceeded: 1,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, emptyPeers: 1 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 1 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: durableDiagnostics({ completedPhases: 2, emptyResponses: 1 }),
      sharedMemory: sharedMemoryDiagnostics({ completedPhases: 2, emptyResponses: 1 }),
    },
  });
}

function privateMetadataOnlyRound(sharedMemoryOnly = false): CatchupJobResult {
  const result = emptyPeerRound();
  if (!result.diagnostics || !result.cleanPlaneCompletions) throw new Error('missing typed evidence');
  result.diagnostics.durable.emptyResponses = 0;
  result.cleanPlaneCompletions.durable.emptyPeers = 0;
  if (sharedMemoryOnly) {
    result.diagnostics.sharedMemory.emptyResponses = 0;
    result.diagnostics.sharedMemory.fetchedMetaTriples = 7;
    result.diagnostics.sharedMemory.insertedMetaTriples = 1;
    result.diagnostics.sharedMemory.bytesReceived = 90;
    result.cleanPlaneCompletions.sharedMemory.emptyPeers = 0;
  } else {
    result.diagnostics.durable.fetchedMetaTriples = 7;
    result.diagnostics.durable.insertedMetaTriples = 1;
    result.diagnostics.durable.metaOnlyResponses = 1;
  }
  return result;
}

describe('registered private empty-VM subscribe settlement', () => {
  const previousCatchupRunner = daemonState.catchupRunner;
  let server: Server | undefined;

  afterEach(async () => {
    daemonState.catchupRunner = previousCatchupRunner;
    proofLeaf.attempt.mockReset();
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  async function subscribe(opts: {
    result?: CatchupJobResult;
    catchupRunWaitFor?: Promise<void>;
    onEarlyProofAttempt?: () => void;
    finalizedEmptyPrivateVm: boolean;
    finalizedEmptyPrivateVmAfterCatchup?: boolean;
    retryableProofOnce?: boolean;
    invalidateMetaDuringProof?: boolean;
    throwEarlyReadinessCommitOnce?: boolean;
    revokeOnTerminalProof?: boolean;
  }) {
    const contextGraphId = `empty-vm-${Math.random().toString(36).slice(2, 8)}`;
    const subscriptions = new Map<string, Record<string, any>>([
      [contextGraphId, { subscribed: false, sharedMemorySynced: false }],
    ]);
    const jobs = new Map<string, any>();
    const catchupTracker = { jobs, latestByContextGraph: new Map<string, string>() };
    let readiness: Record<string, unknown> | undefined;
    let catchupCompleted = false;
    let authorityRevoked = false;
    let metadataInvalidated = false;
    let metadataRevision = 0;
    let earlyReadinessCommitFailureInjected = false;
    let retryableProofReturned = false;
    const proofAttempts: Array<{ phase: 'early' | 'terminal'; proven: boolean }> = [];

    proofLeaf.attempt.mockImplementation(async () => {
      const phase = catchupCompleted ? 'terminal' as const : 'early' as const;
      if (phase === 'early') opts.onEarlyProofAttempt?.();
      if (opts.retryableProofOnce && !retryableProofReturned) {
        retryableProofReturned = true;
        proofAttempts.push({ phase, proven: false });
        return { proven: false as const, retryable: true };
      }
      if (opts.invalidateMetaDuringProof && !metadataInvalidated) {
        metadataInvalidated = true;
        metadataRevision += 1;
        subscriptions.set(contextGraphId, {
          ...subscriptions.get(contextGraphId), synced: false, metaSynced: false, pendingMeta: true,
        });
      }
      if (phase === 'terminal' && opts.revokeOnTerminalProof) authorityRevoked = true;
      const proven = !metadataInvalidated && !authorityRevoked && (phase === 'terminal'
        ? opts.finalizedEmptyPrivateVmAfterCatchup ?? opts.finalizedEmptyPrivateVm
        : opts.finalizedEmptyPrivateVm);
      proofAttempts.push({ phase, proven });
      return proven
        ? { proven: true as const, metadataRevision: String(metadataRevision), onChainId: 7n }
        : { proven: false as const };
    });

    daemonState.catchupRunner = {
      run: async () => {
        await opts.catchupRunWaitFor;
        catchupCompleted = true;
        return opts.result ?? emptyPeerRound();
      },
      close: async () => {},
    };

    const agent = {
      subscribedContextGraphs: subscriptions,
      contextGraphMetaProjection: {
        readContextGraphAuthorityFactsRevision: () => String(metadataRevision),
      },
      inspectAndCommitContextGraphReadinessV1: DKGAgent.prototype.inspectAndCommitContextGraphReadinessV1,
      prepareContextGraphReadinessWithPrivateEmptyVmV1:
        DKGAgent.prototype.prepareContextGraphReadinessWithPrivateEmptyVmV1,
      inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1:
        DKGAgent.prototype.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1,
      proveRegisteredPrivateEmptyVmV1: DKGAgent.prototype.proveRegisteredPrivateEmptyVmV1,
      hasConfirmedMetaState: async () => !metadataInvalidated,
      isPrivateContextGraph: async () => true,
      resolveContextGraphSubscriptionBootstrapAuthority: async () => authorityRevoked
        ? { outcome: 'denied', source: 'registered-chain', reason: 'agent-not-in-chain-roster', metadataBootstrap: 'forbidden' }
        : ALLOWED,
      getContextGraphAllowedAgents: async () => [],
      getSubscribedContextGraphs: () => subscriptions,
      subscribeToContextGraph: (id: string, options?: { syncMode?: string }) => {
        const next = { ...subscriptions.get(id), subscribed: true, synced: false,
          syncMode: options?.syncMode ?? 'always-on' };
        subscriptions.set(id, next);
        return next;
      },
      markContextGraphSubscriptionState: (id: string, patch: Record<string, unknown>) => {
        if (opts.throwEarlyReadinessCommitOnce && patch.synced === true && !catchupCompleted) {
          opts.throwEarlyReadinessCommitOnce = false;
          earlyReadinessCommitFailureInjected = true;
          throw new Error('test readiness write failure');
        }
        subscriptions.set(id, { ...subscriptions.get(id), ...patch });
      },
      reconcileRfc64CatalogResponsibilityV1: async () => {},
      bootstrapRfc64CatalogContextGraphMetadataFromPeersV1: async () => 'no-accepted-public-policy',
      resolveAgentByToken: () => undefined,
      getDefaultAgentAddress: () => CALLER,
      getRfc64SelectedSwmGraphSyncStatus: () => ({
        mechanism: 'rfc64-selected-on-connect', state: 'inactive',
        configuredProviderCount: 0, retryRequiredProviderCount: 0, terminalProviderCount: 0,
      }),
    };

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const routeContext = {
        req, res, agent, publisherControl: {}, publisherRuntime: null,
        config: { auth: { enabled: false } }, startedAt: Date.now(),
        dashDb: {
          getContextGraphReadinessProvenance: () => readiness ?? null,
          setContextGraphReadinessProvenance: (_id: string, next: Record<string, unknown>) => {
            readiness = { ...next, updatedAt: Date.now() };
          },
        },
        opWallets: {}, network: {}, tracker: {}, memoryManager: {}, bridgeAuthToken: undefined,
        nodeVersion: 'test', nodeCommit: 'test', catchupTracker, extractionRegistry: {}, fileStore: {},
        extractionStatus: new Map(), assertionImportLocks: new Map(), vectorStore: {},
        embeddingProvider: null, validTokens: new Set(), apiHost: '127.0.0.1', apiPortRef: { value: 0 },
        routePlugins: [], url, path: url.pathname, requestAgentAddress: undefined,
        authentication: requestAuthentication({ kind: 'nodeOperator' }),
      } as any;
      await handleContextGraphRoutes(routeContext);
      if (!res.writableEnded) await handleQueryRoutes(routeContext);
      if (!res.writableEnded) { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('route server did not bind');
    const httpResponse = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId, includeSharedMemory: true }),
    });
    const response = await httpResponse.json() as any;
    const jobId = response.catchup?.jobId as string | undefined;
    for (let i = 0; jobId && i < 50; i++) {
      if (jobs.get(jobId)?.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return {
      response, responseStatus: httpResponse.status, job: jobId ? jobs.get(jobId) : undefined,
      state: subscriptions.get(contextGraphId) ?? {}, readiness,
      proofAttempts, earlyReadinessCommitFailureInjected,
    };
  }

  it('opens only first-write VM readiness before an empty private catch-up completes', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    try {
      const result = await subscribe({ finalizedEmptyPrivateVm: true, catchupRunWaitFor });
      expect(result.responseStatus).toBe(200);
      expect(result.job.status).toBe('running');
      expect(result.state).toMatchObject({ subscribed: true, synced: true, metaSynced: true, sharedMemorySynced: false });
      expect(result.readiness).toMatchObject({ durableVerified: true, sharedMemoryVerified: false });
    } finally { finishCatchup(); }
  });

  it('returns the minted catch-up job if best-effort early readiness persistence throws', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    try {
      const result = await subscribe({
        finalizedEmptyPrivateVm: true, throwEarlyReadinessCommitOnce: true, catchupRunWaitFor,
      });
      expect(result.responseStatus).toBe(200);
      expect(result.response.catchup.jobId).toBeTruthy();
      expect(result.job.status).toBe('running');
      expect(result.earlyReadinessCommitFailureInjected).toBe(true);
      expect(result.proofAttempts).toContainEqual({ phase: 'early', proven: true });
    } finally { finishCatchup(); }
  });

  it('retries a transient proof refusal and opens readiness after the permit clears', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    try {
      const result = await subscribe({
        finalizedEmptyPrivateVm: true, retryableProofOnce: true, catchupRunWaitFor,
      });
      expect(result.proofAttempts).toEqual([
        { phase: 'early', proven: false }, { phase: 'early', proven: true },
      ]);
      expect(result.state).toMatchObject({ synced: true, sharedMemorySynced: false });
      expect(result.readiness).toMatchObject({ durableVerified: true, sharedMemoryVerified: false });
    } finally { finishCatchup(); }
  });

  it('commits a later finalized empty-VM proof after private metadata-only catch-up', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    const result = await subscribe({
      finalizedEmptyPrivateVm: false, finalizedEmptyPrivateVmAfterCatchup: true,
      catchupRunWaitFor, onEarlyProofAttempt: finishCatchup,
      result: privateMetadataOnlyRound(true),
    });
    expect(result.responseStatus).toBe(200);
    expect(result.job.finishedAt).toBeDefined();
    expect(result.proofAttempts).toEqual([
      { phase: 'early', proven: false }, { phase: 'terminal', proven: true },
    ]);
    expect(result.state).toMatchObject({ subscribed: true, synced: true, metaSynced: true, sharedMemorySynced: false });
    expect(result.readiness).toMatchObject({ durableVerified: true, sharedMemoryVerified: false });
  });

  it('clears early VM readiness if membership is revoked during terminal proof', async () => {
    let finishCatchup!: () => void;
    const catchupRunWaitFor = new Promise<void>((resolve) => { finishCatchup = resolve; });
    const result = await subscribe({
      finalizedEmptyPrivateVm: true, revokeOnTerminalProof: true,
      catchupRunWaitFor, onEarlyProofAttempt: finishCatchup,
      result: privateMetadataOnlyRound(true),
    });
    expect(result.responseStatus).toBe(200);
    expect(result.job.status).toBe('denied');
    expect(result.proofAttempts).toEqual([
      { phase: 'early', proven: true }, { phase: 'terminal', proven: false },
    ]);
    expect(result.state).toMatchObject({ synced: false, sharedMemorySynced: false });
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: false });
  });

  it('keeps a denied peer status while an independent proof opens VM readiness', async () => {
    const deniedRound = privateMetadataOnlyRound(true);
    deniedRound.denied = true;
    deniedRound.deniedPeers = 1;
    deniedRound.peersSucceeded = 0;
    const result = await subscribe({ finalizedEmptyPrivateVm: true, result: deniedRound });
    expect(result.job.status).toBe('denied');
    expect(result.state).toMatchObject({ synced: true, sharedMemorySynced: false });
    expect(result.readiness).toMatchObject({ durableVerified: true, sharedMemoryVerified: false });
  });

  it('does not restore readiness after metadata invalidates during the proof', async () => {
    const result = await subscribe({
      finalizedEmptyPrivateVm: true, invalidateMetaDuringProof: true,
      result: privateMetadataOnlyRound(),
    });
    expect(result.job.finishedAt).toBeDefined();
    expect(result.state).toMatchObject({ synced: false, metaSynced: false, pendingMeta: true });
    expect(result.readiness).toMatchObject({ durableVerified: false, sharedMemoryVerified: false });
  });
});
