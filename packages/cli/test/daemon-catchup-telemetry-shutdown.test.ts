// W1 §6.6/§6.7 — catch-up request/job accounting (I7–I9) and the
// producer-quiescent shutdown that drains it.
//
// The suite drives the REAL `WorkerCatchupRunner` (via `createCatchupRunner`)
// behind the same minimal fake `node:worker_threads` the existing
// `catchup-runner-worker-lifecycle.test.ts` uses. That matters more here than
// anywhere else: the whole shutdown ordering rests on `close()` being
// `worker.terminate()` and its `exit` handler rejecting every pending run, and
// a fabricated `Promise` ledger would let a terminate-before-drain ordering
// pass. The grace-drain test below asserts BOTH sides of that — drain first
// settles the job normally, drain after termination does not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult } from '../src/catchup-runner.js';

type Listener = (...args: unknown[]) => void;

const workerControl = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, Listener[]>(),
    posted: [] as any[],
    terminated: false,
  };
  class FakeWorker {
    constructor(_path: string) {
      state.listeners.clear();
      state.posted.length = 0;
      state.terminated = false;
    }

    on(event: string, listener: Listener) {
      const existing = state.listeners.get(event) ?? [];
      existing.push(listener);
      state.listeners.set(event, existing);
    }

    /** Test-only: deliver a message as if the worker had sent it. */
    static emitToRunner(message: unknown) {
      for (const listener of state.listeners.get('message') ?? []) listener(message);
    }

    postMessage(message: unknown) {
      state.posted.push(message);
    }

    async terminate() {
      state.terminated = true;
      // Node emits 'exit' (code 1) for a terminated worker, never 'error'.
      for (const listener of state.listeners.get('exit') ?? []) listener(1);
      return 1;
    }
  }
  return { state, FakeWorker };
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  Worker: workerControl.FakeWorker,
}));

const { createCatchupRunner } = await import('../src/catchup-runner.js');
const { getMetrics } = await import('@origintrail-official/dkg-core');
const { handleContextGraphRoutes } = await import('../src/daemon/routes/context-graph.js');
const { handleQueryRoutes } = await import('../src/daemon/routes/query.js');
const { daemonState } = await import('../src/daemon/state.js');
const { CONTEXT_GRAPH_READINESS_VERSION } = await import('../src/context-graph-readiness.js');
const {
  CATCHUP_SHUTDOWN_DRAIN_BUDGET_MS,
  beginWalkCatchupJob,
  catchupLedgerSize,
  drainCatchupJobs,
  releaseCatchupJob,
  resetCatchupJobLedger,
} = await import('../src/daemon/catchup-telemetry.js');
const {
  beginGracefulShutdown,
  buildProducerQuiescentTeardownSteps,
  runProducerQuiescentTeardown,
} = await import('../src/daemon/teardown.js');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── metric capture ─────────────────────────────────────────────────────────
// Spies sit on the objects `getMetrics()` returns, which is the exact cached
// instance every production record site reaches through.

interface Point {
  value: number;
  attrs: Record<string, unknown>;
}

/**
 * Capture the I7/I8/I9 points the route and the drain emit.
 *
 * The API's no-op meter hands out SINGLETON instrument objects, so with no
 * provider registered `contextGraphCatchupRequestsTotal` and
 * `contextGraphCatchupJobsTotal` are literally the same object — spying on
 * each in turn would leave only the last spy installed and silently funnel
 * every counter into one bucket. Spy once per distinct object and separate the
 * points by their attributes, which works either way.
 */
function captureCatchupMetrics() {
  const m = getMetrics();
  const counterPoints: Point[] = [];
  const durations: Point[] = [];
  const record = (sink: Point[]) =>
    ((value: number, attrs: Record<string, unknown>) => {
      sink.push({ value, attrs: { ...attrs } });
    }) as any;

  const counters = new Set<object>([
    m.contextGraphCatchupRequestsTotal,
    m.contextGraphCatchupJobsTotal,
  ]);
  const spies = [...counters].map((counter) =>
    vi.spyOn(counter as any, 'add').mockImplementation(record(counterPoints)),
  );
  spies.push(
    vi.spyOn(m.contextGraphCatchupJobDurationMs, 'record').mockImplementation(record(durations)),
  );

  const requests = () => counterPoints.filter((p) => 'result' in p.attrs);
  const jobs = () => counterPoints.filter((p) => 'status' in p.attrs);
  return {
    requests,
    jobs,
    durations,
    results: () => requests().map((p) => p.attrs.result as string),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

// ── route harness ──────────────────────────────────────────────────────────

function verifiedBothPlanesResult(): CatchupJobResult {
  return {
    connectedPeers: 1,
    totalPeers: 1,
    selectedPeers: 1,
    syncCapablePeers: 1,
    peersTried: 1,
    peersResponded: 1,
    peersSucceeded: 1,
    deferredBackpressure: 0,
    dataSynced: 3,
    sharedMemorySynced: 4,
    denied: false,
    deniedPeers: 0,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 1, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 1, emptyPeers: 0 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 2, fetchedDataTriples: 3, insertedMetaTriples: 2,
        insertedDataTriples: 3, bytesReceived: 900, resumedPhases: 0,
        timedOutPhases: 0, completedPhases: 2, checkpointAdvances: 1,
        emptyResponses: 0, metaOnlyResponses: 0, verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0, rejectedKcs: 0, failedPeers: 0,
        failedPhases: 0, deferredBackpressure: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 1, fetchedDataTriples: 4, insertedMetaTriples: 1,
        insertedDataTriples: 4, bytesReceived: 700, resumedPhases: 0,
        timedOutPhases: 0, completedPhases: 2, checkpointAdvances: 1,
        emptyResponses: 0, droppedDataTriples: 0, failedPeers: 0,
        failedPhases: 0, deferredBackpressure: 0,
      },
    },
  } as CatchupJobResult;
}

