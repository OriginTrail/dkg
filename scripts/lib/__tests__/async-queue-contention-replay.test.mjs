// The share replay of the async queue contention benchmark (OT-RFC-73 P2a) against the built product on an in-memory
// store: the real worker supervisor claims a job from the real queue, the benchmark's agent prepares it and replays the
// 43 store operations, and the fixture's asset metadata is checked while the asset pool is cycled. Uses the real built
// dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadDist } from '../../repro/async-queue-contention/backend.mjs';
import {
  AGENT,
  ASSET_POOL,
  CG_ID,
  DATA_OPS_PER_SHARE,
  WM_POOL,
  assetOf,
  metaGraph,
  replayOps,
  seedMainNamespace,
  wmPoolGraph,
} from '../../repro/async-queue-contention/fixture.mjs';
import { finalizeRequests, groundTruth, validity } from '../../repro/async-queue-contention/verdict.mjs';
import {
  beginEpoch,
  createWorker,
  poissonArrivals,
  readShareJobs,
  reconcileAdmissions,
  startShareProducers,
  trackAdmissionWork,
} from '../../repro/async-queue-contention/workload.mjs';

let deps;
before(async () => {
  deps = await loadDist();
});

async function until(condition, what, ms = 15_000) {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * The benchmark's worker over a seeded Oxigraph store and the real queue. `sources` lists, in order, the replay's
 * store operations (the ones carrying a bench.dp source label). `bindRecovery` can wrap the queue's answer to stand in
 * for a preparation that returns a different job than the one the queue bound. `failOnce` = { source, error() } makes the
 * first store operation with that source label throw (a transient storage rejection), and `queueConfig` is the queue's
 * own configuration (a short retry backoff).
 */
async function rig({ bindRecovery = (job) => job, failOnce, queueConfig } = {}) {
  const inner = new deps.storage.OxigraphStore();
  await seedMainNamespace(inner, deps.core);
  const sources = [];
  let pending = failOnce;
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const source = args.at(-1)?.source;
        if (typeof source === 'string' && source.startsWith('bench.dp.')) {
          sources.push(source);
          if (pending?.source === source) {
            const { error } = pending;
            pending = undefined;
            throw error();
          }
        }
        return value.apply(target, args);
      };
    },
  });
  const real = new deps.pub.TripleStoreAsyncPromoteQueue(store, queueConfig);
  const binds = [];
  const queue = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'bindRecovery')
        return async (...args) => {
          binds.push(args[0]);
          return bindRecovery(await value.apply(target, args));
        };
      return value.bind(target);
    },
  });
  const world = {
    cfg: {},
    t0: null,
    store,
    queue,
    requests: [],
    observerEvents: [],
    readerEvents: [],
    claimMs: [],
    claimLatMs: [],
    completions: [],
  };
  const worker = createWorker(world, deps);
  await beginEpoch(world, () => worker.supervisor.start());
  const enqueue = (n) =>
    queue.enqueue({ contextGraphId: CG_ID, assertionName: `aqc-s${n}`, agentAddress: AGENT, entities: 'all' });
  const stop = async () => {
    worker.freeze();
    await worker.supervisor.stop();
  };
  return { world, worker, sources, binds, enqueue, stop, queue: real };
}

/** The worker side of the run's validity gate, for the counters of a finished rig. */
function workerChecks({ worker }) {
  const counters = worker.supervisor.getCounters();
  const checks = validity({
    lambda: 1,
    measureMs: 1000,
    measured: 1,
    stillInflight: 0,
    admissionsPending: 0,
    reconcileError: null,
    successWithoutJob: 0,
    doubleAdmissions: 0,
    driverCpu: 0,
    idlePublisherErrors: 0,
    worker: {
      agentErrors: worker.stats.agentErrors,
      crashes: worker.log.crashes,
      failedTerminal: counters.failedTerminal,
      succeeded: counters.succeeded,
      attempted: counters.attempted,
      dataOps: worker.stats.dataOps,
    },
    seedFileVerified: true,
  });
  return { counters, checks };
}

