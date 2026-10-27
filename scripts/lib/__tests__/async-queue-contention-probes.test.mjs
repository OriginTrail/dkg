// The background load of the async queue contention benchmark (OT-RFC-73 P2b): the health-lane status probes through the
// product's own functions and the synthetic storage-ACK stream, against the built product on an in-memory store. Uses the
// real built dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadDist } from '../../repro/async-queue-contention/backend.mjs';
import { CG_ID, DATA_OPS_PER_SHARE } from '../../repro/async-queue-contention/fixture.mjs';
import {
  ACK_OPS_PER_ACK,
  ACK_SOURCES,
  COUNT_SOURCE,
  LOAD_DEFAULTS,
  NO_ANSWER_MS,
  PROBE_DRAIN_MS,
  PROBE_RECONCILE_SOURCE,
  STATUS_SOURCE,
  ackOnce,
  backgroundLoadEvidence,
  fixedSchedule,
  loadEvidence,
  makeMetricsQuery,
  probeAckSummary,
  startAckLoad,
  startProbeLoad,
  withTrackedCount,
  withTrackedQueries,
} from '../../repro/async-queue-contention/probes.mjs';
import { validity } from '../../repro/async-queue-contention/verdict.mjs';
import { beginEpoch } from '../../repro/async-queue-contention/workload.mjs';

let deps;
before(async () => {
  deps = await loadDist();
});

test('fixedSchedule lists phase + k * period below the horizon, and nothing for a switched-off period', () => {
  assert.deepEqual(fixedSchedule(10_000, 5000, 40_000), [5000, 15_000, 25_000, 35_000]);
  assert.deepEqual(fixedSchedule(60_000, 20_000, 20_000), []);
  assert.deepEqual(fixedSchedule(0, 5000, 40_000), []);
  assert.deepEqual(fixedSchedule(-1, 0, 40_000), []);
  // G0b's cadences over the 220 s of a default run
  const n = (period, phase) => fixedSchedule(period, phase, 220_000).length;
  assert.deepEqual(
    [
      n(LOAD_DEFAULTS.statusMs, LOAD_DEFAULTS.statusPhaseMs),
      n(LOAD_DEFAULTS.metricsMs, LOAD_DEFAULTS.metricsPhaseMs),
      n(LOAD_DEFAULTS.countMs, LOAD_DEFAULTS.countPhaseMs),
      n(LOAD_DEFAULTS.ackMs, LOAD_DEFAULTS.ackPhaseMs),
    ],
    [22, 7, 4, 55],
  );
});

test('the metrics query answers the reconcile locally and maps a boolean result to the agent shape', async () => {
  const counters = { reconcilesStubbed: 0, queries: 0 };
  const seen = [];
  const store = {
    query: async (sparql, options) => (seen.push([sparql, options]), { type: 'boolean', value: true }),
  };
  const query = makeMetricsQuery(store, counters);
  const stub = await query('SELECT ...', { source: PROBE_RECONCILE_SOURCE });
  assert.equal(stub.bindings[0].totalTriples, '"0"');
  assert.deepEqual([counters.reconcilesStubbed, counters.queries, seen.length], [1, 0, 0], 'never sent to the store');
  assert.deepEqual(
    await query('ASK {}', {
      source: 'daemon.metrics.storeHealth',
      priority: 'health',
    }),
    {
      bindings: [{ result: 'true' }],
    },
  );
  assert.deepEqual(seen, [['ASK {}', { source: 'daemon.metrics.storeHealth', priority: 'health' }]]);
  store.query = async () => ({ bindings: [{ a: 1 }] });
  assert.deepEqual(await query('SELECT *'), { bindings: [{ a: 1 }] });
  store.query = async () => ({});
  assert.deepEqual(await query('SELECT *'), { bindings: [] });
  assert.equal(counters.queries, 3);
});

/** A store that records every call and can make one fail. */
function recordingStore({ failAt } = {}) {
  const calls = [];
  const note =
    (kind) =>
    async (...args) => {
      const options = args.at(-1);
      calls.push({ kind, options, args });
      if (calls.length === failAt)
        throw Object.assign(new Error('rejected'), {
          code: 'STORE_SCHEDULER_BUSY',
        });
      return undefined;
    };
  return {
    calls,
    store: {
      query: note('query'),
      replaceGraph: note('replaceGraph'),
      insert: note('insert'),
      update: note('update'),
    },
    deleteByPattern: async (_store, spec, options) =>
      void calls.push({ kind: 'deleteByPattern', options, args: [spec] }),
  };
}

test('one ACK is the 8 operations of a graph-scoped persist, each on the ack lane with the product source label', async () => {
  const r = recordingStore();
  const timed = [];
  await ackOnce(r.store, r.deleteByPattern, 5, 32, (source, ms, ok) => timed.push([source, ms >= 0, ok]));
  assert.equal(ACK_OPS_PER_ACK, 8);
  assert.deepEqual(
    r.calls.map((c) => c.kind),
    ['query', 'replaceGraph', 'deleteByPattern', 'deleteByPattern', 'insert', 'deleteByPattern', 'insert', 'update'],
  );
  assert.deepEqual(
    r.calls.map((c) => c.options.source),
    [...ACK_SOURCES],
  );
  assert.ok(r.calls.every((c) => c.options.priority === 'ack'));
  assert.deepEqual(
    timed,
    ACK_SOURCES.map((s) => [s, true, true]),
  );
  assert.equal(r.calls[1].args[1].length, 32, 'the payload size');
  assert.equal(r.calls[4].args[0].length, 16, 'the operation meta');
  assert.equal(r.calls[6].args[0].length, 5, 'the workspace head');
  assert.deepEqual(r.calls[7].options.touchedGraphs, ['urn:dkg:node:storage-ack-ledger']);
  // the slot pool is 16 wide: ACK 5 and 21 write the same graph, ACK 6 another
  const graphOf = async (k) => (await ackOnce(r.store, r.deleteByPattern, k, 1), r.calls.at(-7).args[0]);
  assert.equal(await graphOf(5), await graphOf(21));
  assert.notEqual(await graphOf(5), await graphOf(6));
});

