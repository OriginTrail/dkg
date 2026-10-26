// The background load of the async queue contention benchmark (OT-RFC-73 P2b): the health-lane status probes through the
// product's own functions and the synthetic storage-ACK stream, against the built product on an in-memory store. Uses the
// real built dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadDist } from '../../repro/async-queue-contention/backend.mjs';
import { CG_ID } from '../../repro/async-queue-contention/fixture.mjs';
import {
  ACK_OPS_PER_ACK,
  ACK_SOURCES,
  COUNT_SOURCE,
  LOAD_DEFAULTS,
  NO_ANSWER_MS,
  PROBE_DRAIN_MS,
  PROBE_RECONCILE_SOURCE,
  ackOnce,
  fixedSchedule,
  makeMetricsQuery,
  probeAckSummary,
  startAckLoad,
  startProbeLoad,
  withTrackedCount,
} from '../../repro/async-queue-contention/probes.mjs';
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
  await load.drain(2000);
  const { events, opEvents } = load.state;
  assert.ok(events.length >= 4, `${events.length} ACKs`);
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
