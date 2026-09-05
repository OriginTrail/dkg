// Hermetic tests for lib/watch.mjs — no SSH, no network, no real fleet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateTrips, quiesce, recordSafetyAbort, safetyAbortGate } from '../lib/watch.mjs';

// ── fixtures ─────────────────────────────────────────────────────────────────

function mkPolicy(over = {}) {
  return {
    trips: {
      memoryPsiSomeAvg10: { default: 0.4, hardMax: 0.6, sustainSec: 60 },
      memoryCurrentVsHighFraction: { default: 0.95, hardMax: 0.98 },
      oomKillDelta: { default: 0, hardMax: 0 },
      coreUnreachableFromBaseline: { default: 1, hardMax: 1 },
      acceptQueueRecvQAtBacklog: { default: true, hardMax: true, consecutiveProbeFailures: 3 },
      diskFreeFloorBytes: { default: 16_106_127_360, hardMax: 10_737_418_240 },
      diskFreeFloorFraction: { default: 0.2, hardMax: 0.1 },
      admissionShedWindowSec: { default: 60, hardMax: 60 },
      admissionShedFractionOfAttempts: { default: 0.5, hardMax: 0.7 },
      rpcExhaustionDeltaPerRun: { default: 100, hardMax: 500 },
      ...over.trips,
    },
    quiesce: { flatCounterConfirmSec: 20, edgeShutdownTimeoutSec: 60, ...over.quiesce },
    safetyAbort: { cooldownMin: 60, ...over.safetyAbort },
  };
}

function mkCore(alias, over = {}) {
  const base = {
    alias,
    reachable: true,
    systemd: { activeState: 'active', execMainStartTs: '2026-07-14T00:00:00Z', nRestarts: 0, mainPid: 100 },
    workerPid: 200,
    build: { commit: 'deadbeef', buildTime: '2026-07-01T00:00:00Z' },
    rss: 1_000_000_000,
    cgroup: { memoryCurrent: 4e9, memoryPeak: 5e9, memoryHigh: 8e9, memoryMax: 8e9, oomKills: 0, psiSomeAvg10: 0.01 },
    listen: { recvQ: 0, backlog: 128, connectProbeOk: true },
    diskFree: { bytes: 60e9, fraction: 0.5 },
    api: { admissionRejected: 0, rpcFailovers: 0, rpcExhaustions: 0 },
  };
  const out = { ...base, ...over };
  for (const k of ['systemd', 'cgroup', 'listen', 'diskFree', 'api']) {
    if (over[k] === null) delete out[k];
    else if (over[k]) out[k] = { ...base[k], ...over[k] };
  }
  return out;
}

const T0 = Date.parse('2026-07-14T12:00:00Z');
const snap = (ms, cores) => ({ ts: ms, kind: 'light', cores });
const healthyPair = () => [mkCore('core-1'), mkCore('core-2')];

function run(overrides = {}) {
  return evaluateTrips({
    policy: mkPolicy(),
    baseline: snap(T0 - 600_000, healthyPair()),
    snapshot: snap(T0, healthyPair()),
    snapshotHistory: [],
    edgeWindow: { attempts: 20, shed: 0, windowSec: 60 },
    ...overrides,
  });
}

// ── evaluateTrips ────────────────────────────────────────────────────────────

test('a healthy fleet fires no trips', () => {
  assert.deepEqual(run(), []);
});

test('coreUnreachableFromBaseline fires for any baseline-reachable core lost', () => {
  const fired = run({ snapshot: snap(T0, [mkCore('core-1'), { alias: 'core-2', reachable: false }]) });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trip, 'coreUnreachableFromBaseline');
  assert.equal(fired[0].alias, 'core-2');
  // hygiene (S6): fired trips carry aliases only
  assert.ok(!JSON.stringify(fired).match(/100\.64|host|sshUser/));
});

test('a core missing from the snapshot entirely counts as unreachable', () => {
  const fired = run({ snapshot: snap(T0, [mkCore('core-1')]) });
  assert.deepEqual(fired.map((f) => [f.trip, f.alias]), [['coreUnreachableFromBaseline', 'core-2']]);
});

