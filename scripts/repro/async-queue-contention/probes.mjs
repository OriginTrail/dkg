// The background load G0 and G0b ran with in every arm (OT-RFC-73 P2b, ported from harness 0.8/0.9): the daemon's
// health-lane status probes and a synthetic storage-ACK stream, both against the same store and default scheduler as the
// queues, so a queue path that crowds out ACK or health work shows up. The product comes in through `deps`
// (backend.mjs loadDist), so this file is import-safe.
//
// Health lane: the three store calls the daemon makes on the health lane, issued through the PRODUCT functions (no copy
// of their query text, options or decision logic):
//   daemon.status.storeProbe     probeExternalStore(agent): ASK, the caller waits at most 5 s and gets 'no-answer'
//                                (also when the scheduler rejects it); concurrent callers share the running probe. The
//                                ASK itself is never aborted and goes on after its caller gave up, so the agent given
//                                to this call sees the store through withTrackedQueries too: the caller returning says
//                                nothing about the store query, and drain() waits for that (bounded)
//   daemon.status.storeQuads     requestExternalStoreQuads(agent, now): the full-store COUNT, started in the background
//                                unless a result younger than 30 s is cached or one is running. The product returns no
//                                handle to it, so the agent given to this call sees the store through withTrackedCount:
//                                the COUNT's query is tracked and drain() waits for it (bounded), or it would still be
//                                reading when the run closes the store and drops the namespace
//   daemon.metrics.storeHealth   createStoreCountMetrics(query).getStoreCountSnapshot(): ASK {}, on every read that
//                                reuses a reconciled snapshot. The one reconcile it needs first (background lane,
//                                source daemon.metrics.storeCountReconcile, at most once per 5 min in production) is
//                                answered locally and counted: it is not a health-lane call. A health query that fails
//                                drops the product's reconciled snapshot, so the NEXT read reconciles again, and that
//                                answer is local too: a sample that issued no query to the store is recorded as
//                                'reconciled', never as an answer of the store, and is left out of the latency.
//   `agent` is { store }: the product functions read agent.store only, so the calls reach the scheduler as in the daemon.
// Cadences (the harness's D30a proposal): status every 10 s, metrics every 30 s, COUNT request every 60 s, on fixed
// schedules offset 5 s / 15 s / 20 s from the epoch so no event sits on a window edge.
//
// ACK lane: one synthetic graph-scoped ACK of a first-version KA on a core node every 4 s: 8 store operations, every one
// with priority 'ack' and the product's source label (headCheck, replaceGraph, witnessInvalidate, deleteOperationMeta,
// insertOperationMeta, workspaceHead delete + insert, ledger update). ACKs run one at a time, as one requester's stream.
// What is measured differs from the harness in one way: it timed each operation inside its scheduler slot and its queue
// wait apart (a recording scheduler), this benchmark runs on the product's own scheduler and times what the caller sees,
// queue wait included. The ACK queue-wait P95 of G2 is read from the product's per-lane wait counts (P1a/P1b), not here.
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { CG_ID } from './fixture.mjs';
import { summarize } from './verdict.mjs';
import { within } from './workload.mjs';

export const PROBE_RECONCILE_SOURCE = 'daemon.metrics.storeCountReconcile';
/** The source label of the full-store COUNT (store-quads-cache.ts countStoreQuads). */
export const COUNT_SOURCE = 'daemon.status.storeQuads';
/** The source label of the status probe's ASK (store-reachability.ts runProbe). */
export const STATUS_SOURCE = 'daemon.status.storeProbe';
/** store-reachability.ts STORE_PROBE_WAIT_MS: a status probe that has not answered by then reports 'no-answer'. */
export const NO_ANSWER_MS = 5000;
/**
 * How long the end of a run waits for the probe load to finish (startProbeLoad's drain). A status probe's CALLER answers
 * within NO_ANSWER_MS by construction, but the ASK behind it is never aborted (like the daemon's) and, like the
 * full-store COUNT, has no such bound: the drain waits for the store queries, up to this long.
 */
