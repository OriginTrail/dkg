// The background load G0 and G0b ran with in every arm (OT-RFC-73 P2b, ported from harness 0.8/0.9): the daemon's
// health-lane status probes and a synthetic storage-ACK stream, both against the same store and default scheduler as the
// queues, so a queue path that crowds out ACK or health work shows up. The product comes in through `deps`
// (backend.mjs loadDist), so this file is import-safe.
//
// Health lane: the three store calls the daemon makes on the health lane, issued through the PRODUCT functions (no copy
// of their query text, options or decision logic):
//   daemon.status.storeProbe     probeExternalStore(agent): ASK, the caller waits at most 5 s and gets 'no-answer'
//                                (also when the scheduler rejects it); concurrent callers share the running probe
//   daemon.status.storeQuads     requestExternalStoreQuads(agent, now): the full-store COUNT, started in the background
//                                unless a result younger than 30 s is cached or one is running
//   daemon.metrics.storeHealth   createStoreCountMetrics(query).getStoreCountSnapshot(): ASK {}, on every read that
//                                reuses a reconciled snapshot. The one reconcile it needs first (background lane,
//                                source daemon.metrics.storeCountReconcile, at most once per 5 min in production) is
//                                answered locally and counted: it is not a health-lane call.
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
import { setTimeout as sleep } from 'node:timers/promises';
import { CG_ID } from './fixture.mjs';
import { summarize } from './verdict.mjs';

export const PROBE_RECONCILE_SOURCE = 'daemon.metrics.storeCountReconcile';
/** store-reachability.ts STORE_PROBE_WAIT_MS: a status probe that has not answered by then reports 'no-answer'. */
export const NO_ANSWER_MS = 5000;
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
    const r = await store.query(sparql, options);
    if (r?.type === 'boolean') return { bindings: [{ result: String(r.value) }] };
    return { bindings: r?.bindings ?? [] };
  };
}

/**
 * Starts the probe load (call it after beginEpoch). deps = the loaded dist; cfg = { statusMs, metricsMs, countMs,
 * horizonMs } with 0 switching a probe off, and optional phases. Returns { state, stop(), drain(capMs) }; state.events
 * is [{ kind: 'status' | 'metrics' | 'count-request', t, ms, result, err }], t run-relative.
 */
export async function startProbeLoad(world, deps, cfg) {
  const { store } = world;
  const agent = { store };
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
  const statusOnce = async () => {
    const t0 = performance.now();
    let result;
    let err;
    try {
      result = await deps.probeReach.probeExternalStore(agent);
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
    try {
      await metrics.getStoreCountSnapshot();
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
      fields = deps.probeQuads.requestExternalStoreQuads(agent, Date.now());
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
      await Promise.race([Promise.allSettled(inflight), sleep(capMs)]);
      return inflight.size;
    },
  };
}

/**
 * One synthetic graph-scoped storage ACK (8 operations, priority 'ack'); k = its sequence number. onOp(source, ms, ok)
 * sees every operation as the caller experienced it.
 */
export async function ackOnce(store, deleteByPatternWithoutCount, k, payload, onOp = () => {}) {
  const slot = k % 16;
  const kaUal = `did:dkg:31337/0x3420aaaa00000000000000000000000000000000/${9000 + slot}`;
  const meta = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
  const swm = `did:dkg:context-graph:${CG_ID}/_shared_memory/ack-${slot}`;
  const head = `urn:dkg:workspace-head:${encodeURIComponent(kaUal)}`;
  const opSubject = `urn:dkg:share:${CG_ID}:ack-${k}`;
  const opt = (i) => ({ priority: 'ack', source: ACK_SOURCES[i] });
  const step = async (i, call) => {
    const t0 = performance.now();
    try {
      await call(opt(i));
      onOp(ACK_SOURCES[i], performance.now() - t0, true);
    } catch (e) {
      onOp(ACK_SOURCES[i], performance.now() - t0, false);
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
 * [{ k, due, t, lateMs, ms, ok, err }] and state.opEvents [{ k, source, t, ms, ok }], t run-relative.
 */
export function startAckLoad(world, { deleteByPatternWithoutCount }, cfg) {
  const { store } = world;
  const state = {
    events: [],
    opEvents: [],
    schedule: fixedSchedule(cfg.intervalMs, cfg.phaseMs ?? LOAD_DEFAULTS.ackPhaseMs, cfg.horizonMs),
  };
  let stopped = false;
  const loop = (async () => {
    for (let k = 0; k < state.schedule.length && !stopped; k++) {
      const due = state.schedule[k];
      for (let now = performance.now() - world.t0; due > now && !stopped; now = performance.now() - world.t0)
        await sleep(Math.min(due - now, 50));
      if (stopped) break;
      const t0 = performance.now();
      let ok = true;
      let err;
      try {
        await ackOnce(store, deleteByPatternWithoutCount, k, cfg.payload, (source, ms, opOk) =>
          state.opEvents.push({ k, source, t: t0 - world.t0, ms, ok: opOk }),
        );
      } catch (e) {
        ok = false;
        err = e?.code ?? e?.name;
      }
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
      await Promise.race([loop, sleep(capMs)]);
    },
  };
}

/**
 * The two loads over [from, to) (run-relative ms, by event start). Pure.
 *   probes.latencyMs   caller-visible latency of every status and metrics probe that started in the window (a status
 *                      probe is capped at the product's 5 s wait by construction)
 *   probes.noAnswer    status probes answered 'no-answer' plus metrics probes that took over 5 s or were rejected busy
 *   ack.opMs           caller-visible duration of every ACK operation that started in the window (queue wait included)
 *   ack.acksStarted    ACKs started in the window; ackMs their whole-sequence duration
 */
export function probeAckSummary({ probeState, ackState, from, to }) {
  const inWindow = (t) => t >= from && t < to;
  const pe = (probeState?.events ?? []).filter((e) => inWindow(e.t));
  const status = pe.filter((e) => e.kind === 'status');
  const metrics = pe.filter((e) => e.kind === 'metrics');
  const noAnswerStatus = status.filter((e) => e.result === 'no-answer').length;
  const noAnswerMetrics = metrics.filter((e) => e.ms > NO_ANSWER_MS || e.result === 'busy').length;
  const counts = (events) => events.reduce((acc, e) => ({ ...acc, [e.result]: (acc[e.result] ?? 0) + 1 }), {});
  const acks = (ackState?.events ?? []).filter((e) => inWindow(e.t));
  const ackOps = (ackState?.opEvents ?? []).filter((e) => inWindow(e.t));
  return {
    probes: {
      on: Boolean(probeState),
      n: status.length + metrics.length,
      nStatus: status.length,
      nMetrics: metrics.length,
      nCountRequests: pe.filter((e) => e.kind === 'count-request').length,
      latencyMs: summarize([...status, ...metrics].map((e) => e.ms)),
      statusLatencyMs: summarize(status.map((e) => e.ms)),
      metricsLatencyMs: summarize(metrics.map((e) => e.ms)),
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
      acksFailed: acks.filter((e) => !e.ok).length,
      ackMs: summarize(acks.map((e) => e.ms)),
      startLatenessMs: summarize(acks.map((e) => Math.max(0, e.lateMs))),
      ops: ackOps.length,
      opsFailed: ackOps.filter((e) => !e.ok).length,
      opMs: summarize(ackOps.map((e) => e.ms)),
      bySource: ackOps.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {}),
    },
  };
}