test('memoryPsiSomeAvg10 fires only when sustained across the full window', () => {
  const hot = (ms, psi1) => snap(ms, [mkCore('core-1', { cgroup: { psiSomeAvg10: psi1 } }), mkCore('core-2')]);

  // sustained 90s > 60s => fires once, for core-1 only
  const sustained = run({
    snapshotHistory: [hot(T0 - 90_000, 0.5), hot(T0 - 60_000, 0.5), hot(T0 - 30_000, 0.5)],
    snapshot: hot(T0, 0.5),
  });
  assert.equal(sustained.length, 1);
  assert.deepEqual([sustained[0].trip, sustained[0].alias, sustained[0].observed], ['memoryPsiSomeAvg10', 'core-1', 0.5]);

  // exactly sustainSec of exceedance fires (>=)
  const boundary = run({
    snapshotHistory: [hot(T0 - 60_000, 0.5), hot(T0 - 30_000, 0.5)],
    snapshot: hot(T0, 0.5),
  });
  assert.equal(boundary.length, 1);

  // a dip inside the window breaks the sustain chain
  const interrupted = run({
    snapshotHistory: [hot(T0 - 90_000, 0.5), hot(T0 - 60_000, 0.5), hot(T0 - 30_000, 0.1)],
    snapshot: hot(T0, 0.5),
  });
  assert.deepEqual(interrupted, []);

  // exceedance younger than sustainSec does not fire
  const short = run({
    snapshotHistory: [hot(T0 - 30_000, 0.5)],
    snapshot: hot(T0, 0.5),
  });
  assert.deepEqual(short, []);
});

test('memoryCurrentVsHighFraction fires at the fraction, falling back to memory.max', () => {
  const viaHigh = run({
    snapshot: snap(T0, [mkCore('core-1', { cgroup: { memoryCurrent: 7.8e9 } }), mkCore('core-2')]),
  });
  assert.equal(viaHigh.length, 1);
  assert.equal(viaHigh[0].trip, 'memoryCurrentVsHighFraction');
  assert.ok(viaHigh[0].observed >= 0.95);

  const viaMax = run({
    snapshot: snap(T0, [mkCore('core-1', { cgroup: { memoryCurrent: 7.8e9, memoryHigh: undefined } }), mkCore('core-2')]),
  });
  assert.equal(viaMax.length, 1);
  assert.equal(viaMax[0].trip, 'memoryCurrentVsHighFraction');
});

test('oomKillDelta fires on counter growth vs baseline', () => {
  const fired = run({
    snapshot: snap(T0, [mkCore('core-1', { cgroup: { oomKills: 1 } }), mkCore('core-2')]),
  });
  assert.equal(fired.length, 1);
  assert.deepEqual([fired[0].trip, fired[0].alias, fired[0].observed], ['oomKillDelta', 'core-1', 1]);
});

test('acceptQueueRecvQAtBacklog fires on Recv-Q at backlog', () => {
  const fired = run({
    snapshot: snap(T0, [mkCore('core-1', { listen: { recvQ: 128, backlog: 128 } }), mkCore('core-2')]),
  });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trip, 'acceptQueueRecvQAtBacklog');
  assert.match(fired[0].reason, /Recv-Q at backlog/);
});

test('acceptQueueRecvQAtBacklog fires on N consecutive connect-probe failures', () => {
  const probeDown = (ms) => snap(ms, [mkCore('core-1', { listen: { connectProbeOk: false } }), mkCore('core-2')]);

  const fired = run({
    snapshotHistory: [probeDown(T0 - 20_000), probeDown(T0 - 10_000)],
    snapshot: probeDown(T0),
  });
  assert.equal(fired.length, 1);
  assert.match(fired[0].reason, /3 consecutive/);

  // only two consecutive failures: below the policy threshold, no fire
  const twoOnly = run({
    snapshotHistory: [probeDown(T0 - 10_000)],
    snapshot: probeDown(T0),
  });
  assert.deepEqual(twoOnly, []);
});

test('disk floors fire independently on bytes and fraction', () => {
  const bytes = run({
    snapshot: snap(T0, [mkCore('core-1', { diskFree: { bytes: 10e9 } }), mkCore('core-2')]),
  });
  assert.deepEqual(bytes.map((f) => f.trip), ['diskFreeFloorBytes']);

  const fraction = run({
    snapshot: snap(T0, [mkCore('core-1', { diskFree: { fraction: 0.15 } }), mkCore('core-2')]),
  });
  assert.deepEqual(fraction.map((f) => f.trip), ['diskFreeFloorFraction']);
});

test('admission shed fires from the edge-side window', () => {
  const fired = run({ edgeWindow: { attempts: 10, shed: 6, windowSec: 60 } });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trip, 'admissionShedFractionOfAttempts');
  assert.equal(fired[0].observed, 0.6);

  // exactly at threshold does not "exceed"
  assert.deepEqual(run({ edgeWindow: { attempts: 10, shed: 5, windowSec: 60 } }), []);
  // absent edge window (e.g. soak) => only the fleet counter is live
  assert.deepEqual(run({ edgeWindow: undefined }), []);
});