test('the real supervisor runs a share from the bound job its preparation returns, with all 43 replay operations', async () => {
  const r = await rig();
  let jobId;
  try {
    jobId = await r.enqueue(0);
    await until(
      () => r.worker.supervisor.getCounters().succeeded > 0 || r.worker.log.crashes > 0 || r.worker.stats.agentErrors > 0,
      'the share to finish',
    );
  } finally {
    await r.stop();
  }
  const { counters, checks } = workerChecks(r);
  const evidence = JSON.stringify([r.worker.stats.firstAgentError, r.worker.log.lines]);
  assert.deepEqual(
    [counters.succeeded, counters.failedTerminal, counters.failedRetrying, counters.attempted],
    [1, 0, 0, 1],
    evidence,
  );
  assert.deepEqual([r.worker.stats.agentErrors, r.worker.log.crashes], [0, 0], evidence);
  assert.equal(r.worker.stats.dataOps, DATA_OPS_PER_SHARE);
  const ops = replayOps(deps.storage.deleteByPatternWithoutCount);
  const table = [...ops.draft, ops.sealPrepare, ops.sealAdmit, ops.policy, ...ops.body, ...ops.tail];
  assert.deepEqual(
    r.sources,
    table.map(([source]) => `bench.dp.${source}`),
    'the 43 operations ran once each, in the measured order',
  );
  assert.equal(r.sources.length, 43);
  assert.deepEqual([checks.workerContractOk, checks.dataPlaneReplayed], [true, true]);

  // the queue's own record: the preparation bound the job before the promote ran under it
  const job = await r.queue.getStatus(jobId);
  assert.deepEqual([job.state, job.formatVersion, job.request.entities], ['succeeded', 4, 'all']);
  assert.equal(job.request.agentAddress, AGENT);
  assert.ok(deps.binding.isPromoteRecoveryBinding(job.request.recoveryBinding));
  assert.equal(job.commitMarker.promoteStarted, true);
  assert.deepEqual([r.world.completions.length, r.world.completions[0].jobId], [1, jobId]);
});

test('a share that bound and then hit a transient storage rejection is retried from its binding and completes', async () => {
  const busy = () => new deps.storage.StoreSchedulerBusyError('queue_full', 'background', 'aqc-test');
  const r = await rig({ failOnce: { source: 'bench.dp.scope', error: busy }, queueConfig: { backoff: () => 1 } });
  let jobId;
  try {
    jobId = await r.enqueue(0);
    await until(
      () =>
        r.worker.supervisor.getCounters().succeeded > 0 ||
        r.worker.supervisor.getCounters().failedTerminal > 0 ||
        r.worker.log.crashes > 0 ||
        r.worker.stats.agentErrors > 0,
      'the share to finish or break',
    );
  } finally {
    await r.stop();
  }
  const { counters, checks } = workerChecks(r);
  const evidence = JSON.stringify([r.worker.stats.firstAgentError, r.worker.log.lines]);
  assert.deepEqual(
    [counters.succeeded, counters.failedTerminal, counters.failedRetrying, counters.attempted],
    [1, 0, 1, 2],
    evidence,
  );
  assert.deepEqual([r.worker.stats.agentErrors, r.worker.log.crashes], [0, 0], evidence);
  assert.deepEqual(r.binds, [jobId], 'the retry kept the binding it had: the queue binds a job once');
  assert.equal(
    r.sources.filter((source) => source === 'bench.dp.draft.lifecycle').length,
    1,
    'the retry did not prepare the share again',
  );
  assert.equal(r.sources.filter((source) => source === 'bench.dp.shareCompleteInsert').length, 1);
  assert.deepEqual([checks.workerContractOk, checks.dataPlaneReplayed, checks.ok], [true, true, true]);
  const job = await r.queue.getStatus(jobId);
  assert.deepEqual([job.state, job.attempt.count], ['succeeded', 2]);
  assert.ok(deps.binding.isPromoteRecoveryBinding(job.request.recoveryBinding));
});

const DROPS = {
  'the recovery binding': (job) => ({ ...job, request: { ...job.request, recoveryBinding: undefined } }),
  'the request': (job) => ({ ...job, request: undefined }),
};
for (const [what, drop] of Object.entries(DROPS)) {
  test(`a preparation that drops ${what} of the bound job is an invalid run, not a completed share`, async () => {
    const r = await rig({ bindRecovery: drop });
    try {
      await r.enqueue(0);
      await until(
        () => r.worker.supervisor.getCounters().succeeded > 0 || r.worker.log.crashes > 0 || r.worker.stats.agentErrors > 0,
        'the broken preparation to be noticed',
      );
    } finally {
      await r.stop();
    }
    const { counters, checks } = workerChecks(r);
    assert.equal(counters.succeeded, 0);
    assert.ok(r.worker.stats.agentErrors + r.worker.log.crashes > 0, 'the worker saw the broken contract');
    assert.equal(checks.workerContractOk, false);
    assert.equal(checks.ok, false);
  });
}

// ---------------------------------------------------------------- reconciliation after the admission deadline
const RUN_TAG = 'aqc';

