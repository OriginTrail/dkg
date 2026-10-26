// The load generators and worker wiring of the async queue contention benchmark (OT-RFC-73 P2a) against fakes: no
// backend, no dist. The worker over the real supervisor and queue is in async-queue-contention-replay.test.mjs.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import {
  AGENT,
  CG_ID,
  DATA_OPS_PER_SHARE,
  NS_GRAPHS,
  PAYLOAD_TRIPLES,
  replayOps,
  vmGraph,
} from '../../repro/async-queue-contention/fixture.mjs';
import { finalizeRequests, validity } from '../../repro/async-queue-contention/verdict.mjs';
import {
  OBSERVER_CALLS,
  beginEpoch,
  classifyError,
  createIdlePublisher,
  createWorker,
  makePreflight,
  mulberry32,
  poissonArrivals,
  reconcileAdmissions,
  sleepUntil,
  startObserver,
  startReaders,
  startShareProducers,
  trackAdmissionWork,
  within,
} from '../../repro/async-queue-contention/workload.mjs';

const world = (cfg, extra = {}) => ({
  cfg: {
    warmupMs: 100,
    measureMs: 200,
    cooldownMs: 100,
    lambda: 40,
    seed: 7,
    runTag: 't',
    content: 0,
    aggregate: 0,
    observerMs: 10,
    ...cfg,
  },
  t0: performance.now(),
  requests: [],
  observerEvents: [],
  readerEvents: [],
  claimMs: [],
  claimLatMs: [],
  completions: [],
  ...extra,
});
const jobNumber = (name) => Number(String(name).split('-s')[1]);

test('mulberry32 and poissonArrivals are deterministic and shaped like a Poisson process', () => {
  const rng = mulberry32(1);
  assert.deepEqual(
    [rng(), rng()].map((x) => Math.round(x * 1e6) / 1e6),
    [0.627074, 0.002736],
  );
  const a = poissonArrivals(7300, 8, 100_000);
  assert.deepEqual(poissonArrivals(7300, 8, 100_000), a);
  assert.notDeepEqual(poissonArrivals(7301, 8, 100_000), a);
  assert.ok(Math.abs(a.length - 800) <= 4 * Math.sqrt(800), `${a.length} arrivals`);
  assert.ok(a.every((t, i) => t < 100_000 && (i === 0 || t > a[i - 1])));
  assert.deepEqual(poissonArrivals(1, 0, 1000), []);
});

test('classifyError maps the typed admission and store errors by code', () => {
  assert.deepEqual(
    classifyError(
      Object.assign(new Error('x'), {
        code: 'PROMOTE_ADMISSION_UNAVAILABLE',
        admissionOutcome: 'indeterminate',
        phase: 'persist',
        jobId: 'j1',
      }),
    ),
    {
      outcome: 'indeterminate',
      code: 'PROMOTE_ADMISSION_UNAVAILABLE',
      phase: 'persist',
      admissionOutcome: 'indeterminate',
      jobId: 'j1',
    },
  );
  assert.equal(
    classifyError(
      Object.assign(new Error('x'), { name: 'PromoteAdmissionError', admissionOutcome: 'not_admitted', phase: 'lock' }),
    ).outcome,
    'typed_reject_not_admitted',
  );
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { name: 'PromoteJobConflictError' })), {
    outcome: 'conflict',
    code: 'PROMOTE_JOB_CONFLICT',
  });
  assert.deepEqual(
    classifyError(
      Object.assign(new Error('x'), { code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full', priority: 'control' }),
    ),
    { outcome: 'typed_reject_not_admitted', code: 'STORE_SCHEDULER_BUSY', phase: 'store', reason: 'queue_full' },
  );
  assert.equal(
    classifyError(Object.assign(new Error('x'), { code: 'STORE_OPERATION_TIMEOUT', outcome: 'indeterminate' })).outcome,
    'indeterminate',
  );
  assert.equal(
    classifyError(Object.assign(new Error('x'), { code: 'STORE_OPERATION_TIMEOUT' })).outcome,
    'typed_reject_not_admitted',
  );
  assert.deepEqual(classifyError(new TypeError('nope')), { outcome: 'error', code: 'TypeError', message: 'nope' });
});

/** What the queue throws when a write may or may not have landed (bindRecovery, inline claim). */
const uncertain = (cause) =>
  Object.assign(new Error('Durable share admission could not be confirmed', { cause }), {
    name: 'PromoteAdmissionUncertainError',
    jobId: 'j9',
  });

test('classifyError recognises queue uncertainty caused by a typed storage failure and nothing else', () => {
  const busy = Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full' });
  assert.deepEqual(classifyError(uncertain(busy)), {
    outcome: 'indeterminate',
    code: 'STORE_SCHEDULER_BUSY',
    phase: 'store',
    admissionOutcome: 'indeterminate',
    jobId: 'j9',
  });
  const late = Object.assign(new Error('late'), { code: 'STORE_OPERATION_TIMEOUT' });
  assert.equal(classifyError(uncertain(late)).code, 'STORE_OPERATION_TIMEOUT');
  const deep = uncertain(new Error('write failed', { cause: new Error('adapter', { cause: busy }) }));
  assert.equal(classifyError(deep).outcome, 'indeterminate', 'the cause chain is inspected, not just the first cause');
  // a genuine defect behind the same wrapper, an untyped wrapper and a cyclic chain stay errors
  assert.equal(classifyError(uncertain(new TypeError('the share body changed shape'))).outcome, 'error');
  assert.equal(classifyError(uncertain(undefined)).outcome, 'error');
  const unwrapped = Object.assign(new Error('x', { cause: busy }), { name: 'SomethingElse' });
  assert.equal(classifyError(unwrapped).outcome, 'error', 'only the uncertainty wrapper is looked through');
  const loop = new Error('loop');
  loop.cause = loop;
  assert.equal(classifyError(uncertain(loop)).outcome, 'error');
});