test('admission shed fires from the fleet counter delta when scenario-declared', () => {
  const policy = mkPolicy();
  policy.trips.admissionShedFractionOfAttempts.fleetDeltaPerRun = 50;
  const fired = run({
    policy,
    edgeWindow: undefined,
    snapshot: snap(T0, [
      mkCore('core-1', { api: { admissionRejected: 40 } }),
      mkCore('core-2', { api: { admissionRejected: 30 } }),
    ]),
  });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].trip, 'admissionShedFractionOfAttempts');
  assert.equal(fired[0].observed, 70);
  assert.match(fired[0].reason, /fleet admission-rejection/);
});

test('rpcExhaustionDeltaPerRun fires on the fleet-wide counter delta', () => {
  const fired = run({
    snapshot: snap(T0, [
      mkCore('core-1', { api: { rpcExhaustions: 80 } }),
      mkCore('core-2', { api: { rpcExhaustions: 90 } }),
    ]),
  });
  assert.equal(fired.length, 1);
  assert.deepEqual([fired[0].trip, fired[0].observed, fired[0].threshold], ['rpcExhaustionDeltaPerRun', 170, 100]);
});

test('FAIL-CLOSED: a missing signal on a reachable core fires signal-unavailable', () => {
  const noPsi = run({
    snapshot: snap(T0, [mkCore('core-1', { cgroup: { psiSomeAvg10: undefined } }), mkCore('core-2')]),
  });
  assert.equal(noPsi.length, 1);
  assert.deepEqual(
    [noPsi[0].trip, noPsi[0].alias, noPsi[0].reason],
    ['memoryPsiSomeAvg10', 'core-1', 'signal-unavailable'],
  );

  const noListen = run({
    snapshot: snap(T0, [mkCore('core-1', { listen: null }), mkCore('core-2')]),
  });
  assert.deepEqual(noListen.map((f) => [f.trip, f.reason]), [['acceptQueueRecvQAtBacklog', 'signal-unavailable']]);

  const noRpc = run({
    snapshot: snap(T0, [mkCore('core-1', { api: { rpcExhaustions: undefined } }), mkCore('core-2')]),
  });
  assert.deepEqual(noRpc.map((f) => [f.trip, f.alias, f.reason]), [['rpcExhaustionDeltaPerRun', 'core-1', 'signal-unavailable']]);

  const noDisk = run({
    snapshot: snap(T0, [mkCore('core-1', { diskFree: null }), mkCore('core-2')]),
  });
  assert.deepEqual(new Set(noDisk.map((f) => f.trip)), new Set(['diskFreeFloorBytes', 'diskFreeFloorFraction']));
  assert.ok(noDisk.every((f) => f.reason === 'signal-unavailable'));
});

test('an unreachable core fires only its reachability trip, not a signal storm', () => {
  const fired = run({
    snapshot: snap(T0, [mkCore('core-1'), { alias: 'core-2', reachable: false }]),
  });
  assert.deepEqual(fired.map((f) => f.trip), ['coreUnreachableFromBaseline']);
});

// ── quiesce ──────────────────────────────────────────────────────────────────

function fakeClock() {
  let now = 0;
  return {
    _now: () => now,
    _sleep: async (ms) => { now += ms; },
    _pollIntervalMs: 1000,
  };
}

test('quiesce cancels in-flight handles, stops edges, confirms flat counters', async () => {
  const cancelled = [];
  const stops = [];
  const inflight = [
    { cancel: async () => { cancelled.push(1); } },
    { cancel: async () => { cancelled.push(2); } },
    { cancel: async () => { throw new Error('already gone'); } },
  ];
  const edges = [{ stop: async () => { stops.push('driver'); } }];
  let flatCalls = 0;
  const result = await quiesce({
    inflight,
    edges,
    policy: mkPolicy({ quiesce: { flatCounterConfirmSec: 3 } }),
    confirmFlat: async () => { flatCalls += 1; return true; },
    ...fakeClock(),
  });
  assert.deepEqual(result, { cancelled: 2, edgeShutdown: true, flatConfirmed: true });
  assert.deepEqual(cancelled, [1, 2]);
  assert.deepEqual(stops, ['driver']);
  assert.equal(flatCalls, 4); // t=0,1,2,3s => 3s consecutive flat
});