test('an ACK operation that the scheduler rejects stops the ACK and is timed as failed', async () => {
  const r = recordingStore({ failAt: 2 });
  const timed = [];
  await assert.rejects(
    ackOnce(r.store, r.deleteByPattern, 0, 4, (source, ms, ok) => timed.push([source, ok])),
    /rejected/,
  );
  assert.deepEqual(timed, [
    [ACK_SOURCES[0], true],
    [ACK_SOURCES[1], false],
  ]);
  assert.equal(r.calls.length, 2, 'no operation after the rejected one');
});

/** A started epoch over an in-memory store seeded with the fixture graphs the probes read. */
async function epochOn(store) {
  const world = { store, t0: null, epoch0: 0 };
  await beginEpoch(world, async () => {});
  return world;
}

test('the probe load issues the daemon health-lane calls through the product functions on the schedules given', async () => {
  const store = new deps.storage.OxigraphStore();
  const world = await epochOn(store);
  const load = await startProbeLoad(world, deps, {
    statusMs: 40,
    metricsMs: 70,
    countMs: 120,
    statusPhaseMs: 10,
    metricsPhaseMs: 20,
    countPhaseMs: 30,
    horizonMs: 400,
  });
  assert.deepEqual(load.state.schedule.status.slice(0, 3), [10, 50, 90]);
  assert.equal(
    load.state.counters.reconcilesStubbed,
    1,
    'the one reconcile the metrics probe needs is answered locally',
  );
  await sleep(330);
  load.stop();
  assert.equal(await load.drain(2000), 0);
  const kinds = (k) => load.state.events.filter((e) => e.kind === k);
  assert.ok(kinds('status').length >= 5, `${kinds('status').length} status probes`);
  assert.ok(kinds('metrics').length >= 3);
  assert.ok(kinds('count-request').length >= 2);
  assert.ok(kinds('status').every((e) => e.result === 'reachable' && e.ms >= 0 && e.t >= 0));
  assert.ok(kinds('metrics').every((e) => e.result === 'ok'));
  const times = load.state.events.map((e) => e.t);
  assert.ok(
    times.every((t) => t >= 9),
    'no event before its phase',
  );
  const summary = probeAckSummary({ probeState: load.state, from: 0, to: 1e9 });
  assert.equal(summary.probes.noAnswer, 0);
  assert.equal(summary.probes.nStatus, kinds('status').length);
  assert.equal(summary.probes.metricsUnfinished, 0, 'every metrics probe finished inside the drain');
  assert.ok(load.state.events.every((e) => !e.unfinished));
});

test('a probe cadence of 0 switches that probe off', async () => {
  const world = await epochOn(new deps.storage.OxigraphStore());
  const load = await startProbeLoad(world, deps, {
    statusMs: 30,
    metricsMs: 0,
    countMs: 0,
    statusPhaseMs: 5,
    horizonMs: 200,
  });
  await sleep(120);
  load.stop();
  await load.drain(2000);
  assert.deepEqual([...new Set(load.state.events.map((e) => e.kind))], ['status']);
});

/** A store that answers every query at once, except that the first `rejections` health-lane ones are rejected. */
function storeRejectingHealth(rejections = Infinity) {
  const seen = { health: 0 };
  return {
    seen,
    store: {
      query: async (_sparql, options) => {
        if (options?.source === 'daemon.metrics.storeHealth' && seen.health++ < rejections)
          throw Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY' });
        return { type: 'boolean', value: true };
      },
    },
  };
}

/** A metrics-only probe load (every 25 ms) over `store`, run for `ms` and drained; returns the metrics events. */
async function metricsEventsOf(store, ms) {
  const world = await epochOn(store);
  const load = await startProbeLoad(world, deps, {
    statusMs: 0,
    metricsMs: 25,
    metricsPhaseMs: 5,
    countMs: 0,
    horizonMs: 5000,
  });
  await sleep(ms);
  load.stop();
  await load.drain(2000);
  return load.state;
}

test('a store that keeps rejecting the health query yields no successful metrics sample', async () => {
  const state = await metricsEventsOf(storeRejectingHealth().store, 300);
  const results = state.events.map((e) => e.result);
  assert.ok(results.length >= 6, `${results.length} metrics probes`);
  // a failed health query drops the product's snapshot, so the next read reconciles (answered locally): busy, local,
  // busy, local, ... and never an answer of the store
  assert.deepEqual(
    results,
    results.map((_, i) => (i % 2 === 0 ? 'busy' : 'reconciled')),
  );
  assert.equal(results.includes('ok'), false, 'no synthetic successful sample');
  const summary = probeAckSummary({ probeState: state, from: 0, to: 1e9 });
  const busy = results.filter((r) => r === 'busy').length;
  assert.deepEqual(
    [summary.probes.nMetrics, summary.probes.nMetricsReconciled, summary.probes.noAnswerMetrics],
    [results.length, results.length - busy, busy],
  );
  assert.deepEqual(summary.probes.metricsResults, { busy, reconciled: results.length - busy });
  assert.equal(summary.probes.metricsLatencyMs.n, busy, 'the local answers are in no latency');
});

test('a metrics sample is the store\'s answer once it queried the store, whatever came before', async () => {
  const { store, seen } = storeRejectingHealth(1);
  const state = await metricsEventsOf(store, 300);
  const results = state.events.map((e) => e.result);
  assert.ok(results.length >= 5);
  assert.deepEqual(
    results.slice(0, 3),
    ['busy', 'reconciled', 'ok'],
    'rejected, then the local reconcile, then a real answer',
  );
  assert.ok(results.slice(2).every((r) => r === 'ok'));
  assert.equal(seen.health, results.length - 1, 'every sample but the local one asked the store');
  const summary = probeAckSummary({ probeState: state, from: 0, to: 1e9 });
  assert.equal(summary.probes.nMetricsReconciled, 1);
  assert.equal(summary.probes.metricsLatencyMs.n, results.length - 1);
});

/**
 * A store that answers everything at once, except the health-lane ASKs from number `from` on (0-based; the reconcile of
 * the first read is answered locally and is none of them), which answer when the test says so.
 */
