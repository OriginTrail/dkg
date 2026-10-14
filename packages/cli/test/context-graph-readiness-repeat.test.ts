// A public graph whose subscribe job ends unproven gets its catch-up job again
// until it is proven synced (issue #3207 item 3; seen on Base mainnet with
// 10.0.24, where a member stayed `synced: false` for good).
//
// First: the harness mocks `node:worker_threads`, so the catch-up runner loaded
// below runs its real worker in this thread.
import './helpers/catchup-runner-worker-test-harness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DKGAgent, emptySharedMemorySyncResult } from '@origintrail-official/dkg-agent';
import { createIncompleteDurableSyncResult } from '@origintrail-official/dkg-agent/dist/sync/durable-progress.js';
import { recordSharedMemoryPhaseFailure } from '@origintrail-official/dkg-agent/dist/sync/shared-memory-diagnostics.js';
import type { CatchupJobResult, CatchupRunner } from '../src/catchup-runner.js';
import { catchupReadinessResult, sharedMemoryDiagnostics } from './_helpers/catchup-readiness-fixtures.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

await import('../src/catchup-runner-worker-impl.js');
const { createCatchupRunner } = await import('../src/catchup-runner.js');
const { handleContextGraphRoutes } = await import('../src/daemon/routes/context-graph.js');
const { daemonState } = await import('../src/daemon/state.js');
const {
  CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS,
  readinessRepeatTimers,
  resetContextGraphReadinessRepeats,
} = await import('../src/daemon/context-graph-readiness-repeat.js');
const { startContextGraphCatchupJob } = await import('../src/daemon/context-graph-catchup-job.js');

const CG = '0x1111111111111111111111111111111111111111/issue-3207-empty-public';
const PEERS = ['peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5', 'peer-6', 'peer-7', 'peer-8'];

/** Admission of a public graph that is not registered on chain: its accepted owner policy. */
const PUBLIC_UNREGISTERED = Object.freeze({
  outcome: 'allowed',
  source: 'rfc64-public',
  reason: 'accepted-public-policy',
  metadataBootstrap: 'eligible',
  grantScope: 'public',
  registration: 'unregistered',
} as const);

/** A peer's answer for a graph with nothing in it: both phases complete and empty. */
function emptyAnswer(peerId: string) {
  return {
    kind: 'selected-shared-memory',
    shared: {
      ...emptySharedMemorySyncResult(),
      emptyResponses: 1,
      completedPhases: 2,
      swmCoverage: {
        contextGraphId: CG,
        peerIdSuffix: peerId,
        snapshotsResolved: 0,
        snapshotsTotal: 0,
        manifestComplete: true,
        descriptorsAuthoritative: true,
        missingCount: 0,
        missingSample: [],
        materializationFailures: 0,
      },
    },
    scopeComplete: false,
  };
}

/**
 * What the requester returns for a sync this node aborted itself. A receiver
 * selection change of the graph revokes the graph's recovery lease; every
 * sync holding it throws "RFC-64 SWM recovery authority was revoked", and the
 * requester records that error, which carries no transport tag, as a failed
 * phase of a peer that did answer.
 */
function revokedAnswer() {
  const shared = emptySharedMemorySyncResult();
  recordSharedMemoryPhaseFailure(shared, 'materialization');
  return { kind: 'selected-shared-memory', shared, scopeComplete: false };
}

/** A round of eight peers: five answered empty, three were revoked mid-sync. */
function lossyEmptyRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 8, totalPeers: 8, selectedPeers: 8, syncCapablePeers: 8,
    peersTried: 8, peersResponded: 8, peersSucceeded: 5,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 5, incompleteResponders: 3 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: catchupReadinessResult().diagnostics.durable,
      sharedMemory: sharedMemoryDiagnostics({ emptyResponses: 5, completedPhases: 10, failedPhases: 3 }),
    },
  });
}

/** The same graph a moment later: every peer answered empty. */
function cleanEmptyRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 8, totalPeers: 8, selectedPeers: 8, syncCapablePeers: 8,
    peersTried: 8, peersResponded: 8, peersSucceeded: 8,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 8 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: catchupReadinessResult().diagnostics.durable,
      sharedMemory: sharedMemoryDiagnostics({ emptyResponses: 8, completedPhases: 16 }),
    },
  });
}