export const PROBE_DRAIN_MS = 30_000;
/** The harness's cadences and phases in ms, and the ACK payload in quads. */
export const LOAD_DEFAULTS = Object.freeze({
  statusMs: 10_000,
  statusPhaseMs: 5000,
  metricsMs: 30_000,
  metricsPhaseMs: 15_000,
  countMs: 60_000,
  countPhaseMs: 20_000,
  ackMs: 4000,
  ackPhaseMs: 2000,
  ackPayload: 32,
});
export const ACK_SOURCES = Object.freeze([
  'storage-ack.persistGraphScoped.headCheck',
  'storage-ack.persistGraphScoped.replaceGraph',
  'storage-ack.persistGraphScoped.witnessInvalidate',
  'storage-ack.persistGraphScoped.deleteOperationMeta',
  'storage-ack.persistGraphScoped.insertOperationMeta',
  'storage-ack.persistGraphScoped.workspaceHead.deleteByPattern',
  'storage-ack.persistGraphScoped.workspaceHead.insert',
  'storage-ack.ledger.record',
]);
export const ACK_OPS_PER_ACK = ACK_SOURCES.length;
const ACK_LEDGER_GRAPH = 'urn:dkg:node:storage-ack-ledger';
const WITNESS_GRAPH = 'urn:dkg:local:swm-materialization-witness';
const DKG = 'http://dkg.io/ontology/';
const lit = (s) => JSON.stringify(String(s));

/** Times phase, phase + period, ... below the horizon (none when the period is not positive). */
export function fixedSchedule(periodMs, phaseMs, horizonMs) {
  const out = [];
  if (!(periodMs > 0)) return out;
  for (let t = phaseMs; t < horizonMs; t += periodMs) out.push(t);
  return out;
}

/**
 * The metrics probe sample the running getStoreCountSnapshot() call belongs to ({ storeQueries }): makeMetricsQuery
 * counts into it the queries that went to the store, so a sample knows whether the store answered it or the reconcile
 * did, without a counter that overlapping samples would share.
 */
const metricsSample = new AsyncLocalStorage();

/** The query adapter the metrics module expects ({ bindings }); the one-time reconcile is answered locally. */
export function makeMetricsQuery(store, counters) {
  return async (sparql, options) => {
    if (options?.source === PROBE_RECONCILE_SOURCE) {
      counters.reconcilesStubbed++;
      return {
        bindings: [
          {
            totalTriples: '"0"',
            totalKCs: '"0"',
            totalKAs: '"0"',
            confirmedKCs: '"0"',
            tentativeKCs: '"0"',
          },
        ],
      };
    }
    counters.queries++;
    const sample = metricsSample.getStore();
    if (sample) sample.storeQueries++;
    const r = await store.query(sparql, options);
    if (r?.type === 'boolean') return { bindings: [{ result: String(r.value) }] };
    return { bindings: r?.bindings ?? [] };
  };
}

/**
 * The store as a product caller sees it: every other member is the store's own, and a query labelled with one of
 * `sources` is handed to track(promise) as well as returned. The product leaves two of its store queries running after
 * the call that started them has returned: the full-store COUNT, started in the background (requestExternalStoreQuads
 * returns the cached fields at once), and the status probe's ASK, which its caller stops waiting for after 5 s without
 * aborting it. Neither returns a handle, so this is the only way to know when they have settled. The query itself is
 * untouched: same options, same scheduler lane, same result or rejection.
 */