function storeWithGatedHealth(from = 0) {
  const gate = { health: 0 };
  const answered = new Promise((resolve) => {
    gate.release = () => resolve({ type: 'boolean', value: true });
  });
  gate.store = {
    query: async (_sparql, options) => {
      if (options?.source === 'daemon.metrics.storeHealth' && gate.health++ >= from) return answered;
      return { type: 'boolean', value: true };
    },
  };
  return gate;
}

/**
 * A metrics-only probe load over `gate`'s store: two samples (5 ms and 65 ms after the epoch). Returns, stopped, once
 * both have asked the store: with storeWithGatedHealth(1) the second is then blocked in its health query.
 */
async function startTwoSampleMetricsLoad(gate) {
  const world = await epochOn(gate.store);
  const load = await startProbeLoad(world, deps, {
    statusMs: 0,
    metricsMs: 60,
    metricsPhaseMs: 5,
    countMs: 0,
    horizonMs: 100,
  });
  for (let i = 0; i < 400 && gate.health < 2; i++) await sleep(5);
  assert.equal(gate.health, 2, 'both samples asked the store');
  load.stop();
  return { world, load };
}

test('a metrics query still running when the drain gives up is in the results, censored at the drain, and recorded once', async () => {
  const gate = storeWithGatedHealth(1);
  const { world, load } = await startTwoSampleMetricsLoad(gate);
  const left = await load.drain(100);
  const cutAt = performance.now() - world.t0;
  assert.equal(left, 1, 'the drain reports the work it left running');
  const { events } = load.state;
  assert.deepEqual(
    events.map((e) => [e.kind, e.result, Boolean(e.unfinished)]),
    [
      ['metrics', 'ok', false],
      ['metrics', 'unfinished', true],
    ],
    'the answered sample and the unfinished one, which is no longer missing',
  );
  const stuck = events[1];
  assert.equal(stuck.err, 'UNFINISHED_AT_DRAIN');
  assert.ok(stuck.ms >= 100, `it ran at least as long as the drain waited (${Math.round(stuck.ms)} ms)`);
  assert.ok(Math.abs(stuck.t + stuck.ms - cutAt) < 15, 'its duration is censored at the moment the drain gave up');

  const s = probeAckSummary({ probeState: load.state, from: 0, to: 1e9 });
  assert.deepEqual(
    [s.probes.nMetrics, s.probes.metricsUnfinished, s.probes.noAnswerMetrics, s.probes.metricsLatencyMs.n],
    [2, 1, 1, 2],
    'counted, unfinished, a no-answer, and in the latency',
  );
  assert.ok(s.probes.metricsLatencyMs.max >= 100, 'and it is the slowest');
  assert.ok(s.probes.latencyMs.max >= 100);
  assert.deepEqual(s.probes.metricsResults, { ok: 1, unfinished: 1 });

  // the store answering after the cut-off is not recorded a second time
  gate.release();
  await sleep(60);
  assert.equal(load.state.events.length, 2, 'no second event for the same probe');
  assert.deepEqual(
    load.state.events.map((e) => e.result),
    ['ok', 'unfinished'],
  );
  assert.equal(probeAckSummary({ probeState: load.state, from: 0, to: 1e9 }).probes.metricsUnfinished, 1);
  assert.equal(await load.drain(100), 0, 'nothing is left running now');
  assert.equal(load.state.events.length, 2, 'and a second drain records nothing either');
});

test('a metrics query that settles inside the drain is recorded as it answered, not as unfinished', async () => {
  const gate = storeWithGatedHealth(1);
  const { load } = await startTwoSampleMetricsLoad(gate);
  const drained = load.drain(10_000);
  await sleep(50);
  gate.release();
  assert.equal(await drained, 0);
  assert.deepEqual(
    load.state.events.map((e) => [e.result, Boolean(e.unfinished)]),
    [
      ['ok', false],
      ['ok', false],
    ],
  );
  const s = probeAckSummary({ probeState: load.state, from: 0, to: 1e9 });
  assert.deepEqual([s.probes.nMetrics, s.probes.metricsUnfinished], [2, 0]);
});

test('a drain that gives up on a metrics probe makes the run fail the probesFinished check', async () => {
  const run = async (gate, drainMs) => {
    const { load } = await startTwoSampleMetricsLoad(gate);
    await load.drain(drainMs);
    const pa = probeAckSummary({ probeState: load.state, from: 0, to: 1e9 });
    return validity({
      lambda: 1,
      measureMs: 1000,
      measured: 1,
      stillInflight: 0,
      load: loadEvidence({ probes: true, ack: false }, pa),
    });
  };
  const stuck = await run(storeWithGatedHealth(1), 60);
  assert.equal(stuck.probesFinished, false, 'the censored probe reaches the check through the summary and loadEvidence');
  const fine = await run(storeWithGatedHealth(Infinity), 60);
  assert.equal(fine.probesFinished, true);
});

test('loadEvidence hands validity the switches and the counts of the run, the unfinished ones included', () => {
  const pa = {
    probes: { nStatus: 18, nMetrics: 6, metricsUnfinished: 2 },
    ack: { acksStarted: 45, acksUnfinished: 1 },
  };
  const factors = { probes: true, ack: false, statusMs: 10_000, metricsMs: 30_000, ackMs: null };
  assert.deepEqual(loadEvidence(factors, pa), {
    probes: true,
    ack: false,
    statusMs: 10_000,
    metricsMs: 30_000,
    ackMs: null,
    statusProbes: 18,
    metricsProbes: 6,
    probesUnfinished: 2,
    acksStarted: 45,
    acksUnfinished: 1,
  });
});

test('a --probes run with the status cadence at 0 passes the probe checks on the metrics probes alone, end to end', async () => {
  const gate = storeWithGatedHealth(Infinity);
  const { load } = await startTwoSampleMetricsLoad(gate);
  await load.drain(60);
  const pa = probeAckSummary({ probeState: load.state, from: 0, to: 1e9 });
  const check = (factors) =>
    validity({
      lambda: 1,
      measureMs: 1000,
      measured: 1,
      stillInflight: 0,
      load: loadEvidence(factors, pa),
    });
  // the load above runs metrics probes only (startTwoSampleMetricsLoad leaves the status cadence at 0)
  assert.deepEqual([pa.probes.nStatus, pa.probes.nMetrics > 0], [0, true]);
  const off = check({ probes: true, ack: false, statusMs: 0, metricsMs: 100 });
  assert.deepEqual([off.probesRan, off.probesFinished, off.statusProbesOff], [true, true, true]);
  // the same samples are not enough for a run that asked for status probes too
  assert.equal(check({ probes: true, ack: false, statusMs: 10_000, metricsMs: 100 }).probesRan, false);
});

