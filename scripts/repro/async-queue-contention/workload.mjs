// Load generators and worker wiring of the async queue contention benchmark: open-loop Poisson share submissions with
// the route's preflight reads, closed-loop client readers, a list observer, the real worker supervisor over a fake
// agent that replays the per-share store operations, and the idle publisher. The product comes in through `deps`
// (backend.mjs loadDist), so this file is import-safe. Publisher and mixed cells (P2b) would add their producers beside
// startShareProducers and reuse the idle publisher's wiring.
import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToLoop, setTimeout as sleep } from 'node:timers/promises';
import {
  AGENT,
  CG_ID,
  NS_GRAPHS,
  PAYLOAD_TRIPLES,
  WM_POOL,
  assetOf,
  entityOf,
  metaGraph,
  replayOps,
  vmGraph,
  wmPoolGraph,
} from './fixture.mjs';

/** Resolves when p settles or after ms, whichever is first (the timer never outlives the race). */
export function within(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Poisson arrival times in ms from the start of the load, deterministic given the seed (the same repeat index is the
 * same schedule in every build).
 */
export function poissonArrivals(seed, lambda, horizonMs) {
  const rng = mulberry32(seed);
  const out = [];
  for (let t = 0; lambda > 0;) {
    t += (-Math.log(1 - rng()) / lambda) * 1000;
    if (t >= horizonMs) break;
    out.push(t);
  }
  return out;
}

const TYPED_STORAGE_CODES = new Set(['STORE_SCHEDULER_BUSY', 'STORE_OPERATION_TIMEOUT']);

/** The first typed storage failure in the cause chain of e (e itself included), or undefined. */
function typedStorageFailure(e) {
  const seen = new Set();
  for (let c = e; c && typeof c === 'object' && !seen.has(c) && seen.size < 8; c = c.cause) {
    if (TYPED_STORAGE_CODES.has(c.code)) return c;
    seen.add(c);
  }
  return undefined;
}

/** Matches on `code`, which stays right when P3 makes busy errors carry priority 'control'. */
export function classifyError(e) {
  const name = e?.name;
  const code = e?.code;
  if (name === 'PromoteAdmissionUncertainError') {
    // the queue could not confirm a write (bindRecovery, inline claim): uncertainty caused by a typed storage
    // rejection is load, not an agent defect. Any other cause stays an 'error'.
    const storage = typedStorageFailure(e.cause);
    if (storage) {
      return {
        outcome: 'indeterminate',
        code: storage.code,
        phase: 'store',
        admissionOutcome: 'indeterminate',
        ...(e.jobId ? { jobId: e.jobId } : {}),
      };
    }
  }
  if (name === 'PromoteAdmissionError' || code === 'PROMOTE_ADMISSION_UNAVAILABLE') {
    return {
      outcome: e.admissionOutcome === 'indeterminate' ? 'indeterminate' : 'typed_reject_not_admitted',
      code: 'PROMOTE_ADMISSION_UNAVAILABLE',
      phase: e.phase,
      admissionOutcome: e.admissionOutcome,
      ...(e.admissionOutcome === 'indeterminate' && e.jobId ? { jobId: e.jobId } : {}),
    };
  }
  if (name === 'PromoteJobConflictError') return { outcome: 'conflict', code: 'PROMOTE_JOB_CONFLICT' };
  if (code === 'STORE_SCHEDULER_BUSY')
    return { outcome: 'typed_reject_not_admitted', code, phase: 'store', reason: e.reason };
  if (code === 'STORE_OPERATION_TIMEOUT')
    return {
      outcome: e.outcome === 'indeterminate' ? 'indeterminate' : 'typed_reject_not_admitted',
      code,
      phase: 'store',
    };
  return { outcome: 'error', code: code ?? name, message: String(e?.message ?? e).slice(0, 160) };
}

/**
 * The share-async route's preflight reads (resolveRequiredWriteContextGraphId -> probeContextGraphWritePreflight): the
 * REAL probe and the REAL agent resolve methods bound to a minimal `this`. A degraded probe is the route's 503
 * CONTEXT_GRAPH_VALIDATION_UNAVAILABLE.
 */
export function makePreflight({ store, deps }) {
  const self = { store };
  const methods = deps.resolve.ContextGraphResolveMethods.prototype;
  const host = {
    store,
    contextGraphExists: (id, o) => methods.contextGraphExists.call(self, id, o),
    contextGraphHasLocalContent: (id, o) => methods.contextGraphHasLocalContent.call(self, id, o),
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async () => false,
  };
  const subscriptions = { store: { load: async () => null }, current: () => undefined };
  return async function preflight() {
    const probe = await deps.preflight.probeContextGraphWritePreflight(host, subscriptions, CG_ID, {
      callerAgentAddress: null,
    });
    if (!probe.storeAvailable)
      return {
        reject: {
          outcome: 'typed_reject_not_admitted',
          code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE',
          phase: 'preflight',
        },
      };
    if (probe.exists !== true || probe.hasLocalContent !== true || probe.accessPolicy !== 'public')
      return { reject: { outcome: 'error', code: 'PREFLIGHT_NOT_FAST_ACCEPT', phase: 'preflight' } };
    return { ok: true };
  };
}

const NOOP = {
  stop() {},
  async drain() {
    return 0;
  },
};

/**
 * The workload epoch. world.t0 stays null (events stamped before it are not recorded) while `startup` is awaited, then
 * is set, so the producers' schedule, every event timestamp, the resource samplers (`onEpoch`) and the window
 * boundaries all count from one instant after the worker and the idle publisher are up: the startup time is neither
 * charged to submission latency nor released as a burst of overdue arrivals.
 */
export async function beginEpoch(world, startup, onEpoch = () => {}) {
  await startup();
  world.t0 = performance.now();
  world.epoch0 = Date.now();
  onEpoch();
}

const requireEpoch = (world) => {
  if (world.t0 === null) throw new Error('the workload epoch is not set: start the load after beginEpoch()');
};

/** Resolves when `ms` have passed since the epoch (immediately if they already have). */
export const sleepUntil = (world, ms) => sleep(Math.max(0, ms - (performance.now() - world.t0)));

/**
 * Open loop. The whole schedule is precomputed; every arrival whose intended time has passed is issued at once, so a
 * stalled driver cannot hide late requests (no coordinated omission) and latency is ended - intended. The window tag
 * comes from the intended time.
 */
export function startShareProducers(world, preflight) {
  requireEpoch(world);
  const { cfg } = world;
  const horizon = cfg.warmupMs + cfg.measureMs + cfg.cooldownMs;
  const arrivals = poissonArrivals(cfg.seed, cfg.lambda, horizon);
  const inflight = new Set();
  const windowOf = (t) => (t < cfg.warmupMs ? 'warmup' : t < cfg.warmupMs + cfg.measureMs ? 'measure' : 'cooldown');
  let next = 0;
  let stopped = false;
  world.arrivalCount = arrivals.length;
  const request = async (n, intended) => {
    const key = `${cfg.runTag}-s${n}`;
    const rec = { i: n, key, intended, started: performance.now() - world.t0, windowTag: windowOf(intended) };
    world.requests.push(rec);
    try {
      const pf0 = performance.now();
      const pf = await preflight();
      rec.preMs = performance.now() - pf0;
      if (pf.reject) {
        Object.assign(rec, pf.reject);
        return;
      }
      const e0 = performance.now();
      rec.enqStart = e0 - world.t0;
      rec.jobId = await world.queue.enqueue({
        contextGraphId: CG_ID,
        assertionName: key,
        agentAddress: AGENT,
        entities: 'all',
      });
      rec.enqMs = performance.now() - e0;
      rec.outcome = 'success';
    } catch (e) {
      Object.assign(rec, classifyError(e));
      if (rec.enqStart !== undefined) rec.enqMs = performance.now() - (rec.enqStart + world.t0);
    } finally {
      rec.ended = performance.now() - world.t0;
    }
  };
  const loop = (async () => {
    while (!stopped && next < arrivals.length) {
      const now = performance.now() - world.t0;
      if (arrivals[next] > now) {
        await sleep(Math.min(arrivals[next] - now, 50));
        continue;
      }
      while (next < arrivals.length && arrivals[next] <= now) {
        const n = next++;
        const p = request(n, arrivals[n]).finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
    async drain(capMs) {
      await loop;
      await within(Promise.allSettled(inflight), capMs);
      return inflight.size;
    },
  };
}

/**
 * Closed-loop client readers on the background lane (the api.query default): point queries and the CG-wide aggregate
 * COUNT over the NS_GRAPHS graphs.
 */
export function startReaders(world) {
  requireEpoch(world);
  const { cfg, store } = world;
  const rng = mulberry32(cfg.seed * 7919 + 17);
  const loops = [];
  const rows = Array.from({ length: NS_GRAPHS }, (_, k) => `(<${vmGraph(k)}> ${k})`).join(' ');
  // sparql-scan-allow: R2 -- ?__g is bound by VALUES over the NS_GRAPHS fixture graphs (the api.query CG-wide aggregate
  // shape)
  const aggregate =
    `SELECT (COUNT(*) AS ?n) WHERE { SELECT ?s ?p ?o WHERE { VALUES (?__g ?__r) { ${rows} } GRAPH ?__g { ?s ?p ?o } ` +
    `FILTER NOT EXISTS { VALUES (?__pg ?__pr) { ${rows} } FILTER (?__pr < ?__r) GRAPH ?__pg { ?s ?p ?o } } } }`;
  let stop = false;
  const one = async (kind, sparql) => {
    const t0 = performance.now();
    let ok = true;
    let err;
    try {
      await store.query(sparql, { priority: 'background', source: 'api.query' });
    } catch (e) {
      ok = false;
      err = e?.code ?? e?.name;
    }
    world.readerEvents.push({ kind, t: t0 - world.t0, ms: performance.now() - t0, ok, err });
    await yieldToLoop(); // a closed loop that fails at once must not starve timers and I/O
  };
  for (let n = 0; n < cfg.content; n++) {
    loops.push(
      (async () => {
        while (!stop) {
          const k = Math.floor(rng() * NS_GRAPHS);
          const j = Math.floor(rng() * 8);
          await one('content', `SELECT ?p ?o WHERE { GRAPH <${vmGraph(k)}> { <${entityOf(k, j)}> ?p ?o } }`);
        }
      })(),
    );
  }
  for (let n = 0; n < cfg.aggregate; n++)
    loops.push(
      (async () => {
        await sleep(n * 700);
        while (!stop) await one('aggregate', aggregate);
      })(),
    );
  return {
    stop() {
      stop = true;
    },
    drain: (capMs) => within(Promise.allSettled(loops), capMs),
  };
}

// ---------------------------------------------------------------- list observer
/**
 * What the observer polls. `default` is the public list route without a cursor, a full read. `paged` stays null until
 * the paging API exists (P8a / P9b): that PR adds ONE entry `(queue) => walkPages((cursor) => <their page
 * function>(queue, cursor).then((r) => ({ rows: <count>, nextCursor: <cursor or null> })))` and MUST ALSO update
 * `default` to whatever the route's cursorless call becomes (the plan keeps listUnlocked complete for claimNext, so it
 * may stop being list()).
 */
export const OBSERVER_CALLS = {
  default: async (queue) => ({ rows: (await queue.list({})).length }),
  paged: null,
};

/** Walks fetchPage(cursor) -> { rows, nextCursor? } to the end. The longest page time is the mutex-hold proxy. */
export async function walkPages(fetchPage) {
  const pageMs = [];
  let rows = 0;
  let cursor;
  for (;;) {
    const t0 = performance.now();
    const page = await fetchPage(cursor);
    pageMs.push(performance.now() - t0);
    rows += page.rows;
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor) throw new Error(`the paging cursor did not advance (${cursor})`);
    cursor = page.nextCursor;
  }
  return { rows, pages: pageMs.length, pageMs };
}

/** Sequential like a polling script: the next poll starts observerMs after the previous one settled. */
export function startObserver(world, mode) {
  const call = OBSERVER_CALLS[mode];
  const { observerMs } = world.cfg;
  if (mode === 'none' || !call) return NOOP;
  requireEpoch(world);
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await sleep(observerMs);
      if (stop) break;
      const t0 = performance.now();
      const ev = { t: t0 - world.t0, ok: true };
      try {
        const r = await call(world.queue);
        Object.assign(ev, { rows: r.rows, ...(r.pageMs ? { pages: r.pages, maxPageMs: Math.max(...r.pageMs) } : {}) });
      } catch (e) {
        ev.ok = false;
        ev.err = e?.code ?? e?.name;
      }
      ev.ms = performance.now() - t0;
      world.observerEvents.push(ev);
    }
  })();
  return {
    stop() {
      stop = true;
    },
    drain: (capMs) => within(loop, capMs),
  };
}