export function withTrackedQueries(store, sources, track) {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'query') {
        return (sparql, options) => {
          const running = target.query(sparql, options);
          if (sources.includes(options?.source)) track(Promise.resolve(running));
          return running;
        };
      }
      const member = Reflect.get(target, prop, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

/** The store as the full-store COUNT sees it (see withTrackedQueries). */
export const withTrackedCount = (store, track) => withTrackedQueries(store, [COUNT_SOURCE], track);

/**
 * Starts the probe load (call it after beginEpoch). deps = the loaded dist; cfg = { statusMs, metricsMs, countMs,
 * horizonMs } with 0 switching a probe off, and optional phases. Returns { state, stop(), drain(capMs) }; state.events
 * is [{ kind: 'status' | 'metrics' | 'count-request', t, ms, result, err }], t run-relative; a metrics result is 'ok'
 * (the store answered the health query), 'busy' or 'error' (the store rejected or failed it) or 'reconciled' (answered
 * locally, no query reached the store). drain(capMs) waits for the probes in flight and for the store queries behind
 * them that outlive their callers, the status ASK and the COUNT (see withTrackedQueries), for at most capMs in all, and
 * returns how many were still running then.
 */
export async function startProbeLoad(world, deps, cfg) {
  const { store } = world;
  const counters = { reconcilesStubbed: 0, queries: 0 };
  const metrics = deps.probeMetrics.createStoreCountMetrics(makeMetricsQuery(store, counters));
  deps.probeQuads.invalidateExternalStoreQuadsCache(); // a fresh process has an empty cache anyway; explicit for determinism
  await metrics.getStoreCountSnapshot(); // the first read reconciles (answered locally), every later one is the ASK {} probe
  const events = [];
  const tRel = () => performance.now() - world.t0;
  let stopped = false;
  const inflight = new Set();
  const track = (p) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
  };
  const statusAgent = { store: withTrackedQueries(store, [STATUS_SOURCE], track) };
  const countAgent = { store: withTrackedCount(store, track) };
  const statusOnce = async () => {
    const t0 = performance.now();
    let result;
    let err;
    try {
      result = await deps.probeReach.probeExternalStore(statusAgent);
    } catch (e) {
      result = 'threw';
      err = e?.code ?? e?.name;
    }
    events.push({
      kind: 'status',
      t: t0 - world.t0,
      ms: performance.now() - t0,
      result,
      err,
    });
  };
  const metricsOnce = async () => {
    const t0 = performance.now();
    let result = 'ok';
    let err;
    const sample = { storeQueries: 0 };
    try {
      await metricsSample.run(sample, () => metrics.getStoreCountSnapshot());
      // after a failed health query the product reconciles again, and the adapter answers that locally: no query
      // reached the store, so this sample says nothing about it
      if (sample.storeQueries === 0) result = 'reconciled';
    } catch (e) {
      result = e?.code === 'STORE_SCHEDULER_BUSY' ? 'busy' : 'error';
      err = e?.code ?? e?.name;
    }
    events.push({
      kind: 'metrics',
      t: t0 - world.t0,
      ms: performance.now() - t0,
      result,
      err,
    });
  };
  const countOnce = () => {
    const t0 = performance.now();
    let fields;
    try {
      fields = deps.probeQuads.requestExternalStoreQuads(countAgent, Date.now());
    } catch (e) {
      fields = { error: e?.code ?? e?.name };
    }
    events.push({
      kind: 'count-request',
      t: t0 - world.t0,
      ms: performance.now() - t0,
      result: fields?.storeQuadsStatus ?? fields?.error ?? 'n/a',
      refreshing: fields?.storeQuadsRefreshing ?? null,
    });
  };
  const loop = (times, fn) =>
    (async () => {
      for (let k = 0; k < times.length && !stopped; k++) {
        for (let now = tRel(); times[k] > now && !stopped; now = tRel()) await sleep(Math.min(times[k] - now, 50));
        if (stopped) break;
        track(Promise.resolve().then(fn));
      }
    })();
  const schedule = {
    status: fixedSchedule(cfg.statusMs, cfg.statusPhaseMs ?? LOAD_DEFAULTS.statusPhaseMs, cfg.horizonMs),
    metrics: fixedSchedule(cfg.metricsMs, cfg.metricsPhaseMs ?? LOAD_DEFAULTS.metricsPhaseMs, cfg.horizonMs),
    count: fixedSchedule(cfg.countMs, cfg.countPhaseMs ?? LOAD_DEFAULTS.countPhaseMs, cfg.horizonMs),
  };
  const loops = [
    loop(schedule.status, statusOnce),
    loop(schedule.metrics, metricsOnce),
    loop(schedule.count, countOnce),
  ];
  return {
    state: { events, counters, schedule },
    stop() {
      stopped = true;
    },
    async drain(capMs) {
      await Promise.allSettled(loops);
      // the probes in flight and the store queries behind them (tracked by withTrackedQueries): a status probe returns
      // 'no-answer' to its caller after 5 s while its ASK runs on, so the probe settling is not the query settling.
      // A tracked query can start after a snapshot of the set (the probe that issues it is still in the set, so the
      // loop looks again when that settles); the cap bounds the wait in all, and its timer does not outlive the work
      const deadline = performance.now() + capMs;
      for (let left = capMs; inflight.size > 0 && left > 0; left = deadline - performance.now())
        await within(Promise.allSettled(inflight), left);
      return inflight.size;
    },
  };
}