/** A store that answers everything at once except the full-store COUNT, which settles when the test says so. */
function storeWithGatedCount() {
  const gate = { calls: 0 };
  const counted = new Promise((resolve, reject) => {
    gate.release = () => resolve({ type: 'bindings', bindings: [{ c: '"7"' }] });
    gate.fail = () => reject(Object.assign(new Error('store closed'), { code: 'STORE_CLOSED' }));
  });
  gate.store = {
    query: async (_sparql, options) => {
      if (options?.source !== COUNT_SOURCE) return { type: 'boolean', value: true };
      gate.calls++;
      return counted;
    },
  };
  return gate;
}

/** The one COUNT request of a probe load that only counts (the schedule has a single entry), once it has started. */
async function startCountOnlyLoad(gate) {
  const world = await epochOn(gate.store);
  const load = await startProbeLoad(world, deps, {
    statusMs: 0,
    metricsMs: 0,
    countMs: 1000,
    countPhaseMs: 5,
    horizonMs: 100,
  });
  for (let i = 0; i < 200 && gate.calls === 0; i++) await sleep(5);
  assert.equal(gate.calls, 1, 'the COUNT reached the store');
  load.stop();
  return load;
}

test('drain waits for the background COUNT the product started, and returns once it has settled', async () => {
  const gate = storeWithGatedCount();
  const load = await startCountOnlyLoad(gate);
  let settled = null;
  const drained = load.drain(10_000).then((left) => (settled = left));
  await sleep(150);
  assert.equal(settled, null, 'the COUNT is still reading the store, so the drain is still waiting');
  gate.release();
  assert.equal(await drained, 0, 'nothing is left running once the COUNT settled');
  assert.deepEqual(
    load.state.events.map((e) => e.kind),
    ['count-request'],
  );
});

test('drain waits for a COUNT that fails too, and gives up on one that never settles at its cap', async () => {
  const failing = storeWithGatedCount();
  const failed = await startCountOnlyLoad(failing);
  let settled = null;
  const drained = failed.drain(10_000).then((left) => (settled = left));
  await sleep(100);
  assert.equal(settled, null);
  failing.fail();
  assert.equal(await drained, 0, 'a rejected COUNT settles the drain as well, without an unhandled rejection');

  const stuck = storeWithGatedCount();
  const load = await startCountOnlyLoad(stuck);
  const t0 = performance.now();
  assert.equal(await load.drain(120), 1, 'the COUNT is reported as still running');
  const waited = performance.now() - t0;
  assert.ok(waited >= 100 && waited < 2000, `the wait is bounded by the cap (${Math.round(waited)} ms)`);
  stuck.release(); // so the product's in-flight marker does not outlive the test
  await sleep(10);
  assert.ok(PROBE_DRAIN_MS > NO_ANSWER_MS, 'the run waits longer than a status probe can take');
});

/** A store that answers everything at once except the status probe's ASK, which answers when the test says so. */
function storeWithGatedStatus() {
  const gate = { calls: 0 };
  const answered = new Promise((resolve) => {
    gate.release = () => resolve({ type: 'boolean', value: true });
  });
  gate.store = {
    query: async (_sparql, options) => {
      if (options?.source !== STATUS_SOURCE) return { type: 'boolean', value: true };
      gate.calls++;
      return answered;
    },
  };
  return gate;
}

/**
 * The one status probe of a status-only load, once its caller has given up and the ASK it started is still running. The
 * product's own probeExternalStore runs, with its 5 s caller wait shortened to 50 ms (a store that takes 25 s to answer
 * is the same case: the caller reports 'no-answer' at its wait and the ASK keeps running).
 */
async function startAbandonedStatusLoad(gate) {
  const world = await epochOn(gate.store);
  const shortWait = {
    ...deps,
    probeReach: { probeExternalStore: (agent) => deps.probeReach.probeExternalStore(agent, 50) },
  };
  const load = await startProbeLoad(world, shortWait, {
    statusMs: 1000,
    statusPhaseMs: 5,
    metricsMs: 0,
    countMs: 0,
    horizonMs: 100,
  });
  for (let i = 0; i < 200 && load.state.events.length === 0; i++) await sleep(5);
  assert.deepEqual(
    load.state.events.map((e) => e.result),
    ['no-answer'],
    'the caller gave up',
  );
  assert.equal(gate.calls, 1, 'the ASK reached the store and has not answered');
  load.stop();
  return load;
}

test('drain does not report the probes as finished while the ASK of a status probe nobody waits for runs', async () => {
  const gate = storeWithGatedStatus();
  const load = await startAbandonedStatusLoad(gate);
  const t0 = performance.now();
  assert.equal(await load.drain(150), 1, 'the status ASK is reported as still running at the cap');
  const waited = performance.now() - t0;
  assert.ok(waited >= 120 && waited < 2000, `the wait is bounded by the cap (${Math.round(waited)} ms)`);
  assert.deepEqual(
    load.state.events.map((e) => [e.kind, e.result]),
    [['status', 'no-answer']],
    'the status probe was answered (no-answer) by its caller: only a metrics probe still running is censored',
  );
  assert.equal(probeAckSummary({ probeState: load.state, from: 0, to: 1e9 }).probes.metricsUnfinished, 0);
  gate.release();
  await sleep(10);
  assert.equal(await load.drain(150), 0, 'nothing is left running once the ASK answered');
});

test('drain waits for the ASK of a status probe that outlived its caller, and returns once it answered', async () => {
  const gate = storeWithGatedStatus();
  const load = await startAbandonedStatusLoad(gate);
  let settled = null;
  const drained = load.drain(10_000).then((left) => (settled = left));
  await sleep(150);
  assert.equal(settled, null, 'the caller gave up long ago, the store query has not: the drain is still waiting');
  gate.release();
  assert.equal(await drained, 0);
});

