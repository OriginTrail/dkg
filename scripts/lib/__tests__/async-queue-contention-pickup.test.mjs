// Known answers for the publisher pick-up metrics of the async queue contention benchmark (OT-RFC-73 P2b, decisions D-15
// and D-16). Pure: no backend and no dist.
import assert from 'node:assert/strict';
import test from 'node:test';
import { jobRow, pickupBlock, publishSummary, walletClassifier } from '../../repro/async-queue-contention/pickup.mjs';

const EPOCH = 1_000_000;
const at = (ms) => EPOCH + ms;

test('jobRow turns the publisher timestamps into run-relative times and takes ready as the latest of three', () => {
  const job = {
    jobId: 'j1',
    status: 'finalized',
    request: { knowledgeAssetVmPublish: { name: 'pub-x-1' } },
    timestamps: { acceptedAt: at(500), claimedAt: at(1000), finalizedAt: at(4000), lastRetriedAt: at(800) },
  };
  assert.deepEqual(jobRow(job, EPOCH), {
    jobId: 'j1',
    name: 'pub-x-1',
    status: 'finalized',
    acceptedAt: 500,
    readyAt: 800,
    claimedAt: 1000,
    finalizedAt: 4000,
    failedAt: null,
    reclaimed: true,
  });
  const plain = jobRow({ jobId: 'j2', timestamps: { acceptedAt: at(7), lastRecoveredAt: at(3) } }, EPOCH);
  assert.deepEqual([plain.acceptedAt, plain.readyAt, plain.claimedAt, plain.reclaimed], [7, 7, null, true]);
  const iso = jobRow({ jobId: 'j3', timestamps: { acceptedAt: new Date(at(250)).toISOString() } }, EPOCH);
  assert.equal(iso.acceptedAt, 250, 'an ISO timestamp is read too');
  assert.equal(jobRow({ jobId: 'j4', timestamps: {} }, EPOCH).readyAt, null, 'a job with no acceptance has no ready time');
  assert.equal(jobRow({ jobId: 'j5', timestamps: { acceptedAt: at(1) } }, EPOCH).reclaimed, false);
});

const ev = (t, kind, walletId) => ({ t, ev: kind, walletId });

test('walletClassifier: busy strictly inside a lock, renewals and stray deletes ignored, open locks stay busy', () => {
  const events = [
    ev(100, 'written', 'w0'),
    ev(200, 'written', 'w1'),
    ev(250, 'written', 'w1'), // a renewal of the open lock changes nothing
    ev(300, 'deleted', 'w0'),
    ev(400, 'deleted', 'w0'), // a delete with no open lock changes nothing
    ev(500, 'deleted', 'w1'),
    ev(600, 'written', 'w1'), // never deleted: busy for good
    ev(650, 'written', 'w0'),
    ev(10, 'written', 'stranger'), // not a configured wallet
  ];
  const classify = walletClassifier(events, ['w0', 'w1']);
  assert.equal(classify(-1), 'unknown', 'before the epoch nothing is known');
  assert.equal(classify(50), 'free');
  assert.equal(classify(100), 'free', 'the lock written at the very instant does not count against that instant');
  assert.equal(classify(150), 'free', 'w1 is free');
  assert.equal(classify(200), 'free', 'w0 is busy, w1 only just locked');
  assert.equal(classify(201), 'busy', 'both wallets hold a lock');
  assert.equal(classify(299), 'busy');
  assert.equal(classify(300), 'free', 'w0 released at 300');
  assert.equal(classify(499), 'free', 'w0 is free');
  assert.equal(classify(550), 'free');
  assert.equal(classify(620), 'free', 'w0 is free, w1 is locked again');
  assert.equal(classify(700), 'busy', 'both open locks');
  assert.equal(walletClassifier(events, [])(100), 'unknown', 'no wallet configured');
  assert.equal(walletClassifier([], ['w0'])(100), 'free', 'no lock was ever written');
  assert.equal(walletClassifier([ev(100, 'written', 'w0')], ['w0'])(100), 'free', 'an open lock is busy only after it was written');
  assert.equal(walletClassifier([ev(100, 'written', 'w0')], ['w0'])(101), 'busy');
  assert.equal(walletClassifier(events, ['w0', 'w1'], 120)(110), 'unknown', 'before knownFrom');
  assert.equal(walletClassifier([], ['w0', 'w0', 'w1'])(1), 'free', 'duplicates are one wallet');
});

const row = (jobId, acceptedAt, claimedAt, o = {}) => ({
  jobId,
  name: jobId,
  status: 'finalized',
  acceptedAt,
  readyAt: o.readyAt ?? acceptedAt,
  claimedAt,
  finalizedAt: o.finalizedAt ?? null,
  failedAt: null,
  reclaimed: o.reclaimed ?? false,
});
const WINDOW = { from: 1000, to: 5000 };
// both wallets are locked in [1900, 2600): a job that becomes ready in there has no free worker
const BUSY = [
  ev(1800, 'written', 'w0'),
  ev(1900, 'written', 'w1'),
  ev(2600, 'deleted', 'w0'),
  ev(2700, 'deleted', 'w1'),
];