test('within resolves at the cap without keeping a timer alive', async () => {
  const t0 = performance.now();
  const abort = new AbortController();
  await within(
    sleep(5000, undefined, { signal: abort.signal }).catch(() => {}),
    30,
  );
  abort.abort();
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(await within(Promise.resolve('done'), 5000), 'done');
});

// ---------------------------------------------------------------- the replay table
function recordingStore(calls) {
  const rec =
    (kind, result) =>
    async (...args) => {
      calls.push({ kind, args });
      return result;
    };
  return {
    query: rec('query', { bindings: [] }),
    listGraphs: rec('listGraphs', []),
    hasGraph: rec('hasGraph', false),
    insert: rec('insert'),
    delete: rec('delete'),
    replaceGraph: rec('replaceGraph'),
    dropGraph: rec('dropGraph'),
  };
}

test('the replay table is the 43 operations of one share (12 body reads, 19 body writes, two payload writes)', async () => {
  const ops = replayOps(async (store, spec, options) => store.recordDelete(spec, options));
  const body = ops.body;
  const rows = [...ops.draft, ops.sealPrepare, ops.sealAdmit, ops.policy, ...body, ...ops.tail];
  assert.equal(rows.length, 43);
  assert.equal(rows.length, DATA_OPS_PER_SHARE, 'the constant the validity check counts against');
  assert.equal(new Set(rows.map(([source]) => source)).size, 43, 'every operation has its own source label');
  assert.equal(body.length, 31);
  assert.deepEqual([body.filter((r) => r[1] === 'r').length, body.filter((r) => r[1] === 'w').length], [12, 19]);
  const calls = [];
  const store = {
    ...recordingStore(calls),
    recordDelete: async (spec, options) => calls.push({ kind: 'deleteByPattern', args: [spec, options] }),
  };
  const c = { jn: 3, key: 'k3', a: 'urn:asset', privG: 'urn:priv', wmG: 'urn:wm' };
  for (const [source, , fn] of rows) await fn(store, c, { source });
  assert.equal(calls.length, 43);
  const payloads = calls.filter(
    (x) =>
      (x.kind === 'replaceGraph' || x.kind === 'insert') &&
      x.args.some((a) => Array.isArray(a) && a.length === PAYLOAD_TRIPLES),
  );
  assert.deepEqual(
    payloads.map((x) => x.kind),
    ['replaceGraph', 'insert'],
  );
  assert.equal(calls.filter((x) => x.kind === 'dropGraph').length, 2);
  assert.equal(calls.filter((x) => x.kind === 'listGraphs').length, 3);
  assert.ok(calls.filter((x) => x.kind === 'query').every((x) => /^(SELECT|CONSTRUCT|ASK)/.test(x.args[0])));
  assert.ok(!calls.some((x) => /OFFSET/i.test(String(x.args[0]))));
});

// ---------------------------------------------------------------- producers
test('share producers precompute the schedule, tag windows by intended time and classify every outcome', async () => {
  const w = world({});
  let preflights = 0;
  w.queue = {
    enqueue: async ({ assertionName, contextGraphId, agentAddress, entities }) => {
      assert.deepEqual([contextGraphId, agentAddress, entities], [CG_ID, AGENT, 'all']);
      await sleep(1);
      const n = jobNumber(assertionName);
      if (n % 5 === 4) throw Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full' });
      return `job-${n}`;
    },
  };
  const producers = startShareProducers(w, async () =>
    ++preflights === 3
      ? {
          reject: {
            outcome: 'typed_reject_not_admitted',
            code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE',
            phase: 'preflight',
          },
        }
      : { ok: true },
  );
  const expected = poissonArrivals(7, 40, 400);
  assert.equal(w.arrivalCount, expected.length);
  await sleep(450);
  producers.stop();
  assert.equal(await producers.drain(2000), 0);
  assert.equal(w.requests.length, expected.length);
  assert.deepEqual(
    w.requests.map((r) => r.key),
    expected.map((_, n) => `t-s${n}`),
  );
  assert.deepEqual(
    w.requests.map((r) => r.intended),
    expected,
  );
  for (const r of w.requests)
    assert.equal(r.windowTag, r.intended < 100 ? 'warmup' : r.intended < 300 ? 'measure' : 'cooldown');
  assert.ok(w.requests.every((r) => r.ended !== undefined && r.ended >= r.started));
  const by = (code) => w.requests.filter((r) => r.code === code);
  assert.equal(by('CONTEXT_GRAPH_VALIDATION_UNAVAILABLE').length, 1);
  assert.ok(
    by('STORE_SCHEDULER_BUSY').length > 0 &&
      by('STORE_SCHEDULER_BUSY').every((r) => r.outcome === 'typed_reject_not_admitted' && jobNumber(r.key) % 5 === 4),
  );
  const ok = w.requests.filter((r) => r.outcome === 'success');
  assert.ok(ok.length > 0 && ok.every((r) => r.jobId === `job-${jobNumber(r.key)}` && r.enqMs >= 0 && r.preMs >= 0));
});