// ---------------------------------------------------------------- the run's evidence of a store query left running
/** A run whose every check but the background load's holds: a status ASK or COUNT left running must not be what fails it. */
const SOUND_RUN = {
  lambda: 1,
  measureMs: 1000,
  measured: 1,
  stillInflight: 0,
  admissionsPending: 0,
  reconcileError: null,
  successWithoutJob: 0,
  doubleAdmissions: 0,
  driverCpu: 0.1,
  idlePublisherErrors: 0,
  worker: { agentErrors: 0, crashes: 0, failedTerminal: 0, succeeded: 1, attempted: 1, dataOps: DATA_OPS_PER_SHARE },
  seedFileVerified: true,
};

/**
 * The runner's path from a drained probe load to the verdict's checks: the drain's count, the evidence the runner builds
 * from the load and that count (backgroundLoadEvidence: the summary's probe block and validity's `load`), and validity
 * over it.
 */
async function runEvidence(load, drainMs, loadFactors) {
  const stillInflightAtDrain = await load.drain(drainMs);
  const evidence = backgroundLoadEvidence({
    loadFactors,
    probeState: load.state,
    from: 0,
    to: 1e9,
    stillInflightAtDrain,
  });
  return { drained: stillInflightAtDrain, evidence, checks: validity({ ...SOUND_RUN, load: evidence.load }) };
}
const STATUS_ONLY = { probes: true, ack: false, statusMs: 1000, metricsMs: 0, ackMs: null };
const COUNT_ONLY = { probes: true, ack: false, statusMs: 0, metricsMs: 0, ackMs: null };

test('a status ASK left running at the drain reaches the summary as unfinished work; its caller answered, so the run stays valid', async () => {
  const stuck = storeWithGatedStatus();
  const left = await runEvidence(await startAbandonedStatusLoad(stuck), 150, STATUS_ONLY);
  assert.equal(left.drained, 1);
  const { probes } = left.evidence;
  assert.equal(probes.stillInflightAtDrain, 1, 'the count survives into the summary');
  // the caller's answer is in the results: nothing is missing or censored, so the metrics checks have nothing to fail on
  assert.deepEqual(
    [probes.nStatus, probes.noAnswerStatus, probes.noAnswer, probes.metricsUnfinished],
    [1, 1, 1, 0],
    'the status probe is in the results as the no-answer its caller reported',
  );
  assert.deepEqual(
    [left.evidence.load.statusProbes, left.evidence.load.probesUnfinished],
    [1, 0],
    "validity's evidence has the probe",
  );
  assert.deepEqual(
    [left.checks.probesRan, left.checks.probesFinished, left.checks.ok],
    [true, true, true],
    'a status ASK still running is reported, not a failed check',
  );
  stuck.release();
  await sleep(10);

  // control: the same load whose ASK answered before the drain reports nothing left running
  const answered = storeWithGatedStatus();
  const load = await startAbandonedStatusLoad(answered);
  answered.release();
  await sleep(10);
  const done = await runEvidence(load, 150, STATUS_ONLY);
  assert.deepEqual([done.drained, done.evidence.probes.stillInflightAtDrain], [0, 0]);
  assert.deepEqual(
    [done.evidence.probes.nStatus, done.evidence.probes.noAnswerStatus],
    [1, 1],
    'the caller still gave up',
  );
  assert.deepEqual([done.checks.probesRan, done.checks.probesFinished, done.checks.ok], [true, true, true]);
});

test('a COUNT left running at the drain reaches the summary as unfinished work; nothing it measures is censored, so the run stays valid', async () => {
  const stuck = storeWithGatedCount();
  const left = await runEvidence(await startCountOnlyLoad(stuck), 120, COUNT_ONLY);
  assert.equal(left.drained, 1);
  assert.equal(left.evidence.probes.stillInflightAtDrain, 1, 'the count survives into the summary');
  assert.deepEqual(
    [left.evidence.probes.nCountRequests, left.evidence.probes.metricsUnfinished],
    [1, 0],
    'the COUNT request is an event of the run; no probe sample is censored',
  );
  assert.deepEqual([left.checks.probesRan, left.checks.probesFinished, left.checks.ok], [true, true, true]);
  stuck.release();
  await sleep(10);

  // control: a COUNT that settled before the drain reports nothing left running
  const settled = storeWithGatedCount();
  const load = await startCountOnlyLoad(settled);
  settled.release();
  await sleep(10);
  const done = await runEvidence(load, 120, COUNT_ONLY);
  assert.deepEqual([done.drained, done.evidence.probes.stillInflightAtDrain], [0, 0]);
  assert.equal(done.evidence.probes.nCountRequests, 1);
  assert.deepEqual([done.checks.probesRan, done.checks.probesFinished, done.checks.ok], [true, true, true]);
});