/**
 * One synthetic graph-scoped storage ACK (8 operations, priority 'ack'); k = its sequence number. onOp(source, ms, ok,
 * startedAt) sees every operation as the caller experienced it, with the performance.now() it started at: an ACK takes
 * as long as its operations queue, so an operation's start is not its ACK's. onOpStart(source, startedAt) sees each
 * operation as it is issued, so an operation that never returns is still known to be running.
 */
export async function ackOnce(store, deleteByPatternWithoutCount, k, payload, onOp = () => {}, onOpStart = () => {}) {
  const slot = k % 16;
  const kaUal = `did:dkg:31337/0x3420aaaa00000000000000000000000000000000/${9000 + slot}`;
  const meta = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
  const swm = `did:dkg:context-graph:${CG_ID}/_shared_memory/ack-${slot}`;
  const head = `urn:dkg:workspace-head:${encodeURIComponent(kaUal)}`;
  const opSubject = `urn:dkg:share:${CG_ID}:ack-${k}`;
  const opt = (i) => ({ priority: 'ack', source: ACK_SOURCES[i] });
  const step = async (i, call) => {
    const t0 = performance.now();
    onOpStart(ACK_SOURCES[i], t0);
    try {
      await call(opt(i));
      onOp(ACK_SOURCES[i], performance.now() - t0, true, t0);
    } catch (e) {
      onOp(ACK_SOURCES[i], performance.now() - t0, false, t0);
      throw e;
    }
  };
  await step(0, (o) => store.query(`SELECT ?p ?o WHERE { GRAPH <${meta}> { <${head}> ?p ?o } }`, o));
  await step(1, (o) =>
    store.replaceGraph(
      swm,
      Array.from({ length: payload }, (_, i) => ({
        subject: `urn:aqc:ack:${slot}:${i}`,
        predicate: 'http://schema.org/name',
        object: lit(`ack ${k}-${i}`),
        graph: swm,
      })),
      o,
    ),
  );
  await step(2, (o) => deleteByPatternWithoutCount(store, { graph: WITNESS_GRAPH, subject: swm }, o));
  await step(3, (o) => deleteByPatternWithoutCount(store, { graph: meta, subject: opSubject }, o));
  await step(4, (o) =>
    store.insert(
      Array.from({ length: 16 }, (_, i) => ({
        subject: opSubject,
        predicate: `${DKG}ackMeta${i}`,
        object: lit(`v${i}-${k}`),
        graph: meta,
      })),
      o,
    ),
  );
  await step(5, (o) => deleteByPatternWithoutCount(store, { graph: meta, subject: head }, o));
  await step(6, (o) =>
    store.insert(
      ['contentScopeVersion', 'kaUal', 'assertionVersion', 'assertionGraph', 'shareOperationId'].map((p, i) => ({
        subject: head,
        predicate: `${DKG}${p}`,
        object: lit(`h${i}-${k}`),
        graph: meta,
      })),
      o,
    ),
  );
  await step(7, (o) =>
    store.update(
      `DELETE { GRAPH <${ACK_LEDGER_GRAPH}> { <${opSubject}> ?p ?o } } INSERT { GRAPH <${ACK_LEDGER_GRAPH}> { ` +
        `<${opSubject}> <${DKG}signedAt> ${lit(new Date().toISOString())} . <${opSubject}> <${DKG}kaUal> <${kaUal}> } } ` +
        `WHERE { OPTIONAL { GRAPH <${ACK_LEDGER_GRAPH}> { <${opSubject}> ?p ?o } } }`,
      { ...o, touchedGraphs: [ACK_LEDGER_GRAPH] },
    ),
  );
}