test('a stalled driver issues the late arrivals at once and the latency counts from the intended time', async () => {
  const w = world({ lambda: 100, warmupMs: 0, measureMs: 300, cooldownMs: 0 });
  w.queue = { enqueue: async ({ assertionName }) => `job-${jobNumber(assertionName)}` };
  assert.ok(
    poissonArrivals(7, 100, 300).filter((t) => t < 60).length > 0,
    'the schedule has arrivals inside the stall',
  );
  const producers = startShareProducers(w, async () => ({ ok: true }));
  for (const end = performance.now() + 120; performance.now() < end;); // the driver stalls for 120 ms
  await sleep(350);
  producers.stop();
  await producers.drain(1000);
  const late = w.requests.filter((r) => r.started - r.intended > 40);
  assert.ok(late.length > 0, 'requests due during the stall start late');
  assert.ok(
    late.every((r) => r.ended - r.intended > 40),
    'and their latency includes the stall',
  );
});

test('a stall across the final boundary still issues every overdue arrival, latency counted from its intended time', async () => {
  const w = world({ lambda: 100, warmupMs: 0, measureMs: 200, cooldownMs: 100 });
  w.queue = { enqueue: async ({ assertionName }) => `job-${jobNumber(assertionName)}` };
  const schedule = poissonArrivals(7, 100, 300);
  assert.ok(schedule.length >= 15 && schedule.at(-1) > 250, 'the schedule reaches the final boundary');
  const producers = startShareProducers(w, async () => ({ ok: true }));
  for (const end = performance.now() + 360; performance.now() < end;); // the driver stalls past the 300 ms horizon
  producers.stop(); // and the run stops at once: the whole schedule is overdue
  assert.equal(await producers.drain(2000), 0);
  assert.deepEqual(
    w.requests.map((r) => r.intended),
    schedule,
    'every scheduled request is in the stats',
  );
  assert.ok(w.requests.every((r) => r.outcome === 'success' && r.started >= 360 && r.ended >= r.started));
  finalizeRequests(w.requests);
  assert.ok(
    w.requests.every((r) => r.latMs === r.ended - r.intended && r.latMs >= 360 - r.intended),
    'the stall is in every latency, counted from the intended time',
  );
});

test('arrivals not yet due when the producer stops are recorded as unsent failures, not dropped', async () => {
  const w = world({ lambda: 100, warmupMs: 0, measureMs: 300, cooldownMs: 0 });
  w.queue = { enqueue: async ({ assertionName }) => `job-${jobNumber(assertionName)}` };
  const schedule = poissonArrivals(7, 100, 300);
  assert.ok(schedule.some((t) => t < 60) && schedule.some((t) => t > 200), 'arrivals on both sides of the stop');
  const producers = startShareProducers(w, async () => ({ ok: true }));
  await sleep(120);
  producers.stop();
  assert.equal(await producers.drain(2000), 0);
  assert.deepEqual(
    w.requests.map((r) => r.key),
    schedule.map((_, n) => `t-s${n}`),
    'the whole schedule is represented',
  );
  const sent = w.requests.filter((r) => r.outcome === 'success');
  const unsent = w.requests.filter((r) => r.outcome === 'not_issued');
  assert.equal(sent.length + unsent.length, schedule.length);
  assert.ok(sent.length > 0 && unsent.length > 0);
  assert.ok(Math.max(...sent.map((r) => r.intended)) < Math.min(...unsent.map((r) => r.intended)));
  assert.ok(unsent.every((r) => r.started === undefined && r.ended === undefined && r.windowTag === 'measure'));
  finalizeRequests(w.requests);
  assert.ok(
    unsent.every((r) => r.outcome === 'caller_timeout' && r.rawOutcome === 'not_issued' && r.lateOutcome === 'unfinished'),
    'finalizeRequests counts an unsent arrival as a censored failure',
  );
});

test('the epoch starts after a slow startup: no inflated latency and no catch-up burst', async () => {
  const w = world({ lambda: 40, warmupMs: 100, measureMs: 200, cooldownMs: 100 }, { t0: null });
  w.queue = { enqueue: async ({ assertionName }) => `job-${jobNumber(assertionName)}` };
  const schedule = poissonArrivals(7, 40, 400);
  const startupMs = 250;
  assert.ok(schedule.filter((t) => t < startupMs).length >= 5, 'a startup this long would owe a burst of arrivals');
  const events = [];
  await beginEpoch(
    w,
    async () => {
      events.push('startup');
      await sleep(startupMs); // the worker supervisor and the idle publisher coming up
      events.push('up');
    },
    () => events.push(`samplers:${w.t0 !== null}`),
  );
  assert.deepEqual(events, ['startup', 'up', 'samplers:true'], 'the samplers start with the epoch, after the startup');
  assert.ok(performance.now() - w.t0 < 100, 'the epoch is the end of the startup, not its start');
  assert.ok(Math.abs(Date.now() - w.epoch0) < 100);
  const producers = startShareProducers(w, async () => ({ ok: true }));
  await sleep(450);
  producers.stop();
  assert.equal(await producers.drain(2000), 0);
  assert.equal(w.requests.length, schedule.length);
  assert.ok(
    w.requests.every((r) => r.started >= r.intended && r.started - r.intended < 100),
    'no arrival is issued late, so none is issued in a burst',
  );
  assert.ok(w.requests.every((r) => r.ended - r.intended < 100), 'and the startup is not in any latency');
  assert.ok(w.requests[0].started < 100, 'the schedule starts at the epoch');
});