test('the evidence of a run is built only with the drain count, and carries the load evidence only for a load that was switched on', () => {
  const state = { events: [{ kind: 'status', t: 5, ms: 20, result: 'ok' }], counters: {}, schedule: {} };
  const build = (o) => backgroundLoadEvidence({ probeState: state, from: 0, to: 1e9, stillInflightAtDrain: 2, ...o });
  assert.equal(build({ loadFactors: STATUS_ONLY }).probes.stillInflightAtDrain, 2);
  for (const missing of [undefined, null, '1', -1, 0.5])
    assert.throws(() => build({ loadFactors: STATUS_ONLY, stillInflightAtDrain: missing }), /needs the drain's count/);
  const off = build({ loadFactors: { probes: false, ack: false } });
  assert.equal(off.load, null, 'no load switched on, no load evidence for validity');
  assert.deepEqual(
    build({ loadFactors: STATUS_ONLY }).load,
    loadEvidence(STATUS_ONLY, probeAckSummary({ probeState: state, from: 0, to: 1e9 })),
  );
});

test('withTrackedQueries hands the queries of the named sources to the tracker, and withTrackedCount only the COUNT', async () => {
  const target = { query: async () => ({ type: 'boolean', value: true }) };
  const tracked = [];
  const view = withTrackedQueries(target, [STATUS_SOURCE, COUNT_SOURCE], (p) => tracked.push(p));
  await view.query('ASK {}', { source: STATUS_SOURCE });
  await view.query('SELECT 1', { source: COUNT_SOURCE });
  await view.query('ASK {}', { source: 'daemon.metrics.storeHealth' });
  assert.equal(tracked.length, 2, 'the status ASK and the COUNT, not the health query');
  const countOnly = [];
  const countView = withTrackedCount(target, (p) => countOnly.push(p));
  await countView.query('ASK {}', { source: STATUS_SOURCE });
  assert.equal(countOnly.length, 0, 'the COUNT view leaves the status ASK alone');
});

test('withTrackedCount hands only the COUNT query to the tracker and leaves every call as it was', async () => {
  const calls = [];
  const target = {
    name: 'store',
    query: async function (sparql, options) {
      calls.push([this === target, sparql, options]);
      return { type: 'boolean', value: true };
    },
    size() {
      return this.name.length;
    },
  };
  const tracked = [];
  const view = withTrackedCount(target, (p) => tracked.push(p));
  await view.query('ASK {}', { priority: 'health', source: 'daemon.status.storeProbe' });
  assert.equal(tracked.length, 0, 'a query of another source is not tracked');
  await view.query('SELECT 1');
  assert.equal(tracked.length, 0, 'nor one without options');
  const options = { priority: 'health', source: COUNT_SOURCE };
  const result = view.query('SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }', options);
  assert.equal(tracked.length, 1);
  assert.deepEqual(await result, { type: 'boolean', value: true }, "the caller still gets the store's own answer");
  assert.equal(await tracked[0], await result);
  assert.deepEqual(
    calls.map(([own, , o]) => [own, o]),
    [
      [true, { priority: 'health', source: 'daemon.status.storeProbe' }],
      [true, undefined],
      [true, options],
    ],
    'the store sees the same options on the same instance',
  );
  assert.equal(view.name, 'store');
  assert.equal(view.size(), 5, 'other members keep their own this');
});

test('the ACK load runs the ACKs one at a time on its schedule and records each operation', async () => {
  const store = new deps.storage.OxigraphStore();
  const world = await epochOn(store);
  const load = startAckLoad(world, deps.storage, {
    intervalMs: 40,
    phaseMs: 10,
    payload: 6,
    horizonMs: 300,
  });
  await sleep(250);
  load.stop();
  assert.equal(await load.drain(2000), 0, 'every ACK finished, so none is left unfinished');
  const { events, opEvents } = load.state;
  assert.ok(events.length >= 4, `${events.length} ACKs`);
  assert.ok(events.every((e) => !e.unfinished));
  assert.equal(probeAckSummary({ ackState: load.state, from: 0, to: 1e9 }).ack.acksUnfinished, 0);
  assert.ok(events.every((e, i) => e.k === i && e.ok && e.lateMs > -5));
  assert.equal(opEvents.length, events.length * 8);
  assert.ok(opEvents.every((o) => o.ok && ACK_SOURCES.includes(o.source)));
  // the ledger graph holds the signed ACKs: the operations really ran
  const rows = await store.query(
    'SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:dkg:node:storage-ack-ledger> { ?s ?p ?o } }',
  );
  assert.equal(Number(/\d+/.exec(rows.bindings[0].n)[0]), events.length * 2);
  const swm = await store.query(
    `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <did:dkg:context-graph:${CG_ID}/_shared_memory/ack-0> { ?s ?p ?o } }`,
  );
  assert.equal(Number(/\d+/.exec(swm.bindings[0].n)[0]), 6, 'replaceGraph overwrites, so the store does not grow');
});

test('an ACK stream whose store rejects records the failures and keeps going', async () => {
  const world = await epochOn({
    query: async () => {
      throw Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY' });
    },
  });
  const load = startAckLoad(world, deps.storage, {
    intervalMs: 30,
    phaseMs: 5,
    payload: 1,
    horizonMs: 200,
  });
  await sleep(120);
  load.stop();
  await load.drain(2000);
  assert.ok(load.state.events.length >= 3);
  assert.ok(load.state.events.every((e) => !e.ok && e.err === 'STORE_SCHEDULER_BUSY'));
  assert.ok(
    load.state.opEvents.every((o) => !o.ok && o.source === ACK_SOURCES[0]),
    'the first operation fails and ends the ACK',
  );
});

test('every ACK operation is handed its own start, after the previous one finished', async () => {
  const r = recordingStore();
  const timed = [];
  const before = performance.now();
  await ackOnce(r.store, r.deleteByPattern, 0, 2, (source, ms, ok, startedAt) =>
    timed.push({ source, ms, ok, startedAt }),
  );
  assert.equal(timed.length, ACK_OPS_PER_ACK);
  assert.ok(timed[0].startedAt >= before);
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    assert.ok(timed[i].startedAt >= prev.startedAt + prev.ms - 0.001, `operation ${i} starts after operation ${i - 1}`);
  }
});

/** A store whose every operation takes `ms`: an ACK on it lasts 8 x ms, and its operations start ms apart. */
function slowStore(ms) {
  const slow = async () => sleep(ms);
  return { query: slow, replaceGraph: slow, insert: slow, update: slow };
}

test('an ACK that began before the window has the operations that began inside it counted by their own start', async () => {
  const world = await epochOn(slowStore(25));
  const load = startAckLoad(world, { deleteByPatternWithoutCount: async () => sleep(25) }, {
    intervalMs: 5000,
    phaseMs: 10,
    payload: 1,
    horizonMs: 100,
  });
  await load.drain(5000);
  const { events, opEvents } = load.state;
  assert.equal(events.length, 1, 'one ACK');
  assert.equal(opEvents.length, ACK_OPS_PER_ACK);
  for (let i = 1; i < opEvents.length; i++) {
    const gap = opEvents[i].t - opEvents[i - 1].t;
    assert.ok(gap >= 20, `operation ${i} started ${gap} ms after the previous one`);
  }
  assert.ok(events[0].ms >= 7 * 25, 'the ACK lasts as long as its operations');
  // the window opens between the first operation's start and the second's: the ACK, which started with its first
  // operation, began before it; the other 7 operations began inside it
  const from = (opEvents[0].t + opEvents[1].t) / 2;
  const s = probeAckSummary({ ackState: load.state, from, to: from + 60_000 });
  assert.equal(s.ack.acksStarted, 0, 'the ACK started before the window');
  assert.equal(s.ack.ops, ACK_OPS_PER_ACK - 1);
  assert.equal(s.ack.opMs.n, ACK_OPS_PER_ACK - 1);
  assert.deepEqual(s.ack.bySource, Object.fromEntries(ACK_SOURCES.slice(1).map((src) => [src, 1])));
  // and the window that closes after the second operation began has exactly the first two
  const upto = probeAckSummary({ ackState: load.state, from: 0, to: (opEvents[1].t + opEvents[2].t) / 2 });
  assert.equal(upto.ack.ops, 2);
  assert.equal(upto.ack.acksStarted, 1);
});