/**
 * The synthetic ACK stream (call it after beginEpoch): one ACK every cfg.intervalMs, one at a time, so an ACK still
 * running delays the next (recorded as start lateness). Returns { state, stop(), drain(capMs) }; state.events is
 * [{ k, due, t, lateMs, ms, ok, err }] and state.opEvents [{ k, source, t, ms, ok }], t run-relative: an event's own
 * start, so an operation's t is when that operation began, not when its ACK did.
 * drain(capMs) waits at most capMs for the running ACK. One still running then is the slowest work of the run and has no
 * event of its own, so the drain gives it one: the ACK and the operation it is in are recorded as CENSORED at the moment
 * the drain gave up (ms = how long they had run, a lower bound; ok false, err 'UNFINISHED_AT_DRAIN', unfinished true),
 * and anything the stuck work records after that is dropped, so it is counted once. It returns how many ACKs it
 * left unfinished (0 or 1: they run one at a time).
 */
export function startAckLoad(world, { deleteByPatternWithoutCount }, cfg) {
  const { store } = world;
  const state = {
    events: [],
    opEvents: [],
    schedule: fixedSchedule(cfg.intervalMs, cfg.phaseMs ?? LOAD_DEFAULTS.ackPhaseMs, cfg.horizonMs),
  };
  let stopped = false;
  let closed = false; // the drain gave up: what the work still running records from then on is not recorded
  let running = null; // the ACK being run: { k, due, t0, op: the operation it is in, or null }
  const loop = (async () => {
    for (let k = 0; k < state.schedule.length && !stopped; k++) {
      const due = state.schedule[k];
      for (let now = performance.now() - world.t0; due > now && !stopped; now = performance.now() - world.t0)
        await sleep(Math.min(due - now, 50));
      if (stopped) break;
      const t0 = performance.now();
      const ack = (running = { k, due, t0, op: null });
      let ok = true;
      let err;
      try {
        await ackOnce(
          store,
          deleteByPatternWithoutCount,
          k,
          cfg.payload,
          (source, ms, opOk, startedAt) => {
            ack.op = null;
            if (!closed) state.opEvents.push({ k, source, t: startedAt - world.t0, ms, ok: opOk });
          },
          (source, startedAt) => {
            ack.op = { source, startedAt };
          },
        );
      } catch (e) {
        ok = false;
        err = e?.code ?? e?.name;
      }
      running = null;
      if (!closed)
        state.events.push({
          k,
          due,
          t: t0 - world.t0,
          lateMs: t0 - world.t0 - due,
          ms: performance.now() - t0,
          ok,
          err,
        });
    }
  })();
  return {
    state,
    stop() {
      stopped = true;
    },
    async drain(capMs) {
      const finished = Symbol('finished');
      if ((await within(loop.then(() => finished), capMs)) === finished) return 0;
      const at = performance.now();
      closed = true;
      stopped = true;
      const ack = running;
      if (!ack) return 0;
      if (ack.op)
        state.opEvents.push({
          k: ack.k,
          source: ack.op.source,
          t: ack.op.startedAt - world.t0,
          ms: at - ack.op.startedAt,
          ok: false,
          unfinished: true,
        });
      state.events.push({
        k: ack.k,
        due: ack.due,
        t: ack.t0 - world.t0,
        lateMs: ack.t0 - world.t0 - ack.due,
        ms: at - ack.t0,
        ok: false,
        err: 'UNFINISHED_AT_DRAIN',
        unfinished: true,
      });
      return 1;
    },
  };
}