/** Every peer refused the graph: no clean answer outranks the denial. */
function deniedRound(): CatchupJobResult {
  return catchupReadinessResult({
    connectedPeers: 8, totalPeers: 8, selectedPeers: 8, syncCapablePeers: 8,
    peersTried: 8, peersResponded: 8, denied: true, deniedPeers: 8,
    diagnostics: {
      noProtocolPeers: 0,
      durable: catchupReadinessResult().diagnostics.durable,
      sharedMemory: sharedMemoryDiagnostics({ deniedPhases: 8 }),
    },
  });
}

interface ArmedTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  fired: boolean;
}

type Authority = Record<string, unknown>;

/**
 * A member Edge: the subscription, the readiness store, the production
 * readiness inspection, and the agent side of the catch-up bridge over eight
 * sync-capable peers on the graph's selected public lane.
 */
function memberEdge() {
  const subscriptions = new Map<string, Record<string, unknown>>();
  let readiness: Record<string, unknown> | undefined;
  const node = {
    authority: PUBLIC_UNREGISTERED as Authority | (() => Authority),
    answer: (peerId: string): unknown => emptyAnswer(peerId),
  };
  const agent = {
    resolveContextGraphSubscriptionBootstrapAuthority: async () => (
      typeof node.authority === 'function' ? node.authority() : node.authority
    ),
    subscribedContextGraphs: subscriptions,
    getSubscribedContextGraphs: () => subscriptions,
    subscribeToContextGraph: (id: string, options?: { syncMode?: string }) => {
      const previous = subscriptions.get(id);
      const applied = {
        ...previous,
        subscribed: true,
        synced: previous?.synced ?? false,
        syncMode: options?.syncMode ?? 'always-on',
      };
      subscriptions.set(id, applied);
      return applied;
    },
    markContextGraphSubscriptionState: (id: string, patch: Record<string, unknown>) => {
      subscriptions.set(id, { ...subscriptions.get(id), ...patch });
    },
    // The graph's definition is installed; the job's metadata pull is a no-op.
    bootstrapRfc64CatalogContextGraphMetadataFromPeersV1: async () => 'already-confirmed',
    hasConfirmedMetaState: async () => true,
    isPrivateContextGraph: async () => false,
    reconcileRfc64CatalogResponsibilityV1: async () => {},
    contextGraphMetaProjection: { readContextGraphAuthorityFactsRevision: () => '0' },
    inspectAndCommitContextGraphReadinessV1: DKGAgent.prototype.inspectAndCommitContextGraphReadinessV1,
    prepareContextGraphReadinessWithPrivateEmptyVmV1:
      DKGAgent.prototype.prepareContextGraphReadinessWithPrivateEmptyVmV1,
    config: { chainConfig: undefined },
    contextGraphAuthorityReaderCapability: { status: 'unsupported' },
    resolveAgentByToken: () => undefined,
    getDefaultAgentAddress: () => '0x0000000000000000000000000000000000000001',
    // The catch-up bridge. No curator is resolvable for the walk, as for an
    // unregistered graph whose owner is one Edge among the connected peers.
    resolveSyncPeerWithProvenance: async () => ({ peerId: undefined, provenance: 'bootstrap-hint' }),
    resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
    resolveRfc64SwmRecoveryRuntimeAuthorityV1: (contextGraphId: string) => ({
      kind: 'rfc64-swm-recovery-runtime-authority-v1',
      contextGraphId,
      lane: 'selected-public',
      active: true,
    }),
    resolveRfc64CatalogReceiverAuthorityV1: (contextGraphId: string) => ({
      contextGraphId,
      legacySyncAllowed: false,
    }),
    ensurePeerConnected: async () => {},
    primeCatchupConnections: async () => {},
    listAdmittedConnectedPeers: async () => PEERS.map((peerId) => ({ toString: () => peerId })),
    selectCatchupPeers: (peers: Array<{ toString(): string }>) => peers,
    waitForSyncProtocol: async () => true,
    syncDurableRecoveryContextGraph: async () => ({ result: createIncompleteDurableSyncResult() }),
    syncSelectedSharedMemoryFromPeerDetailed: async (peerId: string) => node.answer(peerId),
    syncSharedMemoryFromPeerDetailed: async () => {
      throw new Error('a catalog-authoritative graph has no ordinary shared-memory lane');
    },
    refreshMetaSyncedFlags: async () => {},
    log: { info: () => {}, debug: () => {}, warn: () => {} },
  };
  return {
    agent: agent as unknown as DKGAgent,
    node,
    subscription: () => subscriptions.get(CG),
    unsubscribe: () => subscriptions.set(CG, { ...subscriptions.get(CG), subscribed: false }),
    readiness: () => readiness,
    store: {
      getContextGraphReadinessProvenance: () => readiness ?? null,
      setContextGraphReadinessProvenance: (_id: string, next: Record<string, unknown>) => {
        readiness = { ...next, updatedAt: Date.now() };
      },
    },
  };
}