test('a failing startup sets no epoch, and the load refuses to start without one', async () => {
  const w = world({}, { t0: null });
  await assert.rejects(
    beginEpoch(w, async () => {
      throw new Error('supervisor failed to start');
    }),
    /supervisor failed/,
  );
  assert.equal(w.t0, null);
  w.queue = { list: async () => [] };
  w.store = { query: async () => ({ bindings: [] }) };
  assert.throws(() => startShareProducers(w, async () => ({ ok: true })), /epoch is not set/);
  assert.throws(() => startReaders(w), /epoch is not set/);
  assert.throws(() => startObserver(w, 'default'), /epoch is not set/);
  assert.equal(await startObserver(w, 'none').drain(), 0, 'no observer is nothing to start');
});

test('sleepUntil counts from the epoch, so a window boundary does not drift with the work done before it', async () => {
  const w = world({}, { t0: performance.now() - 80 });
  const t0 = performance.now();
  await sleepUntil(w, 120);
  const waited = performance.now() - t0;
  assert.ok(waited >= 35 && waited < 250, `${waited} ms until 40 ms after now`);
  const past = performance.now();
  await sleepUntil(w, 10);
  assert.ok(performance.now() - past < 50, 'a boundary already passed does not wait');
});

// ---------------------------------------------------------------- admission work and reconciliation
/**
 * A coordinator as the queue uses it (promote-admission.js): run() starts the work in a microtask, answers its caller
 * at the deadline, and the work goes on. Its run() is a prototype method, like the product's.
 */
