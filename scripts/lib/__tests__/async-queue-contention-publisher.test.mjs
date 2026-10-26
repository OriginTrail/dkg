// The publisher stream of the async queue contention benchmark (OT-RFC-73 P2b) against the built product on an in-memory
// store: the real publisher and runner claim, execute (with the synthetic handler) and finish the jobs the benchmark
// submits, the wallet-lock trace sees the writes and deletes, and the pick-up metrics read them back. Uses the real
// built dist: run pnpm run build:packages first.
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadDist } from '../../repro/async-queue-contention/backend.mjs';
import { AGENT, CG_ID, LIFT_TAIL_OPS, seedMainNamespace } from '../../repro/async-queue-contention/fixture.mjs';
import { jobRow, pickupBlock, walletClassifier } from '../../repro/async-queue-contention/pickup.mjs';
import {
  LIFT_DEFAULTS,
  LIFT_OBSERVER_CALLS,
  createLiftHandler,
  createLiftSide,
  createPublishPreflight,
  installWalletTrace,
  makeVmRequest,
  publishArrivals,
  readLiftJobs,
  startPublishProducers,
  walletIdsOf,
} from '../../repro/async-queue-contention/publisher.mjs';
import { finalizeRequests } from '../../repro/async-queue-contention/verdict.mjs';
import { beginEpoch, mulberry32, poissonArrivals } from '../../repro/async-queue-contention/workload.mjs';

let deps;
before(async () => {
  deps = await loadDist();
});