test('ackOnce tells its caller which operation is about to run, before it is issued', async () => {
  const r = recordingStore();
  const starts = [];
  await ackOnce(
    r.store,
    r.deleteByPattern,
    0,
    1,
    () => {},
    (source, startedAt) => starts.push([source, r.calls.length, startedAt > 0]),
  );
  assert.deepEqual(
    starts,
    ACK_SOURCES.map((source, i) => [source, i, true]),
    'operation i is announced when i operations have been issued',
  );
});

/**
 * A store on which every ACK operation answers within 3 ms, except the deleteByPattern call numbered `blockedCall`
 * (0-based, three per ACK), which answers when the test says so.
 */
function ackStoreBlockingAt(blockedCall) {
  const gate = { deletes: 0 };
  const answered = new Promise((resolve) => {
    gate.release = resolve;
  });
  const fast = async () => sleep(3);
  gate.store = { query: fast, replaceGraph: fast, insert: fast, update: fast };
  gate.deleteByPatternWithoutCount = async () => {
    if (gate.deletes++ === blockedCall) await answered;
    else await sleep(3);
  };
  return gate;
}

/** Two ACKs, the first of which finishes; the second is blocked in its third operation, past the drain. */
async function runWithOneBlockedAck(gate, drainMs) {
  const world = await epochOn(gate.store);
  const load = startAckLoad(world, gate, {
    intervalMs: 40,
    phaseMs: 10,
    payload: 1,
    horizonMs: 300,
  });
  for (let i = 0; i < 400 && gate.deletes < 4; i++) await sleep(5);
  assert.equal(gate.deletes, 4, 'ACK 1 is blocked in its operation 2 (witnessInvalidate)');
  load.stop();
  const left = await load.drain(drainMs);
  return { world, load, left, cutAt: performance.now() - world.t0 };
}

test('an ACK still running when the drain gives up is in the results, censored at the drain, with its operation', async () => {
  const gate = ackStoreBlockingAt(3);
  const { load, left, cutAt } = await runWithOneBlockedAck(gate, 100);
  assert.equal(left, 1, 'the drain reports the ACK it left running');
  const { events, opEvents } = load.state;
  assert.deepEqual(
    events.map((e) => [e.k, e.ok, Boolean(e.unfinished)]),
    [
      [0, true, false],
      [1, false, true],
    ],
    'the finished ACK and the unfinished one, which is no longer missing',
  );
  const stuck = events[1];
  assert.equal(stuck.err, 'UNFINISHED_AT_DRAIN');
  assert.ok(stuck.ms >= 100, `it lasted at least the drain (${Math.round(stuck.ms)} ms)`);
  assert.ok(Math.abs(stuck.t + stuck.ms - cutAt) < 15, 'its duration is censored at the moment the drain gave up');
  assert.deepEqual(
    opEvents.filter((o) => o.k === 1).map((o) => [o.source, o.ok, Boolean(o.unfinished)]),
    [
      [ACK_SOURCES[0], true, false],
      [ACK_SOURCES[1], true, false],
      [ACK_SOURCES[2], false, true],
    ],
    'the operation it was in is censored too',
  );
  assert.ok(opEvents.at(-1).ms >= 100);

  const s = probeAckSummary({ ackState: load.state, from: 0, to: 1e9 });
  assert.deepEqual(
    [s.ack.acksStarted, s.ack.acksUnfinished, s.ack.acksFailed],
    [2, 1, 0],
    'started and unfinished, not failed',
  );
  assert.equal(s.ack.ackMs.n, 2, 'the unfinished ACK is in the ACK statistics');
  assert.ok(s.ack.ackMs.max >= 100, 'and it is the slowest');
  assert.deepEqual([s.ack.ops, s.ack.opsUnfinished, s.ack.opsFailed], [8 + 3, 1, 0]);
  assert.ok(s.ack.opMs.max >= 100, 'the operation it was in is the slowest');
  assert.equal(s.ack.bySource[ACK_SOURCES[2]], 2, 'one finished and one censored witnessInvalidate');

  // the blocked work finishing after the cut-off is not recorded a second time
  gate.release();
  await sleep(60);
  assert.deepEqual([load.state.events.length, load.state.opEvents.length], [2, 11]);
  assert.equal(probeAckSummary({ ackState: load.state, from: 0, to: 1e9 }).ack.acksUnfinished, 1);
});

test('an unfinished ACK is counted run-wide even when it began before the window, its operation by its own start', async () => {
  const { load } = await runWithOneBlockedAck(ackStoreBlockingAt(3), 50);
  const [, stuck] = load.state.events;
  const stuckOp = load.state.opEvents.at(-1);
  // a window that opens 1 ms before the blocked operation began and closes after the drain: the ACK began before it
  const from = stuckOp.t - 1;
  assert.ok(from > stuck.t, 'the ACK began before the window opened');
  const s = probeAckSummary({ ackState: load.state, from, to: 1e9 });
  assert.deepEqual([s.ack.acksStarted, s.ack.acksUnfinished], [0, 1], 'unfinished is a fact about the run');
  assert.deepEqual([s.ack.ops, s.ack.opsUnfinished], [1, 1], 'the censored operation began inside the window');
});