test('pickupBlock: accepted -> first claim over the window, an unclaimed job right-censored at the run end', () => {
  const rows = [
    row('A', 1500, 1600, { finalizedAt: 4600 }),
    row('B', 2000, 2300, { finalizedAt: 5300 }),
    row('C', 2500, null),
    row('D', 500, 600), // accepted before the window
    row('E', 4999, 5200, { finalizedAt: 8000 }),
    row('F', 5000, 5100), // the window is half open: 5000 is outside
  ];
  const b = pickupBlock({ rows, window: WINDOW, runEnd: 20_000, walletEvents: BUSY, walletIds: ['w0', 'w1'] });
  // waits 100, 300, censored 20000 - 2500 = 17500, and 201
  assert.deepEqual(b.pickup, {
    nAccepted: 4,
    nClaimed: 3,
    nCensored: 1,
    n: 4,
    mean: 4525.25,
    p50: 250.5,
    p95: 14_920,
    p99: 16_984,
    max: 17_500,
    claimedOnly: { n: 3, mean: 200.33, p50: 201, p95: 290.1, p99: 298.02, max: 300 },
  });
  assert.equal(b.unclaimed.unclaimedAtEnd, 1);
  assert.equal(b.unclaimed.max, 1);
  assert.equal(b.unclaimed.last, 1, 'C is still waiting at the end of the window');
  assert.deepEqual(b.claimToFinishMs, { n: 3, mean: 2933.33, p50: 3000, p95: 3000, p99: 3000, max: 3000 });
  assert.equal(b.finalizedInWindow, 1, 'only A finished inside [1000, 5000)');
  assert.deepEqual(b.states, { finalized: 6 });
  assert.equal(b.reclaimed, 0);
});

test('pickupBlock: the worker-free split keeps the jobs that became ready while a wallet was free', () => {
  const rows = [
    row('A', 1500, 1600), // ready with both wallets free: qualifies, 100
    row('B', 2000, 2300), // ready while both are locked
    row('C', 2500, null), // ready while both are locked, never claimed
    row('E', 4999, 5200), // free again: qualifies, 201
  ];
  const b = pickupBlock({ rows, window: WINDOW, runEnd: 20_000, walletEvents: BUSY, walletIds: ['w0', 'w1'] });
  assert.deepEqual(b.workerFree, {
    traceLive: true,
    nQualifying: 2,
    nBusy: 2,
    nUnknown: 0,
    nClaimed: 2,
    nCensored: 0,
    n: 2,
    mean: 150.5,
    p50: 150.5,
    p95: 195.95,
    p99: 199.99,
    max: 201,
  });
  assert.equal(b.pickup.n, 4, 'the plain pick-up still counts every accepted job');
});

test('pickupBlock: a retried job is timed from when it became ready, and counted as reclaimed', () => {
  const rows = [row('A', 1500, 3000, { readyAt: 2800, reclaimed: true })];
  const b = pickupBlock({ rows, window: WINDOW, runEnd: 9000, walletEvents: [ev(2900, 'written', 'w0')], walletIds: ['w0'] });
  assert.equal(b.pickup.p50, 1500, 'D-15 counts from acceptance');
  assert.equal(b.workerFree.p50, 200, 'D-16 counts from ready');
  assert.equal(b.reclaimed, 1);
});

test('pickupBlock: a trace that saw no lock although jobs were claimed is dead, so nothing is called worker-free', () => {
  const rows = [row('A', 1500, 1600), row('B', 2000, 2300)];
  const dead = pickupBlock({ rows, window: WINDOW, runEnd: 9000, walletEvents: [], walletIds: ['w0', 'w1'] });
  assert.deepEqual(
    [dead.workerFree.traceLive, dead.workerFree.nQualifying, dead.workerFree.nUnknown, dead.workerFree.n],
    [false, 0, 2, 0],
  );
  assert.equal(dead.pickup.n, 2, 'the plain pick-up does not depend on the trace');
  // no job was claimed either: an empty trace is then just an idle publisher
  const idle = pickupBlock({ rows: [row('A', 1500, null)], window: WINDOW, runEnd: 9000, walletEvents: [], walletIds: ['w0'] });
  assert.deepEqual([idle.workerFree.traceLive, idle.workerFree.nQualifying, idle.workerFree.nCensored], [true, 1, 1]);
  const none = pickupBlock({ rows: [], window: WINDOW, runEnd: 9000, walletEvents: [], walletIds: ['w0'] });
  assert.deepEqual([none.pickup.n, none.pickup.nAccepted, none.pickup.p50], [0, 0, undefined]);
  assert.deepEqual([none.states, none.unclaimed.unclaimedAtEnd, none.unclaimed.max], [{}, 0, 0]);
});

test('publishSummary adds the ground truth, the finished counts, the rate and the evidence of the run', () => {
  const rows = [row('A', 1500, 1600, { finalizedAt: 4600 }), row('B', 2000, 2300)];
  const s = publishSummary({
    admission: { n: 7, F: 0.1 },
    groundTruth: { doubleAdmissions: 0 },
    rows,
    window: { from: 0, to: 120_000 },
    runEnd: 130_000,
    walletEvents: [ev(1600, 'written', 'w0'), ev(1700, 'written', 'w0'), ev(4600, 'deleted', 'w0')],
    walletIds: ['w0'],
    scheduledArrivals: 9,
    reconcileError: null,
    handler: { executions: 1 },
    runner: { errors: 0 },
    config: { wallets: 1, mu: 0.4 },
  });
  assert.deepEqual(
    [s.n, s.F, s.jobsFound, s.scheduledArrivals, s.claimed, s.finalized, s.finalizedInWindow, s.completionsPerMin],
    [7, 0.1, 2, 9, 2, 1, 1, 0.5],
  );
  assert.deepEqual(s.walletEvents, { written: 2, deleted: 1 });
  assert.deepEqual([s.handler, s.runner, s.config, s.groundTruth], [{ executions: 1 }, { errors: 0 }, { wallets: 1, mu: 0.4 }, { doubleAdmissions: 0 }]);
  assert.equal(s.pickup.nAccepted, 2);
  assert.equal(s.workerFree.traceLive, true);
});
