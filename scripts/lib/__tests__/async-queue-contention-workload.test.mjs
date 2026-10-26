// The load generators and worker wiring of the async queue contention benchmark (OT-RFC-73 P2a) against fakes: no
// backend, no dist.
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
import {
  OBSERVER_CALLS,
  classifyError,
  createIdlePublisher,
  createWorker,
  makePreflight,
  mulberry32,
  poissonArrivals,
  startObserver,
  startReaders,
  startShareProducers,
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

test('the supervisor gets the real queue behind a timing proxy and a fake agent replaying the 43 store operations', async () => {
  const calls = [];
  const queue = {
    effectiveLeaseMs: 900_000,
    workScheduling: { token: 1 },
    claimNext: async () => ({
      jobId: 'j1',
      enqueuedAt: Date.now() - 50,
      lease: { claimToken: 'tok' },
      request: { contextGraphId: CG_ID, assertionName: 't-s12', agentAddress: AGENT },
    }),
    succeed: async (id) => `done:${id}`,
    heartbeat: async function heartbeat(id) {
      return `hb:${id}:${this === queue}`;
    },
    bindRecovery: async (id, token, binding) => ({ jobId: id, token, binding }),
  };
  const w = world({}, { queue, store: recordingStore(calls) });
  const deps = {
    storage: {
      deleteByPatternWithoutCount: async (store, spec, options) =>
        calls.push({ kind: 'deleteByPattern', args: [spec, options] }),
    },
    pub: {
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
  assert.deepEqual([prepared.job.jobId, prepared.job.token, prepared.job.binding.sealDigest.length], ['j1', 'tok', 66]);
  assert.equal(
    await agent.assertion.promote(CG_ID, 't-s12', { executionAuthority: authority }).then((r) => r.promotedCount),
    PAYLOAD_TRIPLES,
  );
  assert.equal(await q.succeed('j1', 'tok'), 'done:j1');
  assert.equal(w.completions.length, 1);
  assert.ok(w.completions[0].latMs >= 50 && w.completions[0].jobId === 'j1');
  const storeOps = calls.filter((c) => !['ownership', 'assertCurrent'].includes(c.kind));
  assert.equal(storeOps.length, 43, 'the replay issues the 43 data-plane operations of one share');
  assert.equal(calls.filter((c) => c.kind === 'ownership').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'assertCurrent').length, 3);
  assert.deepEqual(calls.find((c) => c.kind === 'ownership').args[0], {
    contextGraphId: CG_ID,
    assertionName: 't-s12',
    agentAddress: AGENT,
    subGraphName: undefined,
  });
  const sources = storeOps.map((c) => c.args.at(-1)?.source);
  assert.equal(sources.length, 43);
  assert.ok(
    sources.every((s) => s?.startsWith('bench.dp.')),
    'data-plane calls carry a source label and no priority',
  );
  assert.ok(storeOps.every((c) => c.args.at(-1).priority === undefined));
  supervisor.cfg.log('first');
  for (let i = 0; i < 60; i++) supervisor.cfg.log(`line ${i}`);
  assert.deepEqual([log.count, log.lines.length], [61, 50]);
  assert.deepEqual(
    [stats.dataOps, stats.agentErrors, stats.firstAgentError, log.crashes],
    [DATA_OPS_PER_SHARE, 0, null, 0],
  );
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
  const queue = { bindRecovery: async (id, token, binding) => ({ jobId: id, token, binding }) };
  const w = world({}, { queue, store });
  const deps = {
    storage: { deleteByPatternWithoutCount: async () => {} },
    pub: { TripleStoreAsyncPromoteQueue: { ownershipReader: () => async () => {} } },
    binding: { validatePromoteRecoveryBinding: (b) => b },
    intent: { createPromoteOperationIntent: (x) => x, createShareOperationId: () => 'op-1' },
    worker: { createPromoteWorkerSupervisor: (cfg) => ({ cfg }) },
  };
  const rig = createWorker(w, deps);
  const authority = { run: async (fn) => fn(), assertCurrent: async () => {} };
  const job = {
    jobId: 'j1',
    lease: { claimToken: 'tok' },
    request: { contextGraphId: CG_ID, assertionName: 't-s3', agentAddress: AGENT },
  };
  return { ...rig, agent: rig.supervisor.cfg.agent, authority, job, calls };
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