/**
 * The two loads over [from, to) (run-relative ms, by event start). Pure.
 *   probes.latencyMs   caller-visible latency of every status probe and every metrics probe the store answered, among
 *                      those that started in the window (a status probe is capped at the product's 5 s wait by
 *                      construction). A metrics sample the product answered locally (result 'reconciled', see the top)
 *                      never reached the store: it is counted in nMetrics and nMetricsReconciled and is in no latency
 *                      and no noAnswer
 *   probes.noAnswer    status probes answered 'no-answer' plus metrics probes that took over 5 s or were rejected busy
 *   ack.opMs           caller-visible duration of every ACK operation that started in the window (queue wait included);
 *                      an operation is in the window by its OWN start, whichever window its ACK started in
 *   ack.acksStarted    ACKs started in the window; ackMs their whole-sequence duration
 *   ack.acksUnfinished ACKs the drain left running, WHATEVER window they started in (startAckLoad's drain records them
 *                      as censored): the ones that started in the window are in acksStarted and their censored
 *                      duration in ackMs, the operation each was in is in ops, opMs and opsUnfinished (by its own
 *                      start). An unfinished ACK is not a failed one: acksFailed and opsFailed leave it out
 */
export function probeAckSummary({ probeState, ackState, from, to }) {
  const inWindow = (t) => t >= from && t < to;
  const pe = (probeState?.events ?? []).filter((e) => inWindow(e.t));
  const status = pe.filter((e) => e.kind === 'status');
  const metrics = pe.filter((e) => e.kind === 'metrics');
  const reconciled = metrics.filter((e) => e.result === 'reconciled');
  const storeMetrics = metrics.filter((e) => e.result !== 'reconciled');
  const noAnswerStatus = status.filter((e) => e.result === 'no-answer').length;
  const noAnswerMetrics = storeMetrics.filter((e) => e.ms > NO_ANSWER_MS || e.result === 'busy').length;
  const counts = (events) => events.reduce((acc, e) => ({ ...acc, [e.result]: (acc[e.result] ?? 0) + 1 }), {});
  const acks = (ackState?.events ?? []).filter((e) => inWindow(e.t));
  const ackOps = (ackState?.opEvents ?? []).filter((e) => inWindow(e.t));
  return {
    probes: {
      on: Boolean(probeState),
      n: status.length + metrics.length,
      nStatus: status.length,
      nMetrics: metrics.length,
      nMetricsReconciled: reconciled.length,
      nCountRequests: pe.filter((e) => e.kind === 'count-request').length,
      latencyMs: summarize([...status, ...storeMetrics].map((e) => e.ms)),
      statusLatencyMs: summarize(status.map((e) => e.ms)),
      metricsLatencyMs: summarize(storeMetrics.map((e) => e.ms)),
      noAnswer: noAnswerStatus + noAnswerMetrics,
      noAnswerStatus,
      noAnswerMetrics,
      statusResults: counts(status),
      metricsResults: counts(metrics),
      reconcilesStubbed: probeState?.counters?.reconcilesStubbed ?? null,
    },
    ack: {
      on: Boolean(ackState),
      acksStarted: acks.length,
      acksFailed: acks.filter((e) => !e.ok && !e.unfinished).length,
      acksUnfinished: (ackState?.events ?? []).filter((e) => e.unfinished).length,
      ackMs: summarize(acks.map((e) => e.ms)),
      startLatenessMs: summarize(acks.map((e) => Math.max(0, e.lateMs))),
      ops: ackOps.length,
      opsFailed: ackOps.filter((e) => !e.ok && !e.unfinished).length,
      opsUnfinished: ackOps.filter((e) => e.unfinished).length,
      opMs: summarize(ackOps.map((e) => e.ms)),
      bySource: ackOps.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {}),
    },
  };
}