class DeadlineCoordinator {
  async run(_request, work, timeoutMs) {
    const operation = Promise.resolve().then(() => work({}));
    const deadline = sleep(timeoutMs).then(() => {
      throw new Error('deadline');
    });
    return Promise.race([operation, deadline]);
  }
}
const gate = () => {
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

test('trackAdmissionWork follows a work past the deadline its caller was answered at, until it settles', async () => {
  const coordinator = new DeadlineCoordinator();
  const tracker = trackAdmissionWork(coordinator);
  const g = gate();
  const work = async () => {
    await g.opened;
    return 'job-1';
  };
  const caller = await coordinator.run({}, work, 20).catch((e) => e.message);
  assert.equal(caller, 'deadline', 'the caller was answered while the work is still running');
  assert.deepEqual([tracker.installed, tracker.started, tracker.pending()], [true, 1, 1]);
  assert.equal(await tracker.settle(40), 1, 'a work that outlives the cap is reported, not waited for');
  const settled = tracker.settle(2000);
  g.open();
  assert.equal(await settled, 0);
  assert.deepEqual([tracker.started, tracker.pending()], [1, 0]);
  assert.equal(await coordinator.run({}, async () => 'job-2', 1000), 'job-2', 'the wrapper answers like run()');

  // a work that fails settles too
  const failing = await coordinator
    .run(
      {},
      async () => {
        throw new Error('write failed');
      },
      1000,
    )
    .catch((e) => e.message);
  assert.equal(failing, 'write failed');
  assert.deepEqual([tracker.started, tracker.pending()], [3, 0]);

  // a run() that refuses before it starts any work leaves nothing to wait for
  const refusing = {
    async run() {
      throw new Error('refused');
    },
  };
  const refused = trackAdmissionWork(refusing);
  await assert.rejects(refusing.run({}, async () => 'never', 1000), /refused/);
  assert.deepEqual([refused.started, refused.pending(), await refused.settle(50)], [0, 0, 0]);
});

test('trackAdmissionWork puts run() back, and is not installed on a coordinator without one', () => {
  const coordinator = new DeadlineCoordinator();
  const tracker = trackAdmissionWork(coordinator);
  assert.ok(Object.hasOwn(coordinator, 'run'));
  tracker.dispose();
  assert.ok(!Object.hasOwn(coordinator, 'run'), 'the prototype method is what is left');
  const own = { run: async () => 'x' };
  const original = own.run;
  trackAdmissionWork(own).dispose();
  assert.equal(own.run, original, 'an own run() is restored as it was');
  const none = trackAdmissionWork({});
  assert.deepEqual([none.installed, none.started, none.pending(), none.dispose()], [false, 0, 0, undefined]);
  assert.equal(trackAdmissionWork(undefined).installed, false);
});

const gateChecks = (admissions) =>
  validity({
    lambda: 8,
    measureMs: 1000,
    measured: 8,
    stillInflight: 0,
    admissionsPending: admissions.pending,
    reconcileError: null,
    successWithoutJob: 0,
    doubleAdmissions: 0,
    driverCpu: 0.1,
    idlePublisherErrors: 0,
    worker: { agentErrors: 0, crashes: 0, failedTerminal: 0, succeeded: 1, attempted: 1, dataOps: DATA_OPS_PER_SHARE },
    seedFileVerified: true,
  });

test('reconciliation reads the ground truth only after the admission writes behind the deadline have settled', async () => {
  const coordinator = new DeadlineCoordinator();
  const tracker = trackAdmissionWork(coordinator);
  const persisted = new Map();
  const g = gate();
  // the write commits 60 ms after its caller was answered
  const write = async () => {
    await g.opened;
    persisted.set('t-s0', [{ jobId: 'j0' }]);
  };
  coordinator.run({}, write, 20).catch(() => {});
  await sleep(40);
  assert.equal(tracker.pending(), 1);
  setTimeout(g.open, 60);
  const seen = [];
  const r = await reconcileAdmissions({
    tracker,
    issued: true,
    readJobs: async () => {
      seen.push(persisted.size);
      return new Map(persisted);
    },
    settleMs: 2000,
  });
  assert.deepEqual(seen, [1], 'the read came after the write');
  assert.deepEqual([r.reconcileError, r.jobsByName.get('t-s0')?.[0].jobId], [null, 'j0']);
  assert.deepEqual([r.admissions.works, r.admissions.pendingAtDrain, r.admissions.pending], [1, 1, 0]);
  assert.ok(r.admissions.settleWaitMs >= 30, `waited ${r.admissions.settleWaitMs} ms for the write`);
  assert.equal(gateChecks(r.admissions).admissionsSettled, true);
});

test('a reconciliation that cannot establish the admission writes is unresolved and the run invalid', async () => {
  // (1) a write that never settles within the bound
  const coordinator = new DeadlineCoordinator();
  const tracker = trackAdmissionWork(coordinator);
  const g = gate();
  coordinator.run({}, async () => g.opened, 10).catch(() => {});
  await sleep(30);
  const stuck = await reconcileAdmissions({
    tracker,
    issued: true,
    readJobs: async () => new Map(),
    settleMs: 60,
  });
  g.open();
  assert.equal(stuck.admissions.pending, 1);
  assert.ok(stuck.admissions.settleWaitMs >= 50 && stuck.admissions.settleWaitMs < 1000, 'the wait is bounded');
  const checks = gateChecks(stuck.admissions);
  assert.deepEqual([checks.admissionsSettled, checks.ok], [false, false]);

  // (2) a tracker that saw no work although requests reached enqueue is not attached to this queue
  const unattached = await reconcileAdmissions({
    tracker: trackAdmissionWork(new DeadlineCoordinator()),
    issued: true,
    readJobs: async () => new Map(),
  });
  assert.equal(unattached.admissions.pending, null);
  assert.equal(gateChecks(unattached.admissions).ok, false);
  const noRun = await reconcileAdmissions({
    tracker: trackAdmissionWork({}),
    issued: false,
    readJobs: async () => new Map(),
  });
  assert.equal(noRun.admissions.pending, null, 'a coordinator without run() establishes nothing');
  // no request reached enqueue: there is nothing to wait for
  const idle = await reconcileAdmissions({
    tracker: trackAdmissionWork(new DeadlineCoordinator()),
    issued: false,
    readJobs: async () => new Map(),
  });
  assert.deepEqual([idle.admissions.pending, gateChecks(idle.admissions).admissionsSettled], [0, true]);

  // (3) a failing read is the reconcile error
  const broken = await reconcileAdmissions({
    tracker: trackAdmissionWork(new DeadlineCoordinator()),
    issued: false,
    readJobs: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual([broken.reconcileError, broken.jobsByName.size], ['boom', 0]);
});

// ---------------------------------------------------------------- readers and observer
test('readers run closed-loop on the background lane and record failures by code', async () => {
  const calls = [];
  const w = world(
    { content: 2, aggregate: 1 },
    {
      store: {
        query: async (sparql, options) => {
          calls.push({ sparql, options });
          await sleep(3);
          if (sparql.includes('COUNT')) throw Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY' });
          return { bindings: [] };
        },
      },
    },
  );
  const readers = startReaders(w);
  await sleep(120);
  readers.stop();
  await readers.drain(1000);
  assert.ok(calls.length > 6);
  assert.ok(calls.every((c) => c.options.priority === 'background' && c.options.source === 'api.query'));
  const agg = calls.find((c) => c.sparql.includes('COUNT')).sparql;
  assert.ok(agg.includes(`<${vmGraph(NS_GRAPHS - 1)}> ${NS_GRAPHS - 1}`) && agg.includes('FILTER NOT EXISTS'));
  const kinds = new Set(w.readerEvents.map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ['aggregate', 'content']);
  assert.ok(
    w.readerEvents.filter((e) => e.kind === 'aggregate').every((e) => !e.ok && e.err === 'STORE_SCHEDULER_BUSY'),
  );
  assert.ok(w.readerEvents.filter((e) => e.kind === 'content').every((e) => e.ok && e.ms >= 0));
});

test('the observer polls sequentially, walks pages when the paged call exists and is a no-op for none', async () => {
  const w = world({});
  let listed = 0;
  w.queue = {
    list: async () => {
      listed++;
      await sleep(2);
      return [1, 2, 3];
    },
  };
  const obs = startObserver(w, 'default');
  await sleep(90);
  obs.stop();
  await obs.drain(1000);
  assert.ok(w.observerEvents.length >= 2 && w.observerEvents.length <= listed);
  assert.ok(w.observerEvents.every((e) => e.ok && e.rows === 3 && e.ms > 0));
  assert.equal(OBSERVER_CALLS.paged, null);
  for (const mode of ['none', 'paged'])
    assert.equal(await startObserver(world({}), mode).drain(), 0, `${mode} is a no-op while the paged call is missing`);
  const paged = world({});
  paged.queue = {};
  OBSERVER_CALLS.paged = async () => ({ rows: 7, pages: 2, pageMs: [3, 9] });
  try {
    const p = startObserver(paged, 'paged');
    await sleep(40);
    p.stop();
    await p.drain(1000);
  } finally {
    OBSERVER_CALLS.paged = null;
  }
  assert.ok(
    paged.observerEvents.length >= 1 &&
      paged.observerEvents.every((e) => e.rows === 7 && e.pages === 2 && e.maxPageMs === 9),
  );
  const failing = world({});
  failing.queue = {
    list: async () => {
      throw Object.assign(new Error('x'), { code: 'STORE_SCHEDULER_BUSY' });
    },
  };
  const f = startObserver(failing, 'default');
  await sleep(40);
  f.stop();
  await f.drain(1000);
  assert.ok(
    failing.observerEvents.length >= 1 &&
      failing.observerEvents.every((e) => !e.ok && e.err === 'STORE_SCHEDULER_BUSY'),
  );
});

// ---------------------------------------------------------------- preflight, worker and idle publisher
test('makePreflight runs the real probe through the agent resolve methods; a degraded probe maps to the 503 code', async () => {
  const store = { id: 'store' };
  const seen = [];
  let probe = { storeAvailable: true, exists: true, hasLocalContent: true, accessPolicy: 'public' };
  const proto = {
    contextGraphExists(id, o) {
      seen.push(['exists', this.store, id, o]);
    },
    contextGraphHasLocalContent(id, o) {
      seen.push(['content', this.store, id, o]);
    },
  };
  const deps = {
    resolve: { ContextGraphResolveMethods: { prototype: proto } },
    preflight: {
      probeContextGraphWritePreflight: async (host, subscriptions, id, options) => {
        assert.deepEqual([id, options], [CG_ID, { callerAgentAddress: null }]);
        host.contextGraphExists(id, { a: 1 });
        host.contextGraphHasLocalContent(id, { b: 2 });
        assert.equal(await subscriptions.store.load(), null);
        assert.equal(host.curatorDidMatchesChecksumAgent(), false);
        return probe;
      },
    },
  };
  const preflight = makePreflight({ store, deps });
  assert.deepEqual(await preflight(), { ok: true });
  assert.deepEqual(seen, [
    ['exists', store, CG_ID, { a: 1 }],
    ['content', store, CG_ID, { b: 2 }],
  ]);
  probe = { storeAvailable: false };
  assert.deepEqual(await preflight(), {
    reject: { outcome: 'typed_reject_not_admitted', code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE', phase: 'preflight' },
  });
  probe = { storeAvailable: true, exists: true, hasLocalContent: false, accessPolicy: 'public' };
  assert.equal((await preflight()).reject.code, 'PREFLIGHT_NOT_FAST_ACCEPT');
});

/** A job as claimNext returns it: running under a lease and still unbound (its request has no recovery binding). */
const claimedJob = (jobId, assertionName) => ({
  jobId,
  state: 'running',
  formatVersion: 4,
  enqueuedAt: Date.now() - 50,
  updatedAt: Date.now(),
  attempt: { count: 1, maxRetries: 5 },
  lease: {
    workerId: 'w0',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 900_000,
    lastHeartbeatAt: Date.now(),
    claimToken: 'tok',
  },
  request: { contextGraphId: CG_ID, assertionName, agentAddress: AGENT, entities: 'all' },
});

/**
 * What the queue's bindRecovery returns (a BoundPromoteJob): the claimed job and its lease, now format 4, with the
 * whole-asset request carrying the immutable recovery binding. The supervisor runs the promote from this job's request.
 */
const boundJobOf = (job, binding) => ({
  ...job,
  formatVersion: 4,
  request: { ...job.request, entities: 'all', agentAddress: job.request.agentAddress, recoveryBinding: binding },
});

/** The product's classification as far as these fakes need it: a request holding a recovery binding is 'bound'. */
const classifyQueuedSharePreparation = (job) => (job.request.recoveryBinding ? 'bound' : 'eligible');

test('the supervisor gets the real queue behind a timing proxy and a fake agent whose preparation returns the bound job', async () => {
  const calls = [];
  const claimed = claimedJob('j1', 't-s12');
  const bindings = [];
  const queue = {
    effectiveLeaseMs: 900_000,
    workScheduling: { token: 1 },
    claimNext: async () => claimed,
    succeed: async (id) => `done:${id}`,
    heartbeat: async function heartbeat(id) {
      return `hb:${id}:${this === queue}`;
    },
    bindRecovery: async (id, token, binding) => {
      assert.deepEqual([id, token], ['j1', 'tok'], 'bound under the claim that prepared it');
      bindings.push(binding);
      return boundJobOf(claimed, binding);
    },
  };
  const w = world({}, { queue, store: recordingStore(calls) });
  const deps = {
    storage: {
      deleteByPatternWithoutCount: async (store, spec, options) =>
        calls.push({ kind: 'deleteByPattern', args: [spec, options] }),
    },
    pub: {
      classifyQueuedSharePreparation,
      TripleStoreAsyncPromoteQueue: {
        ownershipReader: (store) => {
          assert.equal(store, w.store);
          return async (request) => {
            calls.push({ kind: 'ownership', args: [request] });
          };
        },
      },
    },
    binding: { validatePromoteRecoveryBinding: (b) => b },
    intent: { createPromoteOperationIntent: (x) => x, createShareOperationId: () => 'op-1' },
    worker: { createPromoteWorkerSupervisor: (cfg) => ({ cfg }) },
  };
  const { supervisor, log, stats } = createWorker(w, deps);
  const { agent, ...settings } = supervisor.cfg;
  assert.deepEqual(
    { ...settings, log: undefined },
    { workerConcurrency: 4, pollIntervalMs: 100, shutdownTimeoutMs: 1500, log: undefined },
    'product defaults: heartbeat and sweep intervals are not overridden',
  );
  const q = agent.promoteQueue;
  assert.equal(q.effectiveLeaseMs, 900_000);
  assert.equal(q.workScheduling, queue.workScheduling);
  assert.equal(await q.heartbeat('j1'), 'hb:j1:true');
  const job = await q.claimNext('w0');
  assert.equal(job.jobId, 'j1');
  assert.equal(w.claimMs.length, 1);
  assert.ok(w.claimMs[0].job && w.claimMs[0].ms >= 0 && w.claimLatMs[0] >= 50);
  const authority = {
    run: async (fn) => fn(),
    assertCurrent: async () => {
      calls.push({ kind: 'assertCurrent', args: [] });
    },
  };
  const prepared = await agent.assertion.prepareQueuedShare(job, authority);
  // the supervisor continues from prepared.job: its request is what the promote is run with
  assert.equal(bindings.length, 1);
  assert.deepEqual(
    [prepared.job.jobId, prepared.job.state, prepared.job.formatVersion, prepared.job.lease.claimToken],
    ['j1', 'running', 4, 'tok'],
  );
  assert.deepEqual(
    { ...prepared.job.request, recoveryBinding: undefined },
    { contextGraphId: CG_ID, assertionName: 't-s12', agentAddress: AGENT, entities: 'all', recoveryBinding: undefined },
  );
  assert.equal(prepared.job.request.recoveryBinding, bindings[0]);
  assert.equal(prepared.job.request.recoveryBinding.sealDigest.length, 66);
  assert.equal(await q.succeed('j1', 'tok'), 'done:j1');
  assert.equal(w.completions.length, 1);
  assert.ok(w.completions[0].latMs >= 50 && w.completions[0].jobId === 'j1');
  const storeOps = calls.filter((c) => !['ownership', 'assertCurrent'].includes(c.kind));
  assert.equal(storeOps.length, 7, 'the preparation issues the 5 draft reads and the 2 seal reads');
  assert.equal(calls.filter((c) => c.kind === 'ownership').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'assertCurrent').length, 2);
  assert.deepEqual(calls.find((c) => c.kind === 'ownership').args[0], {
    contextGraphId: CG_ID,
    assertionName: 't-s12',
    agentAddress: AGENT,
    subGraphName: undefined,
  });
  const sources = storeOps.map((c) => c.args.at(-1)?.source);
  assert.equal(sources.length, 7);
  assert.ok(
    sources.every((s) => s?.startsWith('bench.dp.')),
    'data-plane calls carry a source label and no priority',
  );
  assert.ok(storeOps.every((c) => c.args.at(-1).priority === undefined));
  supervisor.cfg.log('first');
  for (let i = 0; i < 60; i++) supervisor.cfg.log(`line ${i}`);
  assert.deepEqual([log.count, log.lines.length], [61, 50]);
  assert.deepEqual([stats.dataOps, stats.agentErrors, stats.firstAgentError, log.crashes], [7, 0, null, 0]);
});

/** The worker over a store whose operations can fail: returns the agent, the evidence and the calls. */
function workerRig(failWith) {
  const calls = [];
  const store = recordingStore(calls);
  store.query = async (sparql) => {
    calls.push({ kind: 'query', args: [sparql] });
    if (failWith.error && calls.length === failWith.at) throw failWith.error;
    return { bindings: [] };
  };
  const job = claimedJob('j1', 't-s3');
  const queue = {
    bindRecovery: async (id, token, binding) => {
      calls.push({ kind: 'bindRecovery', args: [id] });
      if (failWith.bindError) throw failWith.bindError;
      return boundJobOf(job, binding);
    },
    claimNext: async () => job,
    succeed: async (id) => `done:${id}`,
  };
  const w = world({}, { queue, store });
  const deps = {
    storage: { deleteByPatternWithoutCount: async () => {} },
    pub: { classifyQueuedSharePreparation, TripleStoreAsyncPromoteQueue: { ownershipReader: () => async () => {} } },
    binding: { validatePromoteRecoveryBinding: (b) => b },
    intent: { createPromoteOperationIntent: (x) => x, createShareOperationId: () => 'op-1' },
    worker: { createPromoteWorkerSupervisor: (cfg) => ({ cfg }) },
  };
  const rig = createWorker(w, deps);
  const authority = { run: async (fn) => fn(), assertCurrent: async () => {} };
  return { ...rig, agent: rig.supervisor.cfg.agent, authority, job, calls, world: w };
}

test('the worker counts agent errors that are not store rejections and stops counting at freeze()', async () => {
  const unexpected = workerRig({ at: 2, error: new TypeError('the share body changed shape') });
  await assert.rejects(
    unexpected.agent.assertion.prepareQueuedShare(unexpected.job, unexpected.authority),
    /changed shape/,
  );
  assert.deepEqual(
    [unexpected.stats.agentErrors, unexpected.stats.firstAgentError],
    [1, 'TypeError: the share body changed shape'],
  );
  assert.equal(unexpected.stats.dataOps, 2, 'operations are counted when they start, the failing one included');

  const busy = workerRig({ at: 2, error: Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY' }) });
  await assert.rejects(busy.agent.assertion.prepareQueuedShare(busy.job, busy.authority), /busy/);
  assert.deepEqual(
    [busy.stats.agentErrors, busy.stats.firstAgentError],
    [0, null],
    'a store rejection is load, not a broken contract',
  );

  const timeout = workerRig({ at: 1, error: Object.assign(new Error('late'), { code: 'STORE_OPERATION_TIMEOUT' }) });
  await assert.rejects(timeout.agent.assertion.prepareQueuedShare(timeout.job, timeout.authority), /late/);
  assert.equal(timeout.stats.agentErrors, 0);

  const cutShort = workerRig({ at: 1, error: new Error('aborted by the shutdown') });
  cutShort.freeze();
  await assert.rejects(cutShort.agent.assertion.prepareQueuedShare(cutShort.job, cutShort.authority), /aborted/);
  assert.equal(cutShort.stats.agentErrors, 0, 'jobs cut short after freeze() are not counted');

  const crashes = workerRig({});
  const { log } = crashes.supervisor.cfg;
  assert.equal(typeof log, 'function');
  log('Worker w0 crashed processing j1: boom');
  log('Worker w1 stopped bookkeeping for j2 after shutdown timeout');
  assert.equal(crashes.log.crashes, 1, 'only the supervisor line for a job that crashed counts');
});

test('a job that already holds its recovery binding is returned unchanged: no preparation reads, no second bind', async () => {
  const rig = workerRig({ bindError: new Error('the queue forbids binding a bound job again') });
  const bound = boundJobOf(rig.job, { sealDigest: `0x${'ab'.repeat(32)}` });
  const prepared = await rig.agent.assertion.prepareQueuedShare(bound, rig.authority);
  assert.deepEqual(Object.keys(prepared), ['job']);
  assert.equal(prepared.job, bound, 'the supervisor continues from the very job it was handed');
  assert.deepEqual(rig.calls, [], 'neither a draft or seal read nor bindRecovery');
  assert.deepEqual([rig.stats.dataOps, rig.stats.agentErrors], [0, 0]);

  // an unbound job is still prepared and bound
  const unbound = await rig.agent.assertion.prepareQueuedShare(rig.job, rig.authority).catch((e) => e);
  assert.equal(unbound.message, 'the queue forbids binding a bound job again');
  assert.equal(rig.calls.filter((c) => c.kind === 'bindRecovery').length, 1);
  assert.equal(rig.stats.dataOps, 7);
});

test('the worker does not count queue uncertainty from a typed storage failure, and does not hide it', async () => {
  const busy = Object.assign(new Error('busy'), { code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full' });
  const rig = workerRig({ bindError: uncertain(busy) });
  await assert.rejects(rig.agent.assertion.prepareQueuedShare(rig.job, rig.authority), (e) => {
    assert.equal(e.name, 'PromoteAdmissionUncertainError', 'the supervisor still sees the uncertain write');
    return true;
  });
  assert.equal(rig.calls.filter((c) => c.kind === 'bindRecovery').length, 1, 'the uncertain write is not retried');
  assert.deepEqual([rig.stats.agentErrors, rig.stats.firstAgentError], [0, null], 'load, not a broken contract');

  const defect = workerRig({ bindError: uncertain(new TypeError('the binding changed shape')) });
  await assert.rejects(
    defect.agent.assertion.prepareQueuedShare(defect.job, defect.authority),
    /could not be confirmed/,
  );
  assert.deepEqual(
    [defect.stats.agentErrors, defect.stats.firstAgentError],
    [1, 'PromoteAdmissionUncertainError: Durable share admission could not be confirmed'],
    'an uncertain write with an untyped cause is still an agent error',
  );
});

test('events the worker produces before the epoch are not recorded', async () => {
  const rig = workerRig({});
  const { world: w } = rig;
  w.t0 = null; // the supervisor is started, the epoch is not
  const q = rig.agent.promoteQueue;
  assert.equal((await q.claimNext('w0')).jobId, 'j1');
  assert.equal(await q.succeed('j1', 'tok'), 'done:j1');
  assert.deepEqual([w.claimMs.length, w.claimLatMs.length, w.completions.length], [0, 0, 0]);
  await beginEpoch(w, async () => {});
  await q.claimNext('w0');
  await q.succeed('j1', 'tok');
  assert.deepEqual([w.claimMs.length, w.claimLatMs.length, w.completions.length], [1, 1, 1]);
  assert.ok(w.claimMs[0].t >= 0 && w.completions[0].t >= 0);
});

test('the idle publisher counts any job it is handed and survives a failed boot backfill', async () => {
  const made = [];
  const state = { ensured: 0, fail: false, started: 0, stopped: 0 };
  class Publisher {
    constructor(store, options) {
      made.push({ store, options, self: this });
    }
    async ensureVmPublishIntentIndex() {
      state.ensured++;
      if (state.fail) throw new Error('index busy');
    }
  }
  class Runner {
    constructor(options) {
      state.options = options;
    }
    async start() {
      state.started++;
    }
    async stop() {
      state.stopped++;
    }
  }
  const w = world({}, { store: { id: 'store' } });
  const idle = createIdlePublisher(w, { pub: { TripleStoreAsyncLiftPublisher: Publisher, AsyncLiftRunner: Runner } });
  assert.deepEqual(
    made.map((m) => [m.store, m.options.journalWrites, typeof m.options.knowledgeAssetVmPublishHandler]),
    [
      [w.store, true, 'undefined'],
      [w.store, true, 'object'],
    ],
  );
  await idle.start();
  assert.deepEqual([state.ensured, state.started, idle.state.bootBackfill, idle.state.errors], [1, 1, { ok: true }, 0]);
  const { publisher, walletIds, pollIntervalMs, errorBackoffMs, recoveryIntervalMs, onError } = state.options;
  assert.equal(publisher, made[1].self, 'the runner polls the runtime instance, the one with the handler');
  assert.deepEqual([walletIds.length, pollIntervalMs, errorBackoffMs, recoveryIntervalMs], [6, 1000, 5000, 60_000]);
  onError(new Error('runner failed'));
  await assert.rejects(
    made[1].options.knowledgeAssetVmPublishHandler.execute(),
    /idle publisher must not execute a job/,
  );
  await assert.rejects(made[1].options.knowledgeAssetVmPublishHandler.preflight(), /must not preflight/);
  assert.deepEqual([idle.state.errors, idle.state.first], [3, 'runner failed']);
  await idle.stop();
  assert.equal(state.stopped, 1);
  state.fail = true;
  await idle.start();
  assert.deepEqual(
    [idle.state.bootBackfill.ok, idle.state.bootBackfill.err, idle.state.errors],
    [false, 'index busy', 3],
    'a failed backfill is recorded and does not gate validity',
  );
});