// ---------------------------------------------------------------- worker side
/**
 * The real worker supervisor (4 workers, 100 ms poll, 60 s heartbeat) over a fake agent: promoteQueue is the real queue
 * behind a Proxy that times claimNext and succeed, and the share body is the replay table. The queue's own operations
 * (claim, bind, markers, succeed, heartbeat) are the product's. `stats` is the worker side's evidence that the run
 * measured what it claims: agentErrors (errors the fake agent threw that are not store-busy or timeout rejections, i.e.
 * the supervisor / agent contract broke), dataOps (replay operations started) and, on `log`, the supervisor's crash
 * lines. Call freeze() before stopping the supervisor: errors from jobs cut short by the shutdown are not contract
 * breaks.
 */
export function createWorker(world, deps) {
  const { queue, store } = world;
  const ops = replayOps(deps.storage.deleteByPatternWithoutCount);
  const ownership = deps.pub.TripleStoreAsyncPromoteQueue.ownershipReader(store);
  const enqueuedAt = new Map();
  const log = { count: 0, crashes: 0, lines: [] };
  const stats = { agentErrors: 0, dataOps: 0, firstAgentError: null, counting: true };
  const timed = new Proxy(queue, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (prop === 'claimNext') {
        return async (...a) => {
          const t0 = performance.now();
          let job = null;
          try {
            job = await v.apply(target, a);
            return job;
          } finally {
            // the supervisor polls from its start(), before the epoch: those claims are startup, not workload
            const live = world.t0 !== null;
            if (live) world.claimMs.push({ t: t0 - world.t0, ms: performance.now() - t0, job: Boolean(job) });
            if (job) {
              enqueuedAt.set(job.jobId, job.enqueuedAt);
              if (live) world.claimLatMs.push(Date.now() - job.enqueuedAt);
            }
          }
        };
      }
      if (prop === 'succeed') {
        return async (...a) => {
          const r = await v.apply(target, a);
          if (world.t0 !== null) {
            world.completions.push({
              t: performance.now() - world.t0,
              jobId: a[0],
              latMs: Date.now() - (enqueuedAt.get(a[0]) ?? Date.now()),
            });
          }
          return r;
        };
      }
      return v.bind(target);
    },
  });
  const binding = () =>
    deps.binding.validatePromoteRecoveryBinding({
      version: 1,
      sealDigest: `0x${randomBytes(32).toString('hex')}`,
      inventoryRequired: false,
      intent: deps.intent.createPromoteOperationIntent({
        operationId: deps.intent.createShareOperationId(),
        timestampMs: Date.now(),
        publisherPeerId: 'aqc-peer',
        confirmationRequired: false,
        accessPolicy: 'public',
      }),
    });
  const shareOf = (name) => {
    const jn = Number(/-s(\d+)$/.exec(String(name))?.[1] ?? 0);
    return {
      jn,
      key: `${jn.toString(36)}-${Date.now().toString(36)}`,
      a: assetOf(jn),
      privG: `${metaGraph()}/private-${jn % 4}`,
      wmG: wmPoolGraph(jn % WM_POOL),
    };
  };
  const run = async (rows, c) => {
    for (const [source, , fn] of rows) {
      stats.dataOps++;
      await fn(store, c, { source: `bench.dp.${source}` });
    }
  };
  const watched =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        if (stats.counting && classifyError(e).outcome === 'error') {
          stats.agentErrors++;
          stats.firstAgentError ??= `${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`;
        }
        throw e;
      }
    };
  const agent = {
    promoteQueue: timed,
    assertion: {
      prepareQueuedShare: watched(async (job, authority) => {
        const c = shareOf(job.request.assertionName);
        const r = job.request;
        await run(ops.draft, c);
        await authority.run(async () => {
          await ownership({
            contextGraphId: r.contextGraphId,
            assertionName: r.assertionName,
            agentAddress: r.agentAddress,
            subGraphName: r.subGraphName,
          }); // the lock-free lifecycle read
          await authority.assertCurrent();
          await run([ops.sealPrepare], c);
        });
        const bound = await authority.run(async () => {
          await authority.assertCurrent();
          await run([ops.sealAdmit], c);
          return queue.bindRecovery(job.jobId, job.lease.claimToken, binding());
        });
        return { job: bound };
      }),
      promote: watched(async (_contextGraphId, assertionName, options) => {
        const c = shareOf(assertionName);
        const authority = options.executionAuthority;
        await run([ops.policy], c);
        await authority.run(async () => {
          await authority.assertCurrent();
          await run(ops.body, c);
        });
        await run(ops.tail, c);
        return { promotedCount: PAYLOAD_TRIPLES };
      }),
    },
  };
  const supervisor = deps.worker.createPromoteWorkerSupervisor({
    agent,
    workerConcurrency: 4,
    pollIntervalMs: 100,
    shutdownTimeoutMs: 1500,
    log: (m) => {
      log.count++;
      // the supervisor's line for an agent that threw out of a claimed job
      if (/crashed processing/.test(String(m))) log.crashes++;
      if (log.lines.length < 50) log.lines.push(String(m).slice(0, 300));
    },
  });
  return {
    supervisor,
    log,
    stats,
    freeze: () => {
      stats.counting = false;
    },
  };
}