test('quiesce requires CONSECUTIVE flat readings — a bump resets the window', async () => {
  const readings = [true, false, true, true, true, true];
  let i = 0;
  const result = await quiesce({
    inflight: [],
    edges: [],
    policy: mkPolicy({ quiesce: { flatCounterConfirmSec: 3 } }),
    confirmFlat: async () => readings[Math.min(i++, readings.length - 1)],
    ...fakeClock(),
  });
  assert.equal(result.flatConfirmed, true);
  assert.equal(i, 6); // reset at the false, then 3s consecutive from t=2s
});

test('quiesce times out when counters never go flat; confirmFlat errors fail closed', async () => {
  let calls = 0;
  const result = await quiesce({
    inflight: [],
    edges: [],
    policy: mkPolicy({ quiesce: { flatCounterConfirmSec: 3, flatConfirmTimeoutSec: 5 } }),
    confirmFlat: async () => { calls += 1; throw new Error('counter read failed'); },
    ...fakeClock(),
  });
  assert.equal(result.flatConfirmed, false);
  assert.ok(calls >= 5);
});

test('quiesce reports edgeShutdown:false when an edge has no stop() or stop hangs', async () => {
  const noStop = await quiesce({
    inflight: [],
    edges: [{ stop: async () => {} }, {}],
    policy: mkPolicy({ quiesce: { flatCounterConfirmSec: 1 } }),
    confirmFlat: async () => true,
    ...fakeClock(),
  });
  assert.equal(noStop.edgeShutdown, false);
  assert.equal(noStop.flatConfirmed, true);

  const hung = await quiesce({
    inflight: [],
    edges: [{ stop: () => new Promise(() => {}) }], // never resolves
    policy: mkPolicy({ quiesce: { flatCounterConfirmSec: 1, edgeShutdownTimeoutSec: 0.05 } }),
    confirmFlat: async () => true,
    ...fakeClock(),
  });
  assert.equal(hung.edgeShutdown, false);
});

// ── safety-abort bookkeeping ─────────────────────────────────────────────────

test('recordSafetyAbort blocks new runs until the cooldown passes', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'rfc61-watch-'));
  try {
    const t = Date.parse('2026-07-14T12:00:00Z');
    const record = recordSafetyAbort({
      runsDir,
      runId: 'certify-deadbeef-r1-20260714T120000Z',
      trips: [{ trip: 'oomKillDelta', alias: 'core-1', observed: 1, threshold: 0 }],
      policy: mkPolicy(),
      _now: () => t,
    });
    assert.equal(record.cooldownUntil, new Date(t + 60 * 60_000).toISOString());

    const during = safetyAbortGate({ runsDir, _now: () => t + 30 * 60_000 });
    assert.deepEqual(during, { blocked: true, until: record.cooldownUntil });

    const after = safetyAbortGate({ runsDir, _now: () => t + 61 * 60_000 });
    assert.deepEqual(after, { blocked: false });
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('safetyAbortGate: missing file unblocks; corrupt file fails closed', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'rfc61-watch-'));
  try {
    assert.deepEqual(safetyAbortGate({ runsDir }), { blocked: false });
    assert.deepEqual(safetyAbortGate({ runsDir: join(runsDir, 'does-not-exist') }), { blocked: false });

    // a stale file with a PAST cooldown unblocks (operator clearance not needed)
    writeFileSync(join(runsDir, 'safety-abort.json'), JSON.stringify({
      ts: '2026-01-01T00:00:00Z', runId: 'old', trips: [], cooldownUntil: '2026-01-01T01:00:00Z',
    }));
    assert.deepEqual(safetyAbortGate({ runsDir }), { blocked: false });

    // corrupt JSON or missing cooldownUntil => blocked (fail closed)
    writeFileSync(join(runsDir, 'safety-abort.json'), '{not json');
    assert.deepEqual(safetyAbortGate({ runsDir }), { blocked: true });
    writeFileSync(join(runsDir, 'safety-abort.json'), JSON.stringify({ ts: 'x', runId: 'y', trips: [] }));
    assert.deepEqual(safetyAbortGate({ runsDir }), { blocked: true });
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('recordSafetyAbort creates the runs dir and keeps aliases-only evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'rfc61-watch-'));
  try {
    const runsDir = join(base, 'nested', 'runs');
    const record = recordSafetyAbort({
      runsDir,
      runId: 'r',
      trips: [{ trip: 'coreUnreachableFromBaseline', alias: 'core-2', observed: 1, threshold: 1 }],
      policy: mkPolicy(),
    });
    assert.equal(safetyAbortGate({ runsDir, _now: () => Date.now() }).blocked, true);
    assert.ok(!JSON.stringify(record).match(/100\.64|sshUser|@/));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