interface HarnessOptions {
  /** Pre-existing subscription state, keyed by contextGraphId. */
  subscriptions?: Record<string, Record<string, unknown>>;
  /** Pre-existing readiness provenance, keyed by contextGraphId. */
  readiness?: Record<string, Record<string, unknown>>;
  hasConfirmedMeta?: boolean;
  isPrivate?: boolean;
  allowedAgents?: string[];
  callerAddress?: string;
}

async function createHarness(opts: HarnessOptions = {}) {
  const subscriptions = new Map<string, Record<string, unknown>>(
    Object.entries(opts.subscriptions ?? {}),
  );
  const readiness = new Map<string, Record<string, unknown>>(
    Object.entries(opts.readiness ?? {}),
  );
  const catchupTracker = {
    jobs: new Map<string, any>(),
    latestByContextGraph: new Map<string, string>(),
  };
  const subscribeCalls: string[] = [];

  const agent = {
    getContextGraphAllowedAgents: async () => opts.allowedAgents ?? [],
    getSubscribedContextGraphs: () => subscriptions,
    subscribeToContextGraph: (id: string) => {
      subscribeCalls.push(id);
      subscriptions.set(id, { ...subscriptions.get(id), subscribed: true });
    },
    markContextGraphSubscriptionState: (id: string, patch: Record<string, unknown>) => {
      subscriptions.set(id, { ...subscriptions.get(id), ...patch });
    },
    hasConfirmedMetaState: async () => opts.hasConfirmedMeta ?? true,
    isPrivateContextGraph: async () => opts.isPrivate ?? false,
    resolveAgentByToken: () => undefined,
    getDefaultAgentAddress: () =>
      opts.callerAddress ?? '0x0000000000000000000000000000000000000001',
    eventBus: { emit: () => {} },
    refreshMetaSyncedFlags: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const routeContext = {
      req, res, agent,
      publisherControl: {},
      publisherRuntime: null,
      config: { auth: { enabled: false } },
      startedAt: Date.now(),
      dashDb: {
        getContextGraphReadinessProvenance: (id: string) => readiness.get(id) ?? null,
        setContextGraphReadinessProvenance: (id: string, next: Record<string, unknown>) => {
          readiness.set(id, { ...next, updatedAt: Date.now() });
        },
      },
      opWallets: {}, network: {}, tracker: {}, memoryManager: {},
      bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test',
      catchupTracker,
      extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(),
      assertionImportLocks: new Map(), vectorStore: {}, embeddingProvider: null,
      validTokens: new Set(), apiHost: '127.0.0.1', apiPortRef: { value: 0 },
      routePlugins: [], url, path: url.pathname,
      requestToken: undefined, requestAgentAddress: undefined,
    } as any;
    await handleContextGraphRoutes(routeContext);
    if (!res.writableEnded) await handleQueryRoutes(routeContext);
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    catchupTracker,
    subscribeCalls,
    subscriptions,
    async subscribe(body: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${port}/api/context-graph/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    },
    /** Sends the body VERBATIM, so a malformed payload really reaches the route. */
    async subscribeRaw(rawBody: string) {
      const response = await fetch(`http://127.0.0.1:${port}/api/context-graph/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      });
      return { status: response.status, body: (await response.json()) as any };
    },
    async catchupStatus(jobId: string) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/sync/catchup-status?jobId=${encodeURIComponent(jobId)}`,
      );
      return { status: response.status, body: (await response.json()) as any };
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/** Wait until the fake worker has been handed a `run` message. */
async function waitForDispatchedRun(): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    const run = workerControl.state.posted.find((m) => m?.type === 'run');
    if (run) return run.runId as number;
    await sleep(5);
  }
  throw new Error('catch-up run was never dispatched to the worker');
}

const readyProvenance = {
  version: CONTEXT_GRAPH_READINESS_VERSION,
  durableVerified: true,
  sharedMemoryVerified: true,
  updatedAt: Date.now(),
};
const readySubscription = {
  subscribed: true,
  synced: true,
  sharedMemorySynced: true,
  metaSynced: true,
};

let metrics: ReturnType<typeof captureCatchupMetrics>;
const previousRunner = daemonState.catchupRunner;

beforeEach(() => {
  resetCatchupJobLedger();
  daemonState.catchupAcceptingJobs = true;
  metrics = captureCatchupMetrics();
});

afterEach(() => {
  metrics.restore();
  resetCatchupJobLedger();
  daemonState.catchupRunner = previousRunner;
  daemonState.catchupAcceptingJobs = true;
});

describe('I7 — one requests_total point per subscribe-route return', () => {
  it('reaches all seven `result` values, exactly one point per return', async () => {
    // A5. Requests and jobs are N:1 — this test alone produces seven request
    // points and only two job points (one walk, one synthetic).
    daemonState.catchupRunner = createCatchupRunner({} as unknown as DKGAgent);
    const harness = await createHarness({
      subscriptions: {
        'cg-ready': { ...readySubscription },
        'cg-replay': { ...readySubscription },
        'cg-dedupe': { ...readySubscription },
        'cg-closed-ready': { ...readySubscription },
      },
      readiness: {
        'cg-ready': { ...readyProvenance },
        'cg-replay': { ...readyProvenance },
        'cg-dedupe': { ...readyProvenance },
        'cg-closed-ready': { ...readyProvenance },
      },
      allowedAgents: ['0x00000000000000000000000000000000000000ff'],
      isPrivate: true,
    });
    try {
      // bad_request — no contextGraphId at all.
      expect((await harness.subscribe({})).status).toBe(400);
      // forbidden — curated CG, caller not on the allowlist.
      expect((await harness.subscribe({ contextGraphId: 'cg-curated' })).status).toBe(403);
    } finally {
      await harness.close();
    }

    const open = await createHarness({
      subscriptions: {
        'cg-ready': { ...readySubscription },
        'cg-dedupe': { ...readySubscription, synced: false, sharedMemorySynced: false },
      },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      // ready_synthetic — nothing to run, so a terminal job is minted here.
      const synthetic = await open.subscribe({ contextGraphId: 'cg-ready' });
      expect(synthetic.status).toBe(200);
      // ready_replay — same CG again; the job minted above is reused.
      const replay = await open.subscribe({ contextGraphId: 'cg-ready' });
      expect(replay.body.catchup.jobId).toBe(synthetic.body.catchup.jobId);

      // queued — a real walk.
      const queued = await open.subscribe({ contextGraphId: 'cg-dedupe' });
      expect(queued.body.catchup.status).toBe('queued');
      await waitForDispatchedRun();
      // deduped — the walk above is still running.
      const deduped = await open.subscribe({ contextGraphId: 'cg-dedupe' });
      expect(deduped.body.catchup.jobId).toBe(queued.body.catchup.jobId);

      // shutting_down — from the WALK mint guard.
      daemonState.catchupAcceptingJobs = false;
      const closedWalk = await open.subscribe({ contextGraphId: 'cg-brand-new' });
      expect(closedWalk.status).toBe(503);
      expect(closedWalk.body.code).toBe('CATCHUP_SHUTTING_DOWN');

      // All seven, one point per route return, in the order they were made.
      expect(metrics.results()).toEqual([
        'bad_request', 'forbidden',
        'ready_synthetic', 'ready_replay', 'queued', 'deduped', 'shutting_down',
      ]);
      // …and N:1 against jobs: seven request points, one job point (the
      // synthetic mint). Nothing else here created a job identity.
      expect(metrics.jobs()).toHaveLength(1);
      expect(metrics.jobs()[0].attrs).toMatchObject({ status: 'done', admission: 'synthetic' });
      // Every point carries a real `include_shared_memory`, including the two
      // returns that happen before the CG id is even validated.
      for (const point of metrics.requests()) {
        expect(typeof point.attrs.include_shared_memory).toBe('boolean');
      }
    } finally {
      await open.close();
    }
  });

  it('counts an UNPARSEABLE body as `bad_request` instead of returning silently', async () => {
    // The invariant is one I7 point per subscribe-route RETURN. A malformed
    // body used to return 400 through the outer daemon error mapper — a real
    // route return, with no point — so the counter under-reported exactly the
    // requests a client is most likely to retry.
    const harness = await createHarness();
    try {
      const response = await harness.subscribeRaw('{');

      expect(response.status).toBe(400);
      expect(metrics.results()).toEqual(['bad_request']);
      // `include_shared_memory` must still be a real boolean: the point is
      // emitted before anything could have read the field.
      expect(typeof metrics.requests()[0].attrs.include_shared_memory).toBe('boolean');
      expect(metrics.jobs()).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('emits `shutting_down` from the SYNTHETIC mint guard too', async () => {
    // The second mint site. v6 guarded only the walk, so a subscribe to an
    // already-ready CG with no reusable job still created one during shutdown.
    const harness = await createHarness({
      subscriptions: { 'cg-ready': { ...readySubscription } },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      daemonState.catchupAcceptingJobs = false;
      const response = await harness.subscribe({ contextGraphId: 'cg-ready' });
      expect(response.status).toBe(503);
      expect(metrics.results()).toEqual(['shutting_down']);
      // No job was minted, and no I8 point was emitted for one.
      expect(metrics.jobs()).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe('A24 — shutdown closes catch-up admission BEFORE its first await', () => {
  /**
   * Every other test in this file sets `catchupAcceptingJobs` by hand, so all
   * of them observe only what happens once admission is ALREADY closed. That
   * leaves the transition itself unpinned, and two distinct regressions
   * invisible: deleting the write, and sinking it below the first `await`.
   *
   * `beginGracefulShutdown` owns the write and that await together, so
   * suspending inside `removeApiPort` puts the test in the one window where
   * the two orderings differ. In production that window is real filesystem
   * I/O, so it is genuinely reachable by a concurrent request.
   */
  async function subscribeInsideTheEarlyCleanupWindow() {
    const harness = await createHarness({
      subscriptions: { 'cg-ready': { ...readySubscription } },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      let enteredWindow!: () => void;
      const suspended = new Promise<void>((resolve) => { enteredWindow = resolve; });
      let leaveWindow!: () => void;
      const held = new Promise<void>((resolve) => { leaveWindow = resolve; });

      const shutdownStarted = beginGracefulShutdown({
        state: daemonState,
        log: () => {},
        removeApiPort: async () => { enteredWindow(); await held; },
      });

      await suspended; // now inside the FIRST awaited step of shutdown
      const crossing = await harness.subscribe({ contextGraphId: 'cg-ready' });
      leaveWindow();
      await shutdownStarted;
      return crossing;
    } finally {
      await harness.close();
    }
  }

  it('refuses a subscribe issued while the early api.port removal is still suspended', async () => {
    // Precondition: admission is genuinely OPEN going in, so a later refusal is
    // the TRANSITION under test and not the state the test started in.
    expect(daemonState.catchupAcceptingJobs).toBe(true);

    const crossing = await subscribeInsideTheEarlyCleanupWindow();

    expect(crossing.status).toBe(503);
    expect(crossing.body.code).toBe('CATCHUP_SHUTTING_DOWN');
    // Nothing minted: a job created here would be queued against a runner whose
    // worker is about to be terminated.
    expect(metrics.jobs()).toHaveLength(0);
  });

  it('…and that same subscribe SUCCEEDS when no shutdown is in flight', async () => {
    // Positive control. Without it the test above passes on any 503 — an
    // unsubscribable CG, a broken fixture, a route that 503s for its own
    // reasons — and would read as proof the admission guard fired when it
    // never ran at all.
    const harness = await createHarness({
      subscriptions: { 'cg-ready': { ...readySubscription } },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      const response = await harness.subscribe({ contextGraphId: 'cg-ready' });
      expect(response.status).toBe(200);
      expect(metrics.jobs()).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});

describe('A21 — a subscribe crossing shutdown never names a job that does not exist', () => {
  it('generates NO job id at the synthetic mint site once admission is closed', async () => {
    // Kills "move the synthetic guard after the id mint": the 503 body must
    // carry no jobId, and nothing may appear in the tracker — a 200 (or a 503)
    // naming an untracked id would immediately 404 on catchup-status.
    const harness = await createHarness({
      subscriptions: { 'cg-ready': { ...readySubscription } },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      daemonState.catchupAcceptingJobs = false;
      const response = await harness.subscribe({ contextGraphId: 'cg-ready' });

      expect(response.status).toBe(503);
      expect(response.body.catchup).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('jobId');
      expect(harness.catchupTracker.jobs.size).toBe(0);
      expect(harness.catchupTracker.latestByContextGraph.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('leaves NO persisted subscription behind at the walk mint site', async () => {
    // Kills "move the walk guard after subscribeToContextGraph()":
    // that call mutates config, performs four gossipsub subscribes, persists
    // the subscription row and invalidates caches. A 503 after it would leave
    // a gossiping, sync-tracked subscription with no catch-up job.
    const harness = await createHarness();
    try {
      daemonState.catchupAcceptingJobs = false;
      const response = await harness.subscribe({ contextGraphId: 'cg-brand-new' });

      expect(response.status).toBe(503);
      expect(harness.subscribeCalls).toEqual([]);
      expect(harness.subscriptions.has('cg-brand-new')).toBe(false);
      expect(harness.catchupTracker.jobs.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('still REPLAYS an existing completed job while admission is closed', async () => {
    // The guard is on the mint, not the read. Rejecting a replay would be a
    // regression: it returns a job that already exists and creates nothing.
    const harness = await createHarness({
      subscriptions: { 'cg-ready': { ...readySubscription } },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      const first = await harness.subscribe({ contextGraphId: 'cg-ready' });
      const jobId = first.body.catchup.jobId as string;

      daemonState.catchupAcceptingJobs = false;
      const replay = await harness.subscribe({ contextGraphId: 'cg-ready' });

      expect(replay.status).toBe(200);
      expect(replay.body.catchup.jobId).toBe(jobId);
      // A21's second clause: the id a 200 returns must resolve.
      expect((await harness.catchupStatus(jobId)).status).toBe(200);
      expect(metrics.results()).toEqual(['ready_synthetic', 'ready_replay']);
      // The replay minted nothing, so still exactly one job point.
      expect(metrics.jobs()).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('still DEDUPES a running job while admission is closed', async () => {
    daemonState.catchupRunner = createCatchupRunner({} as unknown as DKGAgent);
    const harness = await createHarness({
      subscriptions: { 'cg-running': { subscribed: true } },
    });
    try {
      const queued = await harness.subscribe({ contextGraphId: 'cg-running' });
      await waitForDispatchedRun();

      daemonState.catchupAcceptingJobs = false;
      const deduped = await harness.subscribe({ contextGraphId: 'cg-running' });

      expect(deduped.status).toBe(200);
      expect(deduped.body.catchup.jobId).toBe(queued.body.catchup.jobId);
      expect(metrics.results()).toEqual(['queued', 'deduped']);
    } finally {
      await harness.close();
    }
  });
});

describe('A23/A13 — the grace drain runs while the catch-up worker is alive', () => {
  it('settles an in-flight job NORMALLY when the drain precedes termination', async () => {
    const runner = createCatchupRunner({} as unknown as DKGAgent);
    daemonState.catchupRunner = runner;
    const harness = await createHarness({
      subscriptions: { 'cg-walk': { subscribed: true } },
    });
    try {
      const queued = await harness.subscribe({ contextGraphId: 'cg-walk' });
      const jobId = queued.body.catchup.jobId as string;
      const runId = await waitForDispatchedRun();
      expect(catchupLedgerSize()).toBe(1);

      // Shutdown starts: admission closes, then the drain runs with the worker
      // STILL ALIVE, so the peer round that is already in flight can finish.
      daemonState.catchupAcceptingJobs = false;
      const drain = drainCatchupJobs(5_000);
      workerControl.FakeWorker.emitToRunner({
        type: 'run-result', runId, result: verifiedBothPlanesResult(),
      });
      const outcome = await drain;

      expect(outcome).toEqual({ drained: 1, expired: false });
      expect(harness.catchupTracker.jobs.get(jobId)?.status).toBe('done');
      expect(metrics.jobs()).toHaveLength(1);
      expect(metrics.jobs()[0].attrs).toMatchObject({ status: 'done', admission: 'walk' });
      // I9 is walk-only and monotonic.
      expect(metrics.durations).toHaveLength(1);
      expect(metrics.durations[0].attrs).toEqual({ admission: 'walk' });
      expect(metrics.durations[0].value).toBeGreaterThanOrEqual(0);
    } finally {
      await runner.close();
      await harness.close();
    }
  });

  it('cannot settle it normally once the runner has been closed first', async () => {
    // The discriminator for the test above. `close()` IS `worker.terminate()`
    // and its `exit` handler rejects every pending run, so "terminate, then
    // drain" grants no grace at all — it forces the `failed` path first and
    // the drain merely observes it. Same scenario, only the order changed.
    const runner = createCatchupRunner({} as unknown as DKGAgent);
    daemonState.catchupRunner = runner;
    const harness = await createHarness({
      subscriptions: { 'cg-walk': { subscribed: true } },
    });
    try {
      const queued = await harness.subscribe({ contextGraphId: 'cg-walk' });
      const jobId = queued.body.catchup.jobId as string;
      await waitForDispatchedRun();

      await runner.close(); // the WRONG order
      await drainCatchupJobs(5_000);

      const job = harness.catchupTracker.jobs.get(jobId);
      expect(job?.status).toBe('failed');
      expect(job?.error).toContain('exited');
      expect(metrics.jobs()[0].attrs).toMatchObject({ status: 'failed', admission: 'walk' });
    } finally {
      await harness.close();
    }
  });
});

describe('A4/A20 — exactly one jobs_total point per unique jobId', () => {
  it('records `failed` on drain expiry and stays at ONE point when the task settles late', async () => {
    // The idempotency bit lives on the ledger ENTRY the task closure captured,
    // not on `catchupTracker.jobs` — whose 100-entry prune evicts by oldest
    // `queuedAt` regardless of status — and not on the map slot, which the
    // drain clears. A late `finally` must therefore find it already set.
    const runner = createCatchupRunner({} as unknown as DKGAgent);
    daemonState.catchupRunner = runner;
    const harness = await createHarness({
      subscriptions: { 'cg-hang': { subscribed: true } },
    });
    const logged: string[] = [];
    try {
      const queued = await harness.subscribe({ contextGraphId: 'cg-hang' });
      const jobId = queued.body.catchup.jobId as string;
      const runId = await waitForDispatchedRun();

      // Nothing is delivered, so the drain must hit its bound.
      const outcome = await drainCatchupJobs(50, (m) => logged.push(m));
      expect(outcome).toEqual({ drained: 1, expired: true });
      expect(logged.join('\n')).toContain('did not settle within 50ms');
      expect(metrics.jobs()).toHaveLength(1);
      expect(metrics.jobs()[0].attrs).toMatchObject({ status: 'failed', admission: 'walk' });

      // …and now the abandoned run settles anyway.
      workerControl.FakeWorker.emitToRunner({
        type: 'run-result', runId, result: verifiedBothPlanesResult(),
      });
      await sleep(50);

      expect(harness.catchupTracker.jobs.get(jobId)?.status).toBe('done');
      // The JOB updated; the METRIC did not. Exactly one point for this id.
      expect(metrics.jobs()).toHaveLength(1);
      expect(metrics.durations).toHaveLength(1);
    } finally {
      await runner.close();
      await harness.close();
    }
  });

  it('emits one point per jobId across many jobs, and none for dedupes or replays', async () => {
    const runner = createCatchupRunner({} as unknown as DKGAgent);
    daemonState.catchupRunner = runner;
    const harness = await createHarness({
      subscriptions: {
        'cg-a': { subscribed: true },
        'cg-b': { subscribed: true },
        'cg-ready': { ...readySubscription },
      },
      readiness: { 'cg-ready': { ...readyProvenance } },
    });
    try {
      const a = await harness.subscribe({ contextGraphId: 'cg-a' });
      const b = await harness.subscribe({ contextGraphId: 'cg-b' });
      await harness.subscribe({ contextGraphId: 'cg-a' }); // dedupe — no job
      const ready = await harness.subscribe({ contextGraphId: 'cg-ready' }); // synthetic
      await harness.subscribe({ contextGraphId: 'cg-ready' }); // replay — no job

      const runs = workerControl.state.posted.filter((m) => m?.type === 'run');
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        workerControl.FakeWorker.emitToRunner({
          type: 'run-result', runId: run.runId, result: verifiedBothPlanesResult(),
        });
      }
      await drainCatchupJobs(5_000);

      const ids = new Set([
        a.body.catchup.jobId, b.body.catchup.jobId, ready.body.catchup.jobId,
      ]);
      expect(ids.size).toBe(3);
      // Five requests, three jobs.
      expect(metrics.requests()).toHaveLength(5);
      expect(metrics.jobs()).toHaveLength(3);
      expect(metrics.jobs().filter((p) => p.attrs.admission === 'walk')).toHaveLength(2);
      expect(metrics.jobs().filter((p) => p.attrs.admission === 'synthetic')).toHaveLength(1);
      // I9 is walk-only: the synthetic job contributes no duration sample.
      expect(metrics.durations).toHaveLength(2);
    } finally {
      await runner.close();
      await harness.close();
    }
  });
});

describe('A11 — instrumentation never breaks the route or the drain', () => {
  it('serves the request and settles the job even when every instrument throws', async () => {
    const m = getMetrics();
    const boom = () => {
      throw new Error('meter exploded');
    };
    const throwing = [
      vi.spyOn(m.contextGraphCatchupRequestsTotal, 'add').mockImplementation(boom as any),
      vi.spyOn(m.contextGraphCatchupJobsTotal, 'add').mockImplementation(boom as any),
      vi.spyOn(m.contextGraphCatchupJobDurationMs, 'record').mockImplementation(boom as any),
    ];
    const runner = createCatchupRunner({} as unknown as DKGAgent);
    daemonState.catchupRunner = runner;
    const harness = await createHarness({
      subscriptions: { 'cg-throw': { subscribed: true } },
    });
    try {
      const queued = await harness.subscribe({ contextGraphId: 'cg-throw' });
      expect(queued.status).toBe(200);
      const runId = await waitForDispatchedRun();
      workerControl.FakeWorker.emitToRunner({
        type: 'run-result', runId, result: verifiedBothPlanesResult(),
      });

      await expect(drainCatchupJobs(5_000)).resolves.toEqual({ drained: 1, expired: false });
      expect(harness.catchupTracker.jobs.get(queued.body.catchup.jobId)?.status).toBe('done');
    } finally {
      throwing.forEach((spy) => spy.mockRestore());
      await runner.close();
      await harness.close();
    }
  });
});

/**
 * The full step list, in contract order. Every entry is ONE action: the three
 * background workers are separate steps rather than one composed
 * `stopBackgroundWorkers`, because the sequencer's resilience is per-entry and
 * a composed entry would strand its own tail.
 */
const TEARDOWN_ORDER = [
  'closeServer',
  'drainCatchupJobs',
  'flushTelemetry',
  'stopPublisherRuntime',
  'stopPromoteWorker',
  'closeCatchupRunner',
  'stopAgent',
  'stopTelemetry',
] as const;

type StepName = (typeof TEARDOWN_ORDER)[number];

/** Steps that record their own name; `failing` (if any) also rejects. */
function recordingSteps(failing?: StepName) {
  const ran: StepName[] = [];
  const make = (name: StepName) => async () => {
    ran.push(name);
    if (name === failing) throw new Error(`${name} exploded`);
  };
  const steps = Object.fromEntries(
    TEARDOWN_ORDER.map((name) => [name, make(name)]),
  ) as Record<StepName, () => Promise<void>>;
  return { ran, steps };
}

describe('A24 — producer-quiescent teardown order', () => {
  it('drains and flushes before the workers stop, and shuts telemetry down last', async () => {
    const events: string[] = [];
    let meterLiveAtAgentStop = false;
    const { steps } = recordingSteps();

    await runProducerQuiescentTeardown({
      ...steps,
      closeServer: () => events.push('closeServer'),
      drainCatchupJobs: async () => { await sleep(1); events.push('drainCatchupJobs'); },
      flushTelemetry: async () => { await sleep(1); events.push('flushTelemetry'); },
      stopPublisherRuntime: async () => { events.push('stopPublisherRuntime'); },
      stopPromoteWorker: async () => { events.push('stopPromoteWorker'); },
      closeCatchupRunner: async () => { events.push('closeCatchupRunner'); },
      stopAgent: async () => {
        // Parent-side sync surviving into `agent.stop()` still emits I1–I6.
        // The point of this ordering is that those points reach a LIVE meter.
        events.push('stopAgent');
        meterLiveAtAgentStop = !events.includes('stopTelemetry');
      },
      stopTelemetry: async () => { events.push('stopTelemetry'); },
    });

    expect(events).toEqual([...TEARDOWN_ORDER]);
    expect(meterLiveAtAgentStop).toBe(true);
  });

  it('awaits each step before starting the next', async () => {
    // Ordering by invocation alone would also hold if the steps were kicked
    // off concurrently, which is exactly the shape that made the old
    // flush/shutdown pair race. Each step here asserts the previous one has
    // already RESOLVED.
    const resolved: string[] = [];
    const observed: string[][] = [];
    const step = (name: string) => async () => {
      observed.push([...resolved]);
      await sleep(2);
      resolved.push(name);
    };
    const steps = Object.fromEntries(
      TEARDOWN_ORDER.map((name) => [name, step(name)]),
    ) as Record<StepName, () => Promise<void>>;

    await runProducerQuiescentTeardown(steps);

    expect(observed).toEqual(
      TEARDOWN_ORDER.map((_, i) => TEARDOWN_ORDER.slice(0, i)),
    );
  });
});

describe('A24 — a failing step never strands the steps after it', () => {
  // D11: one case per step, so a step added later is covered by construction
  // rather than by someone remembering to extend a hand-written list.
  it.each(TEARDOWN_ORDER)('continues the whole sequence when %s rejects', async (failing) => {
    const { ran, steps } = recordingSteps(failing);
    const logged: string[] = [];

    const outcome = await runProducerQuiescentTeardown(steps, (m) => logged.push(m));

    // Every step ran, in order, including the ones after the failure.
    expect(ran).toEqual([...TEARDOWN_ORDER]);
    // …and `stopTelemetry` in particular, which is what the 🔴 was about.
    expect(ran).toContain('stopTelemetry');
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].step).toBe(failing);
    expect((outcome.failures[0].error as Error).message).toBe(`${failing} exploded`);
    // Reported, not swallowed — the whole justification for continuing.
    expect(logged.join(' | ')).toContain(failing);
  });

  it('still terminates the catch-up runner when the PUBLISHER stop rejects', async () => {
    // D10. These three used to be sequential awaits inside one composed
    // `stopBackgroundWorkers` step, so the sequencer's per-step guard caught the
    // publisher failure only AFTER it had already skipped the promote worker and
    // the catch-up runner — leaving the runner's worker thread alive. The guard
    // is per-entry, so the entries have to be per-action.
    const { ran, steps } = recordingSteps('stopPublisherRuntime');

    const outcome = await runProducerQuiescentTeardown(steps);

    expect(ran).toContain('stopPromoteWorker');
    expect(ran).toContain('closeCatchupRunner');
    expect(ran).toContain('stopTelemetry');
    expect(outcome.failures.map((f) => f.step)).toEqual(['stopPublisherRuntime']);
  });

  it('never throws, so the caller reaches ITS remaining cleanup', async () => {
    // In `lifecycle.ts` the steps after this call are `managedOxigraph.stop()`
    // and `dashDb.close()`. A throw here would be caught by `cleanup`'s outer
    // `.catch` and skip both.
    const { steps } = recordingSteps('stopAgent');
    await expect(runProducerQuiescentTeardown(steps)).resolves.toBeDefined();
  });

  it('reports EVERY failing step and still runs all of them', async () => {
    const ran: StepName[] = [];
    const steps = Object.fromEntries(
      TEARDOWN_ORDER.map((name) => [name, async () => {
        ran.push(name);
        throw new Error(`${name} exploded`);
      }]),
    ) as Record<StepName, () => Promise<void>>;

    const outcome = await runProducerQuiescentTeardown(steps);

    expect(ran).toEqual([...TEARDOWN_ORDER]);
    expect(outcome.failures.map((f) => f.step)).toEqual([...TEARDOWN_ORDER]);
  });

  it('reports NO failures on a clean teardown', async () => {
    // Without this, "failures is empty" would also hold if the collector were
    // never wired up at all.
    const { steps } = recordingSteps();
    const outcome = await runProducerQuiescentTeardown(steps);
    expect(outcome.failures).toEqual([]);
  });
});

describe('A24 — teardown WIRING: every slot dispatches to the dep it names', () => {
  /** One recording dep per slot, all distinguishable. */
  function recordingDeps() {
    const calls: string[] = [];
    const flushArgs: Array<{ log: (m: string) => void }> = [];
    const drainArgs: Array<[number, (m: string) => void]> = [];
    const log = (message: string) => calls.push(`log:${message}`);
    return {
      calls,
      flushArgs,
      drainArgs,
      log,
      deps: {
        server: { close: () => calls.push('server.close') },
        drainCatchupJobs: async (budgetMs: number, l: (m: string) => void) => {
          drainArgs.push([budgetMs, l]);
          calls.push('drainCatchupJobs');
          return { drained: 0, expired: false };
        },
        flushTelemetry: async (options: { log: (m: string) => void }) => {
          flushArgs.push(options);
          calls.push('flushTelemetry');
        },
        stopPublisherRuntime: async () => {
          calls.push('stopPublisherRuntime');
        },
        stopPromoteWorker: async () => {
          calls.push('stopPromoteWorker');
        },
        closeCatchupRunner: async () => {
          calls.push('closeCatchupRunner');
        },
        stopAgent: async () => {
          calls.push('stopAgent');
        },
        stopTelemetry: async () => {
          calls.push('stopTelemetry');
        },
        log,
      },
    };
  }

  it('routes each step to its own dependency and to no other', async () => {
    // The order test above injects a double for EVERY step, so it proves the
    // sequencer and nothing about the slot assignment — and the shipped defect
    // was a wiring one (`stopTelemetry()` before `agent.stop()`). Invoking one
    // step at a time and asserting exactly which dep fired is what makes the
    // join an assertion instead of an assumption. In particular: the
    // `flushTelemetry` slot must reach the FLUSH and never the shutdown.
    const { calls, deps } = recordingDeps();
    const steps = buildProducerQuiescentTeardownSteps(deps as any);

    const dispatched: Array<[string, string[]]> = [];
    const observe = async (name: string, run: () => void | Promise<void>) => {
      calls.length = 0;
      await run();
      dispatched.push([name, [...calls]]);
    };

    for (const name of TEARDOWN_ORDER) {
      await observe(name, () => steps[name]());
    }

    // Every slot reaches exactly one dep, and it is the one it is named after.
    // No slot fans out: the three background workers are their own steps, so
    // the sequencer's per-step guard covers each of them individually.
    expect(dispatched).toEqual([
      ['closeServer', ['server.close']],
      ['drainCatchupJobs', ['drainCatchupJobs']],
      ['flushTelemetry', ['flushTelemetry']],
      ['stopPublisherRuntime', ['stopPublisherRuntime']],
      ['stopPromoteWorker', ['stopPromoteWorker']],
      ['closeCatchupRunner', ['closeCatchupRunner']],
      ['stopAgent', ['stopAgent']],
      ['stopTelemetry', ['stopTelemetry']],
    ]);
  });

  it('threads the drain budget and the daemon log into the deps that take them', async () => {
    const { deps, drainArgs, flushArgs, log } = recordingDeps();
    const steps = buildProducerQuiescentTeardownSteps(deps as any);

    await steps.drainCatchupJobs();
    await steps.flushTelemetry();

    // A drain with no budget would block shutdown on an unbounded await; a
    // flush with no `log` would swallow its own timeout report.
    expect(drainArgs).toEqual([[CATCHUP_SHUTDOWN_DRAIN_BUDGET_MS, log]]);
    expect(flushArgs).toEqual([{ log }]);
  });
});

// ── D3: the ledger's identity guard on release ─────────────────────────────
//
// `releaseCatchupJob` deletes a slot only when it still holds THAT entry:
//
//   if (ledger.get(entry.job.jobId) === entry) ledger.delete(entry.job.jobId);
//
// Nothing else in the suite constructs two ledger generations for one `jobId`,
// so before this test the guard could be deleted outright with every suite
// still green — the mutation survived the whole matrix.
//
// It is reachable WITHOUT relying on an id collision: `routes/context-graph.ts`
// deliberately reuses an existing `jobId` on the already-ready replay path.
//
// The consequence is a shutdown-correctness one, not a missing metric.
// `drainCatchupJobs` snapshots `[...ledger.values()]` at CALL TIME, so a live
// job evicted by an older generation's cleanup is not merely unreported — it is
// never awaited. The grace drain returns while that work is still running, and
// terminating the worker underneath then rejects it.
describe('W1 D3 — releasing an older ledger generation must not evict a live newer one', () => {
  beforeEach(() => resetCatchupJobLedger());
  afterEach(() => resetCatchupJobLedger());

  it('still AWAITS the newer job after the older generation of the same id is released', async () => {
    const REUSED_ID = 'reused-job-id';
    const jobAt = (jobId: string) => ({
      jobId,
      contextGraphId: 'cg-d3',
      includeWorkspace: false,
      status: 'running' as const,
      queuedAt: 0,
      startedAt: 0,
    });
    const older = beginWalkCatchupJob(jobAt(REUSED_ID));
    const newer = beginWalkCatchupJob(jobAt(REUSED_ID));

    let newerSettled = false;
    newer.task = sleep(40).then(() => { newerSettled = true; });

    // The older generation's cleanup runs — it must not take the newer job's
    // slot with it.
    releaseCatchupJob(older);
    expect(catchupLedgerSize()).toBe(1);

    const { drained, expired } = await drainCatchupJobs(2_000, () => {});

    // The assertion that matters is `newerSettled`: without the identity guard
    // the drain's snapshot is empty, it returns immediately, and this is false
    // while the work is still running.
    expect(newerSettled).toBe(true);
    expect(expired).toBe(false);
    expect(drained).toBe(1);
  });
});