/**
 * The always-on publisher of a daemon with no publish load: admission and runtime instances plus the runner polling six
 * wallets. Any error gates validity.
 */
export function createIdlePublisher(world, deps) {
  const state = { errors: 0, first: null, bootBackfill: null };
  const note = (e) => {
    state.errors++;
    state.first ??= String(e?.message ?? e).slice(0, 200);
  };
  const trip = (what) => {
    const e = new Error(`idle publisher must not ${what} a job`);
    note(e);
    throw e;
  };
  const base = { journalWrites: true };
  const store = world.store;
  const admission = new deps.pub.TripleStoreAsyncLiftPublisher(store, base);
  const runtime = new deps.pub.TripleStoreAsyncLiftPublisher(store, {
    ...base,
    knowledgeAssetVmPublishHandler: { preflight: async () => trip('preflight'), execute: async () => trip('execute') },
  });
  const runner = new deps.pub.AsyncLiftRunner({
    publisher: runtime,
    walletIds: Array.from({ length: 6 }, (_, i) => `aqc-wallet-${i}`),
    pollIntervalMs: 1000,
    errorBackoffMs: 5000,
    recoveryIntervalMs: 60_000,
    onError: note,
  });
  return {
    state,
    async start() {
      try {
        await admission.ensureVmPublishIntentIndex?.();
        state.bootBackfill = { ok: true };
      } catch (e) {
        state.bootBackfill = { ok: false, err: String(e?.message ?? e).slice(0, 160) };
      } // fail-open like the daemon's boot backfill
      await runner.start();
    },
    stop: () => within(runner.stop(), 20_000),
  };
}