test('probeAckSummary counts the window only and calls a slow or rejected probe a no-answer', () => {
  const probeState = {
    counters: { reconcilesStubbed: 1 },
    events: [
      { kind: 'status', t: 100, ms: 10, result: 'reachable' },
      { kind: 'status', t: 200, ms: 20, result: 'reachable' },
      { kind: 'status', t: 300, ms: 5000, result: 'no-answer' },
      { kind: 'metrics', t: 400, ms: NO_ANSWER_MS + 1, result: 'ok' },
      { kind: 'metrics', t: 500, ms: 50, result: 'busy' },
      { kind: 'metrics', t: 600, ms: 30, result: 'ok' },
      { kind: 'count-request', t: 700, ms: 1, result: 'refreshing' },
      { kind: 'status', t: 2000, ms: 99_999, result: 'no-answer' }, // after the window
    ],
  };
  const ackState = {
    events: [
      { k: 0, t: 100, lateMs: 3, ms: 40, ok: true },
      { k: 1, t: 200, lateMs: -1, ms: 60, ok: false },
      { k: 2, t: 5000, lateMs: 0, ms: 1, ok: true },
    ],
    opEvents: [
      { k: 0, source: 'a', t: 100, ms: 4, ok: true },
      { k: 0, source: 'b', t: 100, ms: 8, ok: true },
      { k: 1, source: 'a', t: 200, ms: 12, ok: false },
      { k: 2, source: 'a', t: 5000, ms: 99, ok: true },
    ],
  };
  const s = probeAckSummary({ probeState, ackState, from: 0, to: 1000 });
  assert.deepEqual(
    [s.probes.on, s.probes.n, s.probes.nStatus, s.probes.nMetrics, s.probes.nCountRequests],
    [true, 6, 3, 3, 1],
  );
  assert.deepEqual([s.probes.noAnswerStatus, s.probes.noAnswerMetrics, s.probes.noAnswer], [1, 2, 3]);
  assert.deepEqual(s.probes.latencyMs, {
    n: 6,
    mean: 1685.17,
    p50: 40,
    p95: 5000.75,
    p99: 5000.95,
    max: 5001,
  });
  assert.deepEqual(s.probes.statusResults, { reachable: 2, 'no-answer': 1 });
  assert.deepEqual(s.probes.metricsResults, { ok: 2, busy: 1 });
  assert.equal(s.probes.reconcilesStubbed, 1);
  assert.deepEqual([s.ack.on, s.ack.acksStarted, s.ack.acksFailed, s.ack.ops, s.ack.opsFailed], [true, 2, 1, 3, 1]);
  assert.deepEqual(s.ack.ackMs, {
    n: 2,
    mean: 50,
    p50: 50,
    p95: 59,
    p99: 59.8,
    max: 60,
  });
  assert.deepEqual(s.ack.startLatenessMs, {
    n: 2,
    mean: 1.5,
    p50: 1.5,
    p95: 2.85,
    p99: 2.97,
    max: 3,
  });
  assert.deepEqual(s.ack.opMs, {
    n: 3,
    mean: 8,
    p50: 8,
    p95: 11.6,
    p99: 11.92,
    max: 12,
  });
  assert.deepEqual(s.ack.bySource, { a: 2, b: 1 });
  const off = probeAckSummary({ from: 0, to: 1000 });
  assert.deepEqual(
    [off.probes.on, off.probes.n, off.probes.noAnswer, off.ack.on, off.ack.ops],
    [false, 0, 0, false, 0],
  );
  assert.deepEqual(off.probes.latencyMs, { n: 0 });
});

test('probeAckSummary counts an unfinished metrics probe as a no-answer and in the latency, and run-wide as unfinished', () => {
  const probeState = {
    events: [
      { kind: 'metrics', t: 100, ms: 30, result: 'ok' },
      // censored at the drain after 200 ms (a lower bound well under the 5 s wait): it still got no answer
      { kind: 'metrics', t: 300, ms: 200, result: 'unfinished', err: 'UNFINISHED_AT_DRAIN', unfinished: true },
      // began after the window: not in its counts, but the run has it unfinished all the same
      { kind: 'metrics', t: 5000, ms: 40_000, result: 'unfinished', err: 'UNFINISHED_AT_DRAIN', unfinished: true },
    ],
  };
  const s = probeAckSummary({ probeState, from: 0, to: 1000 });
  assert.deepEqual([s.probes.n, s.probes.nMetrics, s.probes.nMetricsReconciled], [2, 2, 0]);
  assert.deepEqual([s.probes.noAnswerMetrics, s.probes.noAnswer], [1, 1]);
  assert.deepEqual(s.probes.metricsResults, { ok: 1, unfinished: 1 });
  assert.equal(s.probes.metricsLatencyMs.n, 2);
  assert.equal(s.probes.metricsLatencyMs.max, 200, 'the censored duration is in the latency, as a lower bound');
  assert.equal(s.probes.metricsUnfinished, 2, 'unfinished is a fact about the run, whatever window it began in');
  assert.equal(probeAckSummary({ from: 0, to: 1000 }).probes.metricsUnfinished, 0, 'no probe load, none unfinished');
});

test('probeAckSummary keeps a locally answered metrics sample out of the latencies and the no-answers', () => {
  const probeState = {
    events: [
      { kind: 'status', t: 100, ms: 10, result: 'reachable' },
      { kind: 'metrics', t: 200, ms: 30, result: 'ok' },
      { kind: 'metrics', t: 300, ms: 50, result: 'busy' },
      { kind: 'metrics', t: 400, ms: 0.2, result: 'reconciled' },
      { kind: 'metrics', t: 500, ms: 0.1, result: 'reconciled' },
    ],
  };
  const s = probeAckSummary({ probeState, from: 0, to: 1000 });
  assert.deepEqual(
    [s.probes.n, s.probes.nStatus, s.probes.nMetrics, s.probes.nMetricsReconciled],
    [5, 1, 4, 2],
    'they started in the window, so the probes ran',
  );
  assert.deepEqual([s.probes.noAnswerMetrics, s.probes.noAnswer], [1, 1]);
  assert.deepEqual(s.probes.metricsResults, { ok: 1, busy: 1, reconciled: 2 });
  assert.equal(s.probes.metricsLatencyMs.n, 2);
  assert.equal(s.probes.metricsLatencyMs.max, 50);
  assert.equal(s.probes.latencyMs.n, 3, 'the status probe and the two metrics probes the store answered');
});