/**
 * One share arrival through the benchmark's producers into the real queue (admissionTimeoutMs 100) over a store whose
 * job write is held until release() is called: the caller is answered at the admission deadline with an indeterminate
 * verdict while the persistence write is still pending, which then commits after the deadline.
 */
async function lateAdmission() {
  const inner = new deps.storage.OxigraphStore();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'replaceSubject') {
        return async (...args) => {
          if (args.at(-1)?.source === 'publisher.asyncPromote.writeJob') await held;
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  const queue = new deps.pub.TripleStoreAsyncPromoteQueue(store, { admissionTimeoutMs: 100 });
  const tracker = trackAdmissionWork(
    deps.admission.PromoteAdmissionCoordinator.for(store, deps.utils.DEFAULT_PROMOTE_CONTROL_GRAPH_URI),
  );
  // a schedule of exactly one arrival, early in the run
  const seed = Array.from({ length: 500 }, (_, i) => i).find((n) => {
    const arrivals = poissonArrivals(n, 2, 1000);
    return arrivals.length === 1 && arrivals[0] < 200;
  });
  assert.notEqual(seed, undefined);
  const world = {
    cfg: { warmupMs: 0, measureMs: 1000, cooldownMs: 0, lambda: 2, seed, runTag: RUN_TAG },
    t0: performance.now(),
    queue,
    requests: [],
  };
  const producers = startShareProducers(world, async () => ({ ok: true }));
  await until(() => world.requests[0]?.ended !== undefined, 'the caller to be answered at the admission deadline');
  producers.stop();
  assert.equal(await producers.drain(5000), 0, 'the load drained: every caller was answered');
  const [request] = world.requests;
  assert.deepEqual(
    [request.outcome, request.code, request.phase, request.admissionOutcome],
    ['indeterminate', 'PROMOTE_ADMISSION_UNAVAILABLE', 'persist', 'indeterminate'],
  );
  assert.ok(request.jobId, 'the verdict names the job whose write is pending');
  assert.equal(tracker.pending(), 1, 'and that write is still running');
  const readJobs = () => readShareJobs(inner, deps.utils, RUN_TAG);
  return { world, request, tracker, readJobs, release, dispose: () => tracker.dispose() };
}

test('a job whose persistence commits after the admission deadline is reconciled as admitted', async () => {
  const run = await lateAdmission();
  try {
    assert.equal((await run.readJobs()).size, 0, 'read right after the drain, the job is not there yet');
    setTimeout(run.release, 150); // the write lands while reconciliation waits for it
    const reconciled = await reconcileAdmissions({
      tracker: run.tracker,
      issued: true,
      readJobs: run.readJobs,
      settleMs: 5000,
    });
    assert.equal(reconciled.reconcileError, null);
    const jobs = reconciled.jobsByName.get(run.request.key);
    assert.deepEqual([jobs?.length, jobs?.[0].jobId], [1, run.request.jobId]);
    finalizeRequests(run.world.requests);
    const truth = groundTruth(run.world.requests, reconciled.jobsByName);
    assert.deepEqual(
      [truth.nonSuccess, truth.uncertainButAdmitted, truth.notAdmitted, run.request.gtJobId],
      [1, 1, 0, run.request.jobId],
      'the late commit is counted as admitted, not as not admitted',
    );
    assert.deepEqual(
      [reconciled.admissions.works, reconciled.admissions.pendingAtDrain, reconciled.admissions.pending],
      [1, 1, 0],
    );
    assert.ok(reconciled.admissions.settleWaitMs >= 100, `waited ${reconciled.admissions.settleWaitMs} ms`);
  } finally {
    run.release();
    run.dispose();
  }
});

test('a write that does not settle within the bound leaves the reconciliation unresolved and the run invalid', async () => {
  const run = await lateAdmission();
  try {
    const reconciled = await reconcileAdmissions({
      tracker: run.tracker,
      issued: true,
      readJobs: run.readJobs,
      settleMs: 200,
    });
    assert.equal(reconciled.admissions.pending, 1);
    assert.equal(reconciled.jobsByName.size, 0, 'the read it took is the earlier snapshot');
    const checks = validity({
      lambda: 2,
      measureMs: 1000,
      measured: 2,
      stillInflight: 0,
      admissionsPending: reconciled.admissions.pending,
      reconcileError: reconciled.reconcileError,
      successWithoutJob: 0,
      doubleAdmissions: 0,
      driverCpu: 0.1,
      idlePublisherErrors: 0,
      worker: { agentErrors: 0, crashes: 0, failedTerminal: 0, succeeded: 1, attempted: 1, dataOps: DATA_OPS_PER_SHARE },
      seedFileVerified: true,
    });
    assert.deepEqual([checks.admissionsSettled, checks.ok], [false, false]);
    // and the write does land afterwards: counting from that snapshot would have been wrong
    run.release();
    assert.equal(await run.tracker.settle(5000), 0);
    assert.equal((await run.readJobs()).get(run.request.key)?.length, 1);
  } finally {
    run.release();
    run.dispose();
  }
});

// ---------------------------------------------------------------- the fixture's reused assets
const DKG = 'http://dkg.io/ontology/';
/**
 * What one completed share leaves on the asset of its slot in the meta graph, as predicate -> object: the 9-predicate
 * provenance stamp (fixture.mjs PROVENANCE, valued per slot) and the operation intent. The seal evidence read returns
 * all of it plus swmShareComplete, which carries the key of the last share (checked separately: it differs per cycle).
 */
const stampOf = (slot) => ({
  state: `"v0-${slot}"`,
  memoryLayer: `"v1-${slot}"`,
  assertionGraph: `"v2-${slot}"`,
  shareOperationId: `"op-${slot}"`,
  type: `"v4-${slot}"`,
  startedAtTime: `"v5-${slot}"`,
  p7: `"v6-${slot}"`,
  p8: `"v7-${slot}"`,
  p9: `"v8-${slot}"`,
  promoteOperationIntent: '"{\\"v\\":1}"',
});
const STAMP_TRIPLES = Object.keys(stampOf(0)).length + 1; // + swmShareComplete

test('cycling the asset pool keeps the metadata and the seal result of every asset at a fixed size', async () => {
  const store = new deps.storage.OxigraphStore();
  await seedMainNamespace(store, deps.core);
  const ops = replayOps(deps.storage.deleteByPatternWithoutCount);
  const rows = [...ops.draft, ops.sealPrepare, ops.sealAdmit, ops.policy, ...ops.body, ...ops.tail];
  assert.equal(rows.length, DATA_OPS_PER_SHARE);
  const shareOf = (jn) => ({
    jn,
    key: `k${jn}`,
    a: assetOf(jn),
    privG: `${metaGraph()}/private-${jn % 4}`,
    wmG: wmPoolGraph(jn % WM_POOL),
  });
  const assets = Array.from({ length: ASSET_POOL }, (_, i) => assetOf(i));
  let sealQuads;
  const measure = async () => {
    const count = await store.query(
      `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${metaGraph()}> { VALUES ?s { ${assets.map((a) => `<${a}>`).join(' ')} } ?s ?p ?o } }`,
    );
    // the seal evidence read of each asset: the CONSTRUCT the replay issues as sealEvidence.prepare
    const seals = await Promise.all(assets.map((_, i) => ops.sealPrepare[2](store, shareOf(i), {})));
    sealQuads = seals.map((seal) => seal.quads);
    return { metaTriples: Number(/\d+/.exec(count.bindings[0].n)[0]), sealTriples: seals.map((s) => s.quads.length) };
  };
  const cycles = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let i = 0; i < ASSET_POOL; i++)
      for (const [source, , fn] of rows) await fn(store, shareOf(cycle * ASSET_POOL + i), { source: `bench.dp.${source}` });
    cycles.push(await measure());
  }
  for (const c of cycles.slice(1)) assert.deepEqual(c, cycles[0], 'a completed share leaves the asset as it found it');
  // Stable and small is not enough: a seal query that matched nothing (the wrong subject, graph or variable) reads
  // zero triples every cycle. The read must return exactly the stamp the replay wrote on that asset.
  assert.deepEqual(
    cycles[0].sealTriples,
    Array(ASSET_POOL).fill(STAMP_TRIPLES),
    `a seal read returns a share's stamp (${STAMP_TRIPLES} triples), not the history of the asset or nothing`,
  );
  assert.equal(cycles[0].metaTriples, ASSET_POOL * STAMP_TRIPLES, `the metadata of ${ASSET_POOL} assets`);
  for (const [slot, quads] of sealQuads.entries()) {
    const what = `the seal read of ${assets[slot]}: ${JSON.stringify(quads)}`;
    assert.ok(
      quads.every((quad) => quad.subject === assets[slot]),
      what,
    );
    const { swmShareComplete, ...stamp } = Object.fromEntries(
      quads.map((quad) => [quad.predicate.replace(DKG, ''), quad.object]),
    );
    assert.deepEqual(stamp, stampOf(slot), what);
    assert.match(swmShareComplete, /^"k\d+"$/, what);
  }
});