async function until(condition, what, ms = 15_000) {
  const end = performance.now() + ms;
  while (!(await condition())) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test('the publisher arrival schedule is the harness one: seed * 31 + 7, the same exponential recurrence', () => {
  const cfg = { seed: 20_262_901, mu: 0.8, warmupMs: 30_000, measureMs: 180_000, cooldownMs: 10_000 };
  // the recurrence of harness 0.9 (run.mjs), written out
  const rng = mulberry32(cfg.seed * 31 + 7);
  const expected = [];
  for (let t = 0; ; ) {
    t += (-Math.log(1 - rng()) / cfg.mu) * 1000;
    if (t >= 220_000) break;
    expected.push(t);
  }
  assert.deepEqual(publishArrivals(cfg), expected);
  assert.ok(Math.abs(expected.length - 176) <= 4 * Math.sqrt(176), `${expected.length} arrivals`);
  assert.notDeepEqual(publishArrivals({ ...cfg, seed: cfg.seed + 1 }), expected);
  assert.notDeepEqual(poissonArrivals(cfg.seed, cfg.mu, 220_000), expected, 'the share stream draws its own schedule');
  assert.deepEqual(publishArrivals({ ...cfg, mu: 0 }), []);
});

test('makeVmRequest gives every publication its own name, share operation, UAL and intent key', () => {
  const a = makeVmRequest(0, 'tag', deps.core);
  const b = makeVmRequest(1, 'tag', deps.core);
  assert.deepEqual([a.name, a.shareOperationId, a.contextGraphId], ['pub-tag-0', 'so-tag-0', CG_ID]);
  for (const k of ['name', 'shareOperationId', 'kaUal', 'intentKey', 'sealMerkleRoot', 'kaNumber'])
    assert.notEqual(a[k], b[k], k);
  assert.equal(a.contentScopeVersion, deps.core.GRAPH_KA_CONTENT_SCOPE_VERSION);
  assert.deepEqual(makeVmRequest(0, 'tag', deps.core), a, 'a pure function of (index, tag)');
  assert.deepEqual(walletIdsOf(3), ['aqc-wallet-0', 'aqc-wallet-1', 'aqc-wallet-2']);
  assert.deepEqual(LIFT_DEFAULTS, { wallets: 6, walletHoldMs: 3000, pollMs: 1000 });
});

test('the wallet trace records lock writes and deletes, passes every call through and leaves emit as it found it', () => {
  const calls = [];
  const trace = { emit: function (...args) { calls.push([this === trace, ...args]); return 7; } };
  const own = installWalletTrace(trace);
  assert.equal(trace.emit('wallet_lock_written', { jobId: 'j1' }, 'w0', 'tok'), 7, 'the original return value');
  trace.emit('wallet_lock_deleted', {}, 'w0');
  trace.emit('claim_outcome', { result: 'claimed' }, 'w0');
  trace.emit('wallet_lock_written', undefined, 'w1');
  assert.deepEqual(
    own.events.map(({ ev, walletId, jobId }) => [ev, walletId, jobId]),
    [
      ['written', 'w0', 'j1'],
      ['deleted', 'w0', undefined],
      ['written', 'w1', null],
    ],
  );
  assert.ok(own.events.every((e) => Number.isFinite(e.at)));
  assert.deepEqual(
    calls.map(([self, event]) => [self, event]),
    [
      [true, 'wallet_lock_written'],
      [true, 'wallet_lock_deleted'],
      [true, 'claim_outcome'],
      [true, 'wallet_lock_written'],
    ],
    'every call reaches the original with the same receiver',
  );
  assert.deepEqual(calls[0].slice(2), [{ jobId: 'j1' }, 'w0', 'tok']);
  own.uninstall();
  assert.equal(Object.hasOwn(trace, 'emit'), true, 'an own emit goes back to the original');
  assert.throws(() => installWalletTrace({}), /claimTrace\.emit not found/);
  // the real thing: emit lives on the prototype, so uninstalling removes the own property again
  const real = deps.liftClaimTrace.claimTrace;
  const proto = Object.getPrototypeOf(real).emit;
  const installed = installWalletTrace(real);
  assert.notEqual(real.emit, proto);
  installed.uninstall();
  assert.equal(Object.hasOwn(real, 'emit'), false);
  assert.equal(real.emit, proto);
});

test('the publish preflight is the share probe, then 13 reads; a degraded probe stops it at once', async () => {
  const reads = [];
  const store = { query: async (sparql, options) => void reads.push([options.source, sparql]) };
  const world = { store };
  let probes = 0;
  const ok = createPublishPreflight(world, async () => (probes++, { ok: true }));
  assert.deepEqual(await ok(3), { ok: true });
  assert.equal(probes, 1);
  assert.equal(reads.length, 13);
  assert.ok(reads.every(([source]) => source.startsWith('bench.pre.')));
  assert.equal(new Set(reads.map(([source]) => source)).size, 13);
  assert.match(reads[0][1], /asset-3/, 'the asset slot follows the publication index');
  reads.length = 0;
  const reject = { reject: { outcome: 'typed_reject_not_admitted', code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' } };
  assert.deepEqual(await createPublishPreflight(world, async () => reject)(0), reject);
  assert.equal(reads.length, 0);
});

test('the synthetic handler verifies before the send, holds the wallet for the chain and replays the 16 tail operations', async () => {
  const log = [];
  const record = (kind) => async (...args) => void log.push([kind, args.at(-1)?.source]);
  const store = {
    query: record('query'),
    insert: record('insert'),
    delete: record('delete'),
    listGraphs: record('listGraphs'),
    dropGraph: record('dropGraph'),
    update: record('update'),
  };
  const world = { store, cfg: { walletHoldMs: 40 } };
  const handler = createLiftHandler(world, { storage: { deleteByPatternWithoutCount: async (_s, _spec, o) => void log.push(['deleteByPattern', o.source]) } });
  assert.deepEqual(await handler.preflight({ request: { name: 'pub-t-4' } }), { action: 'execute' });
  assert.equal(log.length, 5, 'five verification reads');
  assert.ok(log.every(([kind, source]) => kind === 'query' && source.startsWith('bench.vr.')));
  log.length = 0;
  const hooks = [];
  const t0 = performance.now();
  const result = await handler.execute({
    request: { name: 'pub-t-4', kaUal: 'did:dkg:x' },
    publishOptions: {
      onBeforeBroadcast: async () => hooks.push('before'),
      onBroadcastAccepted: async () => hooks.push('accepted'),
      onPublishConfirmed: () => hooks.push('confirmed'),
    },
  });
  assert.ok(performance.now() - t0 >= 38, 'the wallet is held for the chain');
  assert.deepEqual(hooks, ['before', 'accepted', 'confirmed']);
  assert.equal(log[0][1], 'bench.vr.lifecyclePointer');
  assert.equal(log.length - 1, LIFT_TAIL_OPS, 'one pointer read, then the executor tail');
  assert.ok(log.slice(1).every(([, source]) => source.startsWith('bench.dp.lift.')));
  assert.deepEqual(handler.state, { preflights: 1, executions: 1, tailOps: LIFT_TAIL_OPS });
  assert.deepEqual([result.status, result.kaId, result.ual], ['confirmed', 1004n, 'did:dkg:x']);
});

/** The benchmark's publisher on a seeded in-memory store: a lift side whose chain time and poll are short. */
async function rig({ wallets = 2, walletHoldMs = 150, publications = 4 } = {}) {
  const store = new deps.storage.OxigraphStore();
  await seedMainNamespace(store, deps.core);
  const world = {
    cfg: {
      runTag: 'tg',
      wallets,
      walletHoldMs,
      liftPollMs: 20,
      mu: 1,
      seed: 1,
      warmupMs: 0,
      measureMs: 60_000,
      cooldownMs: 0,
    },
    t0: null,
    epoch0: 0,
    store,
    pubRequests: [],
    liftObserverEvents: [],
  };
  const liftSide = createLiftSide(world, deps, { stageStore: store, graphManager: new deps.storage.GraphManager(store) });
  for (let n = 0; n < publications; n++) await liftSide.stage(n);
  await beginEpoch(world, () => liftSide.start());
  return { world, liftSide, store };
}

const enqueue = (liftSide, n) => liftSide.admission.enqueueKnowledgeAssetVmPublish(liftSide.request(n), { admittedByAgentAddress: AGENT });

test('the real publisher claims, executes and finishes the submitted jobs; the trace and the metrics read them back', async () => {
  const { world, liftSide, store } = await rig({ wallets: 2, walletHoldMs: 250, publications: 3 });
  try {
    const wallets = [];
    await enqueue(liftSide, 0);
    await enqueue(liftSide, 1);
    // both wallets locked: the third publication becomes ready with no worker free
    await until(() => new Set(liftSide.trace.events.filter((e) => e.ev === 'written').map((e) => e.walletId)).size === 2, 'both wallets locked');
    wallets.push(...liftSide.trace.events.map((e) => e.walletId));
    await enqueue(liftSide, 2);
    await until(async () => (await liftSide.admission.list({ status: 'finalized' })).length === 3, 'three finalized jobs');
    assert.deepEqual(liftSide.handler.state, { preflights: liftSide.handler.state.preflights, executions: 3, tailOps: 3 * LIFT_TAIL_OPS });
    assert.ok(liftSide.handler.state.preflights >= 3);
    assert.equal(liftSide.state.errors, 0);
    assert.deepEqual(liftSide.state.bootBackfill, { ok: true });

    const byName = await readLiftJobs(store, deps, 'tg');
    assert.deepEqual([...byName.keys()].sort(), ['pub-tg-0', 'pub-tg-1', 'pub-tg-2']);
    assert.ok([...byName.values()].every((jobs) => jobs.length === 1 && jobs[0].status === 'finalized'));
    assert.equal((await readLiftJobs(store, deps, 'other')).size, 0, 'another run tag reads nothing');

    const rows = [...byName.values()].flat().map((j) => jobRow(j, world.epoch0));
    const events = liftSide.trace.events.map((e) => ({ t: e.at - world.epoch0, ev: e.ev, walletId: e.walletId }));
    assert.equal(events.filter((e) => e.ev === 'deleted').length, 3, 'each job releases its wallet once');
    assert.ok(events.filter((e) => e.ev === 'written').length >= 3);
    assert.ok(events.every((e) => liftSide.walletIds.includes(e.walletId)));
    const block = pickupBlock({
      rows,
      window: { from: -1000, to: 60_000 },
      runEnd: performance.now() - world.t0,
      walletEvents: events,
      walletIds: liftSide.walletIds,
    });
    assert.deepEqual([block.pickup.nAccepted, block.pickup.nClaimed, block.pickup.nCensored, block.reclaimed], [3, 3, 0, 0]);
    assert.equal(block.workerFree.traceLive, true);
    assert.equal(block.workerFree.nQualifying + block.workerFree.nBusy + block.workerFree.nUnknown, 3);
    const third = rows.find((r) => r.name === 'pub-tg-2');
    assert.equal(walletClassifier(events, liftSide.walletIds)(third.readyAt), 'busy', 'ready with both wallets locked');
    assert.equal(block.workerFree.nBusy, 1);
    assert.ok(third.claimedAt - third.acceptedAt >= 100, 'the third job waited for a wallet to be released');
    assert.equal(block.claimToFinishMs.n, 3);
    assert.ok(block.claimToFinishMs.p50 >= 250, 'claim to finish includes the wallet hold');
  } finally {
    assert.equal(await liftSide.stop(), true);
  }
  assert.equal(Object.hasOwn(deps.liftClaimTrace.claimTrace, 'emit'), false, 'stop() takes the trace off the product');
});

test('publish producers run the preflight, enqueue and record every outcome in the window they were due in', async () => {
  const { world, liftSide, store } = await rig({ wallets: 2, walletHoldMs: 20, publications: 3 });
  try {
    const preflight = createPublishPreflight(world, async () => ({ ok: true }));
    const producers = startPublishProducers(world, liftSide, preflight, [5, 30, 55]);
    assert.equal(world.pubArrivalCount, 3);
    await sleep(120);
    producers.stop();
    assert.equal(await producers.drain(5000), 0);
    finalizeRequests(world.pubRequests);
    const recs = world.pubRequests;
    assert.deepEqual(recs.map((r) => r.key), ['pub-tg-0', 'pub-tg-1', 'pub-tg-2']);
    assert.ok(recs.every((r) => r.outcome === 'success' && r.windowTag === 'measure' && r.jobId && r.preMs >= 0 && r.enqMs >= 0));
    await until(async () => (await liftSide.admission.list({ status: 'finalized' })).length === 3, 'the jobs finish');
    assert.deepEqual([...(await readLiftJobs(store, deps, 'tg')).keys()].sort(), recs.map((r) => r.key));
    // a rejected probe is the route's 503: no enqueue, a recorded failure
    const rejecting = createPublishPreflight(world, async () => ({
      reject: { outcome: 'typed_reject_not_admitted', code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE', phase: 'preflight' },
    }));
    world.pubRequests = [];
    const again = startPublishProducers(world, liftSide, rejecting, [0]);
    again.stop();
    await again.drain(2000);
    assert.deepEqual(world.pubRequests.map((r) => [r.outcome, r.code, r.jobId]), [['typed_reject_not_admitted', 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE', undefined]]);
  } finally {
    await liftSide.stop();
  }
});

test('the publisher list observer polls the full list; the paged call waits for P9a', async () => {
  const { liftSide } = await rig({ wallets: 1, walletHoldMs: 10, publications: 2 });
  try {
    assert.deepEqual(await LIFT_OBSERVER_CALLS.default(liftSide.admission), { rows: 0 });
    await enqueue(liftSide, 0);
    assert.deepEqual(await LIFT_OBSERVER_CALLS.default(liftSide.admission), { rows: 1 });
    assert.equal(LIFT_OBSERVER_CALLS.paged, null);
  } finally {
    await liftSide.stop();
  }
});

test('stop() reports a runner that does not stop in time and still takes the trace off', async () => {
  const { liftSide } = await rig({ wallets: 1, walletHoldMs: 10, publications: 1 });
  const stop = liftSide.runner.stop.bind(liftSide.runner);
  liftSide.runner.stop = () => new Promise(() => {}); // never settles
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 25_000 ? 30 : ms, ...a); // the 25 s cap, shortened
  try {
    assert.equal(await liftSide.stop(), false);
    assert.equal(liftSide.state.stopTimedOut, true);
    assert.equal(Object.hasOwn(deps.liftClaimTrace.claimTrace, 'emit'), false);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    liftSide.runner.stop = stop;
    await liftSide.runner.stop();
  }
});