async function waitUntil<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a public graph that its subscribe job left unproven is caught up again', () => {
  const previousRunner = daemonState.catchupRunner;
  const originalTimers = { set: readinessRepeatTimers.set, clear: readinessRepeatTimers.clear };
  const timers: ArmedTimer[] = [];
  const servers: Server[] = [];
  const runners: CatchupRunner[] = [];

  beforeEach(() => {
    readinessRepeatTimers.set = (callback: () => void, delayMs: number) => {
      const timer: ArmedTimer = { callback, delayMs, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    };
    readinessRepeatTimers.clear = (handle: unknown) => {
      (handle as ArmedTimer).cleared = true;
    };
  });

  afterEach(async () => {
    resetContextGraphReadinessRepeats();
    readinessRepeatTimers.set = originalTimers.set;
    readinessRepeatTimers.clear = originalTimers.clear;
    timers.length = 0;
    daemonState.catchupRunner = previousRunner;
    daemonState.catchupAcceptingJobs = true;
    vi.restoreAllMocks();
    for (const runner of runners.splice(0)) await runner.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** Timers armed and not yet fired or cleared. */
  const armed = () => timers.filter((timer) => !timer.cleared && !timer.fired);

  function fire(timer: ArmedTimer | undefined): void {
    if (!timer) throw new Error('no repeat armed');
    timer.fired = true;
    timer.callback();
  }

  async function startRoutes(member: ReturnType<typeof memberEdge>) {
    const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleContextGraphRoutes({
        req,
        res,
        agent: member.agent,
        dashDb: member.store,
        catchupTracker,
        url,
        path: url.pathname,
        authentication: requestAuthentication({ kind: 'nodeOperator' }),
      } as any);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      catchupTracker,
      async subscribe(body: Record<string, unknown> = {}): Promise<string> {
        const response = await fetch(`http://127.0.0.1:${port}/api/context-graph/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contextGraphId: CG, includeSharedMemory: true, ...body }),
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { catchup: { jobId: string } }).catchup.jobId;
      },
      job: (jobId: string) => catchupTracker.jobs.get(jobId),
      finished: (jobId: string) => waitUntil(
        () => (catchupTracker.jobs.get(jobId)?.finishedAt ? catchupTracker.jobs.get(jobId) : undefined),
        `job ${jobId}`,
      ),
      latestJobId: () => catchupTracker.latestByContextGraph.get(CG),
    };
  }

  function stubRunner(rounds: Array<() => CatchupJobResult>) {
    const runs: string[] = [];
    const runner: CatchupRunner = {
      run: async (request) => {
        runs.push(request.contextGraphId);
        const next = rounds[Math.min(runs.length, rounds.length) - 1];
        return next();
      },
      close: async () => {},
    };
    daemonState.catchupRunner = runner;
    return { runner, runs };
  }

  it('proves an empty graph after a first round in which this node revoked three of its own syncs', async () => {
    // Base mainnet, 10.0.24: the owner Edge created a public graph that is
    // not registered on chain, and a member subscribed while it was empty.
    const member = memberEdge();
    const revokedMidRound = new Set(['peer-2', 'peer-5', 'peer-8']);
    member.node.answer = (peerId) => (revokedMidRound.has(peerId) ? revokedAnswer() : emptyAnswer(peerId));
    const runner = createCatchupRunner(member.agent);
    runners.push(runner);
    daemonState.catchupRunner = runner;
    const api = await startRoutes(member);

    const firstJobId = await api.subscribe();
    const first = await api.finished(firstJobId);

    // The failed round on the empty graph. Five peers answered empty, three
    // answered and then failed, so "nobody has anything" is not established.
    expect(first.status).toBe('unreachable');
    expect(first.result.cleanPlaneCompletions.sharedMemory).toMatchObject({
      verifiedDataPeers: 0, emptyPeers: 5, incompleteResponders: 3,
    });
    expect(first.result.diagnostics.sharedMemory).toMatchObject({ failedPeers: 0, failedPhases: 3 });
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: false });
    expect(member.readiness()).toMatchObject({ version: 1, sharedMemoryVerified: false });
    // Before the fix nothing ran the job again. Now the job arms one repeat.
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[0]]);

    // Meanwhile root-scope shares reach the member on the catalog lane. That
    // lane writes no readiness, and the graph's shared-memory lane carries no
    // root-scope content, so the peers still answer both phases empty. The
    // revocation is over.
    member.node.answer = (peerId) => emptyAnswer(peerId);
    fire(armed()[0]);
    const repeatJobId = await waitUntil(() => {
      const latest = api.latestJobId();
      return latest !== firstJobId ? latest : undefined;
    }, 'the repeated job');
    const repeat = await api.finished(repeatJobId);

    expect(repeat.status).toBe('done');
    expect(repeat.result.cleanPlaneCompletions.sharedMemory).toMatchObject({ emptyPeers: 8 });
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(member.readiness()).toMatchObject({ version: 1, sharedMemoryVerified: true });
    // A proven graph arms nothing further.
    expect(armed()).toEqual([]);
  });

  it('arms no repeat for a graph the job proved, a registered or private graph, a denial or a job without shared memory', async () => {
    const cases: Array<{
      name: string;
      round: () => CatchupJobResult;
      authority?: Authority;
      includeSharedMemory?: boolean;
    }> = [
      { name: 'proven', round: cleanEmptyRound },
      {
        name: 'registered',
        round: lossyEmptyRound,
        authority: {
          outcome: 'allowed', source: 'registered-chain', reason: 'chain-public',
          metadataBootstrap: 'eligible', grantScope: 'public',
        },
      },
      {
        name: 'private',
        round: lossyEmptyRound,
        authority: { ...PUBLIC_UNREGISTERED, source: 'rfc64-private', reason: 'roster-member', grantScope: 'caller' },
      },
      { name: 'denied', round: deniedRound },
      { name: 'durable only', round: lossyEmptyRound, includeSharedMemory: false },
    ];
    for (const testCase of cases) {
      const member = memberEdge();
      if (testCase.authority) member.node.authority = testCase.authority;
      stubRunner([testCase.round]);
      const api = await startRoutes(member);
      const job = await api.finished(await api.subscribe(
        testCase.includeSharedMemory === false ? { includeSharedMemory: false } : {},
      ));
      expect({ name: testCase.name, status: job.status, armed: armed().length })
        .toMatchObject({ name: testCase.name, armed: 0 });
      if (testCase.name === 'denied') expect(job.status).toBe('denied');
    }
  });

  it('stops when the graph is unsubscribed, the daemon stops taking jobs, or its runner was replaced', async () => {
    const stops: Array<{
      name: string;
      stop: (member: ReturnType<typeof memberEdge>) => string[] | undefined;
    }> = [
      { name: 'unsubscribed', stop: (member) => { member.unsubscribe(); return undefined; } },
      { name: 'shutting down', stop: () => { daemonState.catchupAcceptingJobs = false; return undefined; } },
      { name: 'runner replaced', stop: () => stubRunner([cleanEmptyRound]).runs },
    ];
    for (const { name, stop } of stops) {
      const member = memberEdge();
      const { runs } = stubRunner([lossyEmptyRound, cleanEmptyRound]);
      const api = await startRoutes(member);
      await api.finished(await api.subscribe());
      const timer = armed()[0];
      expect({ name, delayMs: timer?.delayMs }).toEqual({ name, delayMs: CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[0] });

      const replacementRuns = stop(member) ?? [];
      fire(timer);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect({ name, runs: runs.length + replacementRuns.length, armed: armed().length })
        .toEqual({ name, runs: 1, armed: 0 });
      daemonState.catchupAcceptingJobs = true;
    }
  });

  it('lets a newer subscribe call end the older chain; the newer job arms a first repeat of its own', async () => {
    const member = memberEdge();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runs: string[] = [];
    daemonState.catchupRunner = {
      run: async (request) => {
        runs.push(request.contextGraphId);
        if (runs.length === 2) await held;
        return lossyEmptyRound();
      },
      close: async () => {},
    };
    const api = await startRoutes(member);
    await api.finished(await api.subscribe());
    const firstTimer = armed()[0];

    // The second call's job starts a chain of its own and clears the first
    // chain's repeat. A timer that fires anyway starts nothing.
    const secondJobId = await api.subscribe();
    await waitUntil(() => (runs.length === 2 ? true : undefined), 'the second job to run');
    expect(firstTimer.cleared).toBe(true);
    fire(firstTimer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toHaveLength(2);

    release();
    await api.finished(secondJobId);
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[0]]);
  });

  it('ends the chain when a newer subscribe call does not ask for shared memory', async () => {
    const member = memberEdge();
    const { runs } = stubRunner([lossyEmptyRound]);
    const api = await startRoutes(member);
    await api.finished(await api.subscribe());
    const firstTimer = armed()[0];

    await api.finished(await api.subscribe({ includeSharedMemory: false }));

    expect(firstTimer.cleared).toBe(true);
    expect(armed()).toEqual([]);
    expect(runs).toHaveLength(2);
  });

  it('starts and arms nothing when a newer subscribe call arrives while a repeat reads admission', async () => {
    // The older repeat's admission read comes back either way: allowed, or
    // unavailable (which would otherwise arm that chain's next repeat).
    for (const answer of ['allowed', 'unavailable'] as const) {
      const member = memberEdge();
      const { runs } = stubRunner([lossyEmptyRound]);
      const api = await startRoutes(member);
      await api.finished(await api.subscribe());

      let releaseAdmission!: () => void;
      const admissionHeld = new Promise<void>((resolve) => { releaseAdmission = resolve; });
      let holdNext = true;
      member.node.authority = () => {
        if (!holdNext) return PUBLIC_UNREGISTERED;
        holdNext = false;
        return admissionHeld.then(() => {
          if (answer === 'unavailable') throw new Error('authority read timed out');
          return PUBLIC_UNREGISTERED;
        }) as unknown as Authority;
      };
      fire(armed()[0]);
      await waitUntil(() => (holdNext ? undefined : true), `${answer}: the repeat to read admission`);

      // The newer call's job runs, ends unproven and arms a first repeat of
      // its own chain; then the older repeat's admission read returns.
      await api.finished(await api.subscribe());
      const newerTimer = armed()[0];
      releaseAdmission();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect({ answer, runs: runs.length, cleared: newerTimer?.cleared, armed: armed().length })
        .toEqual({ answer, runs: 2, cleared: false, armed: 1 });
      expect(armed()[0]).toBe(newerTimer);
      resetContextGraphReadinessRepeats();
      timers.length = 0;
    }
  });

  it('checks again after its admission read: a daemon that stopped taking jobs meanwhile gets none', async () => {
    const member = memberEdge();
    const { runs } = stubRunner([lossyEmptyRound]);
    const api = await startRoutes(member);
    await api.finished(await api.subscribe());

    member.node.authority = () => {
      daemonState.catchupAcceptingJobs = false;
      return PUBLIC_UNREGISTERED;
    };
    fire(armed()[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runs).toHaveLength(1);
    expect(armed()).toEqual([]);
  });

  it('counts a repeat whose admission read failed and stops when the graph is no longer public', async () => {
    const member = memberEdge();
    const { runs } = stubRunner([lossyEmptyRound]);
    const api = await startRoutes(member);
    await api.finished(await api.subscribe());

    // Authority could not answer when the first repeat came due: no job, and
    // the second repeat is armed with the second delay.
    member.node.authority = () => { throw new Error('authority read timed out'); };
    fire(armed()[0]);
    await waitUntil(() => (armed().length === 1 ? true : undefined), 'the next repeat');
    expect(runs).toHaveLength(1);
    expect(armed()[0].delayMs).toBe(CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[1]);

    // The graph's admission is now a member grant, not a public one: stop.
    member.node.authority = { ...PUBLIC_UNREGISTERED, grantScope: 'caller' };
    fire(armed()[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toHaveLength(1);
    expect(armed()).toEqual([]);
  });

  it('runs every repeat while the graph stays unproven, then stops and says so', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const member = memberEdge();
    const { runs } = stubRunner([lossyEmptyRound]);
    const api = await startRoutes(member);
    await api.finished(await api.subscribe());

    const delays: number[] = [];
    for (let repeat = 1; repeat <= CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS.length; repeat += 1) {
      const timer = armed()[0];
      delays.push(timer.delayMs);
      fire(timer);
      await waitUntil(() => (runs.length === repeat + 1 ? true : undefined), `repeat ${repeat}`);
      await api.finished(api.latestJobId()!);
    }

    expect(delays).toEqual([...CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS]);
    expect(armed()).toEqual([]);
    expect(member.subscription()).toMatchObject({ synced: false });
    expect(log.mock.calls.flat().join('\n')).toContain(
      `"${CG}" is still not proven synced after ${CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS.length} repeated catch-up job(s)`,
    );
  });
  it('repeats a job that local backpressure deferred, also when the metadata pull failed', async () => {
    const member = memberEdge();
    (member.agent as any).bootstrapRfc64CatalogContextGraphMetadataFromPeersV1 = async () => {
      throw new Error('no connected peer served the declaration');
    };
    const { runs } = stubRunner([() => ({ ...lossyEmptyRound(), deferredBackpressure: 1 }), cleanEmptyRound]);
    const api = await startRoutes(member);
    const firstJobId = await api.subscribe();
    const first = await api.finished(firstJobId);
    expect(first.status).toBe('deferred');

    fire(armed()[0]);
    const repeatJobId = await waitUntil(() => {
      const latest = api.latestJobId();
      return latest !== firstJobId ? latest : undefined;
    }, 'the repeated job');
    expect((await api.finished(repeatJobId)).status).toBe('done');
    expect(runs).toHaveLength(2);
    expect(member.subscription()).toMatchObject({ synced: true });
  });

  it('logs a repeat that throws and starts nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const member = memberEdge();
    const { runs } = stubRunner([lossyEmptyRound]);
    const api = await startRoutes(member);
    await api.finished(await api.subscribe());

    (member.agent as any).getSubscribedContextGraphs = () => {
      throw new Error('subscription store closed');
    };
    fire(armed()[0]);
    await waitUntil(() => (error.mock.calls.length > 0 ? true : undefined), 'the error line');

    expect(String(error.mock.calls[0]?.[0])).toContain(
      `readiness repeat for "${CG}" failed: subscription store closed`,
    );
    expect(runs).toHaveLength(1);
    expect(armed()).toEqual([]);
  });

  it('keeps the job tracker to a hundred jobs, dropping the oldest', async () => {
    const member = memberEdge();
    stubRunner([cleanEmptyRound]);
    (member.agent as any).subscribeToContextGraph(CG);
    const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
    for (let i = 0; i < 100; i += 1) {
      catchupTracker.jobs.set(`old-${i}`, {
        jobId: `old-${i}`, contextGraphId: `old-graph-${i}`, includeWorkspace: true, status: 'done', queuedAt: i,
      });
      catchupTracker.latestByContextGraph.set(`old-graph-${i}`, `old-${i}`);
    }

    const job = startContextGraphCatchupJob({
      agent: member.agent,
      store: member.store,
      catchupTracker,
      contextGraphId: CG,
      includeSharedMemory: true,
      requestAgentAddress: undefined,
      callerAgentAddress: undefined,
      admissionAuthority: PUBLIC_UNREGISTERED,
    });

    expect(catchupTracker.jobs.size).toBe(100);
    expect(catchupTracker.jobs.has('old-0')).toBe(false);
    expect(catchupTracker.latestByContextGraph.has('old-graph-0')).toBe(false);
    expect(catchupTracker.latestByContextGraph.get(CG)).toBe(job.jobId);
    await waitUntil(() => (job.finishedAt ? job : undefined), 'the job');
    expect(job.status).toBe('done');
  });
});
