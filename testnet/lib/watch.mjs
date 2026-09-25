// OT-RFC-61 §8 S3 — abort-trip evaluation + quiesce controller.
// Implements the Phase 0 contract; exported signatures are frozen.
// Hygiene (S6): everything emitted here identifies cores by ALIAS only.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ABORT_FILE = 'safety-abort.json';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function tsMs(ts) {
  if (isNum(ts)) return ts;
  const ms = Date.parse(ts ?? '');
  if (!Number.isFinite(ms)) throw new TypeError(`watch: snapshot ts unparseable: ${JSON.stringify(ts)}`);
  return ms;
}

/** Accept either a fleet snapshot ({ts, kind, cores}) or a baseline wrapper ({snapshot, ...}). */
function coresOf(s) {
  if (Array.isArray(s?.cores)) return s.cores;
  if (Array.isArray(s?.snapshot?.cores)) return s.snapshot.cores;
  return [];
}

function tripCfg(policy, name) {
  const cfg = policy?.trips?.[name];
  if (!cfg || typeof cfg !== 'object') {
    // Policy is validated upstream (config.loadPolicy requires every trip):
    // a missing trip block here is a config bug, not a runtime condition.
    throw new Error(`watch: policy.trips.${name} missing — S3 trips are mandatory`);
  }
  return cfg;
}

/** Effective threshold: loadPolicy/scenario tightening may set .value; else .default. */
function tripValue(cfg) {
  return cfg.value !== undefined ? cfg.value : cfg.default;
}

function coreIn(snap, alias) {
  return coresOf(snap).find((c) => c?.alias === alias);
}

/**
 * Evaluate all S3 trips against the latest fleet snapshot + edge-side counters.
 * FAIL-CLOSED: a signal that is missing/unreadable (undefined/NaN) for a core
 * reachable in `snapshot` fires its trip with reason 'signal-unavailable'.
 * Trips (policy.trips keys):
 *  - memoryPsiSomeAvg10 (sustained — fires only when every snapshot in
 *    [snapshotHistory..snapshot] covering sustainSec exceeds the threshold)
 *  - memoryCurrentVsHighFraction (ceiling = memory.high, else memory.max)
 *  - oomKillDelta (vs baseline)
 *  - coreUnreachableFromBaseline (ANY baseline-reachable core lost)
 *  - acceptQueueRecvQAtBacklog (or consecutiveProbeFailures consecutive
 *    connect-probe failures across the trailing snapshots)
 *  - diskFreeFloorBytes / diskFreeFloorFraction
 *  - admissionShedFractionOfAttempts over admissionShedWindowSec (edge-side)
 *    OR fleet /api/status admission-rejection delta vs baseline (either fires;
 *    the fleet-delta threshold is scenario-declared via the optional
 *    policy.trips.admissionShedFractionOfAttempts.fleetDeltaPerRun — absent =>
 *    fleet source not configured, edge window still watched)
 *  - rpcExhaustionDeltaPerRun (fleet /api/status exhaustion+failover counters
 *    vs baseline)
 * @param {{
 *   policy: object, baseline: object, snapshot: object,
 *   snapshotHistory: object[], edgeWindow: {attempts: number, shed: number, windowSec: number}
 * }} p
 * @returns {Array<{trip: string, alias?: string, observed: any, threshold: any, reason?: string}>} fired trips ([] = healthy)
 */
export function evaluateTrips(p) {
  const { policy, baseline, snapshot, edgeWindow } = p ?? {};
  if (!policy?.trips) throw new TypeError('evaluateTrips: policy.trips required');
  if (!snapshot) throw new TypeError('evaluateTrips: snapshot required');
  const history = Array.isArray(p.snapshotHistory) ? p.snapshotHistory : [];

  const fired = [];
  const unavailable = (trip, alias, threshold) => {
    fired.push({ trip, alias, observed: null, threshold, reason: 'signal-unavailable' });
  };

  const baseCores = new Map(coresOf(baseline).map((c) => [c.alias, c]));
  const curCores = coresOf(snapshot);
  const curByAlias = new Map(curCores.map((c) => [c.alias, c]));
  const curTs = tsMs(snapshot.ts);
  const timeline = history
    .filter((s) => s && s !== snapshot)
    .concat([snapshot])
    .map((s) => ({ ms: tsMs(s.ts), s }))
    .filter((e) => e.ms <= curTs)
    .sort((a, b) => a.ms - b.ms);

  // ── coreUnreachableFromBaseline — ANY baseline-reachable core lost.
  const unreachCfg = tripCfg(policy, 'coreUnreachableFromBaseline');
  const unreachThresh = tripValue(unreachCfg);
  const lost = [];
  for (const [alias, b] of baseCores) {
    if (b.reachable === false) continue;
    const cur = curByAlias.get(alias);
    if (!cur || cur.reachable === false) lost.push(alias);
  }
  if (lost.length >= unreachThresh) {
    for (const alias of lost) {
      fired.push({
        trip: 'coreUnreachableFromBaseline', alias,
        observed: lost.length, threshold: unreachThresh,
        reason: 'baseline-reachable core unreachable during workload',
      });
    }
  }

  // Per-core signal trips run only over cores reachable NOW (an unreachable
  // core already fired its own trip above — the primary signal for that state).
  const reachable = curCores.filter((c) => c && c.reachable !== false);

  // ── memoryPsiSomeAvg10 (sustained)
  const psiCfg = tripCfg(policy, 'memoryPsiSomeAvg10');
  const psiThresh = tripValue(psiCfg);
  const sustainMs = (isNum(psiCfg.sustainSec) ? psiCfg.sustainSec : 60) * 1000;
  for (const c of reachable) {
    const psi = c.cgroup?.psiSomeAvg10;
    if (!isNum(psi)) { unavailable('memoryPsiSomeAvg10', c.alias, psiThresh); continue; }
    if (psi <= psiThresh) continue;
    // Walk backwards over consecutive exceeding snapshots; sustained iff the
    // exceedance chain spans >= sustainSec ending at the current snapshot.
    let earliest = curTs;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const v = coreIn(timeline[i].s, c.alias)?.cgroup?.psiSomeAvg10;
      if (!isNum(v) || v <= psiThresh) break;
      earliest = timeline[i].ms;
    }
    if (curTs - earliest >= sustainMs) {
      fired.push({
        trip: 'memoryPsiSomeAvg10', alias: c.alias, observed: psi, threshold: psiThresh,
        reason: `memory PSI some avg10 > ${psiThresh} sustained >= ${sustainMs / 1000}s`,
      });
    }
  }

  // ── memoryCurrentVsHighFraction
  const memFracCfg = tripCfg(policy, 'memoryCurrentVsHighFraction');
  const memFracThresh = tripValue(memFracCfg);
  for (const c of reachable) {
    const cur = c.cgroup?.memoryCurrent;
    const high = c.cgroup?.memoryHigh;
    const ceiling = isNum(high) && high > 0 ? high : c.cgroup?.memoryMax;
    if (!isNum(cur) || !isNum(ceiling) || ceiling <= 0) {
      unavailable('memoryCurrentVsHighFraction', c.alias, memFracThresh);
      continue;
    }
    const frac = cur / ceiling;
    if (frac >= memFracThresh) {
      fired.push({
        trip: 'memoryCurrentVsHighFraction', alias: c.alias,
        observed: frac, threshold: memFracThresh,
        reason: 'memory.current within trip fraction of effective ceiling',
      });
    }
  }

  // ── oomKillDelta (vs baseline)
  const oomCfg = tripCfg(policy, 'oomKillDelta');
  const oomThresh = tripValue(oomCfg);
  for (const c of reachable) {
    const curOom = c.cgroup?.oomKills;
    const baseOom = baseCores.get(c.alias)?.cgroup?.oomKills;
    if (!isNum(curOom) || !isNum(baseOom)) { unavailable('oomKillDelta', c.alias, oomThresh); continue; }
    const delta = curOom - baseOom;
    if (delta > oomThresh) {
      fired.push({
        trip: 'oomKillDelta', alias: c.alias, observed: delta, threshold: oomThresh,
        reason: 'cgroup oom_kill counter grew during workload',
      });
    }
  }

  // ── acceptQueueRecvQAtBacklog (+ consecutive connect-probe failures)
  const aqCfg = tripCfg(policy, 'acceptQueueRecvQAtBacklog');
  if (tripValue(aqCfg)) {
    const probeN = isNum(aqCfg.consecutiveProbeFailures) ? aqCfg.consecutiveProbeFailures : 3;
    for (const c of reachable) {
      const l = c.listen;
      if (!l || !isNum(l.recvQ) || !isNum(l.backlog) || typeof l.connectProbeOk !== 'boolean') {
        unavailable('acceptQueueRecvQAtBacklog', c.alias, true);
        continue;
      }
      if (l.backlog > 0 && l.recvQ >= l.backlog) {
        fired.push({
          trip: 'acceptQueueRecvQAtBacklog', alias: c.alias,
          observed: { recvQ: l.recvQ, backlog: l.backlog }, threshold: true,
          reason: 'listener Recv-Q at backlog',
        });
        continue;
      }
      const lastN = timeline.slice(-probeN);
      const allFailed = lastN.length >= probeN
        && lastN.every(({ s }) => coreIn(s, c.alias)?.listen?.connectProbeOk === false);
      if (allFailed) {
        fired.push({
          trip: 'acceptQueueRecvQAtBacklog', alias: c.alias,
          observed: { consecutiveProbeFailures: probeN }, threshold: true,
          reason: `connect probe failed ${probeN} consecutive polls`,
        });
      }
    }
  }

  // ── disk floors
  const diskBytesCfg = tripCfg(policy, 'diskFreeFloorBytes');
  const diskBytesFloor = tripValue(diskBytesCfg);
  const diskFracCfg = tripCfg(policy, 'diskFreeFloorFraction');
  const diskFracFloor = tripValue(diskFracCfg);
  for (const c of reachable) {
    const d = c.diskFree;
    if (!d || !isNum(d.bytes)) unavailable('diskFreeFloorBytes', c.alias, diskBytesFloor);
    else if (d.bytes < diskBytesFloor) {
      fired.push({
        trip: 'diskFreeFloorBytes', alias: c.alias, observed: d.bytes, threshold: diskBytesFloor,
        reason: 'store filesystem free space below byte floor',
      });
    }
    if (!d || !isNum(d.fraction)) unavailable('diskFreeFloorFraction', c.alias, diskFracFloor);
    else if (d.fraction < diskFracFloor) {
      fired.push({
        trip: 'diskFreeFloorFraction', alias: c.alias, observed: d.fraction, threshold: diskFracFloor,
        reason: 'store filesystem free space below fractional floor',
      });
    }
  }

  // ── admission shed — edge-side window AND fleet counter delta; either fires.
  const shedCfg = tripCfg(policy, 'admissionShedFractionOfAttempts');
  const shedThresh = tripValue(shedCfg);
  const shedWindowSec = tripValue(tripCfg(policy, 'admissionShedWindowSec'));
  if (edgeWindow && isNum(edgeWindow.attempts) && edgeWindow.attempts > 0) {
    const frac = (isNum(edgeWindow.shed) ? edgeWindow.shed : 0) / edgeWindow.attempts;
    if (frac > shedThresh) {
      fired.push({
        trip: 'admissionShedFractionOfAttempts',
        observed: frac, threshold: shedThresh,
        reason: `edge-side shed ${edgeWindow.shed}/${edgeWindow.attempts} attempts over ${edgeWindow.windowSec ?? shedWindowSec}s window`,
      });
    }
  }
  const fleetShedThresh = shedCfg.fleetDeltaPerRun; // scenario-declared (S3); optional
  if (isNum(fleetShedThresh)) {
    let delta = 0;
    for (const c of reachable) {
      const cur = c.api?.admissionRejected;
      const base = baseCores.get(c.alias)?.api?.admissionRejected;
      if (!isNum(cur) || !isNum(base)) {
        unavailable('admissionShedFractionOfAttempts', c.alias, fleetShedThresh);
        continue;
      }
      delta += cur - base;
    }
    if (delta > fleetShedThresh) {
      fired.push({
        trip: 'admissionShedFractionOfAttempts',
        observed: delta, threshold: fleetShedThresh,
        reason: 'fleet admission-rejection counter delta exceeded scenario-declared rate',
      });
    }
  }

  // ── rpcExhaustionDeltaPerRun — fleet-wide exhaustion(+failover) counter delta.
  const rpcCfg = tripCfg(policy, 'rpcExhaustionDeltaPerRun');
  const rpcThresh = tripValue(rpcCfg);
  const rpcCount = (core) => {
    const a = core?.api;
    if (!a || !isNum(a.rpcExhaustions)) return null;
    return a.rpcExhaustions + (isNum(a.rpcFailovers) ? a.rpcFailovers : 0);
  };
  let rpcDelta = 0;
  for (const c of reachable) {
    const cur = rpcCount(c);
    const base = rpcCount(baseCores.get(c.alias));
    if (cur === null || base === null) { unavailable('rpcExhaustionDeltaPerRun', c.alias, rpcThresh); continue; }
    rpcDelta += cur - base;
  }
  if (rpcDelta > rpcThresh) {
    fired.push({
      trip: 'rpcExhaustionDeltaPerRun', observed: rpcDelta, threshold: rpcThresh,
      reason: 'fleet RPC failover/exhaustion counter delta exceeded per-run threshold',
    });
  }

  return fired;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Quiesce controller (S3): stop submitting; cancel/abandon in-flight client
 * operations via the provided handles (Promise.allSettled — a hung cancel is
 * bounded by policy.quiesce.cancelTimeoutSec, default 30); stop the local edge
 * daemon(s) via their stop() within policy.quiesce.edgeShutdownTimeoutSec (an
 * edge without stop() is skipped and reported edgeShutdown:false); then poll
 * confirmFlat() until policy.quiesce.flatCounterConfirmSec of CONSECUTIVE flat
 * readings, or until policy.quiesce.flatConfirmTimeoutSec (default
 * 3×flatCounterConfirmSec + 60) elapses. A confirmFlat error counts as
 * not-flat (fail closed). NEVER touches fleet hosts.
 * Test seams (optional): _now, _sleep, _pollIntervalMs.
 * @param {{
 *   inflight: Array<{cancel: () => Promise<void>}>,
 *   edges: Array<object>, policy: object,
 *   confirmFlat: () => Promise<boolean>
 * }} p
 * @returns {Promise<{cancelled: number, edgeShutdown: boolean, flatConfirmed: boolean}>}
 */
export async function quiesce(p) {
  const { policy, confirmFlat } = p ?? {};
  const inflight = Array.isArray(p?.inflight) ? p.inflight : [];
  const edges = Array.isArray(p?.edges) ? p.edges : [];
  const nowFn = p?._now ?? Date.now;
  const sleepFn = p?._sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const intervalMs = isNum(p?._pollIntervalMs) ? p._pollIntervalMs : 1000;

  // 1. cancel in-flight client operations
  const cancelTimeoutMs = (isNum(policy?.quiesce?.cancelTimeoutSec) ? policy.quiesce.cancelTimeoutSec : 30) * 1000;
  const settled = await Promise.allSettled(inflight.map((h) => withTimeout(
    Promise.resolve().then(() => h.cancel()), cancelTimeoutMs, 'inflight cancel',
  )));
  const cancelled = settled.filter((r) => r.status === 'fulfilled').length;

  // 2. stop local edge daemons (where cancellation is unavailable, this is the stop)
  const shutdownMs = (isNum(policy?.quiesce?.edgeShutdownTimeoutSec) ? policy.quiesce.edgeShutdownTimeoutSec : 60) * 1000;
  let edgeShutdown = true;
  for (const edge of edges) {
    if (typeof edge?.stop !== 'function') { edgeShutdown = false; continue; }
    try {
      await withTimeout(Promise.resolve().then(() => edge.stop()), shutdownMs, 'edge stop');
    } catch {
      edgeShutdown = false;
    }
  }

  // 3. confirm flat counters for flatCounterConfirmSec consecutive seconds
  const confirmSec = isNum(policy?.quiesce?.flatCounterConfirmSec) ? policy.quiesce.flatCounterConfirmSec : 20;
  const confirmMs = confirmSec * 1000;
  const timeoutMs = (isNum(policy?.quiesce?.flatConfirmTimeoutSec)
    ? policy.quiesce.flatConfirmTimeoutSec : confirmSec * 3 + 60) * 1000;
  let flatConfirmed = false;
  if (typeof confirmFlat === 'function') {
    const deadline = nowFn() + timeoutMs;
    let flatSince = null;
    while (nowFn() <= deadline) {
      let flat = false;
      try { flat = (await confirmFlat()) === true; } catch { flat = false; }
      const t = nowFn();
      if (flat) {
        if (flatSince === null) flatSince = t;
        if (t - flatSince >= confirmMs) { flatConfirmed = true; break; }
      } else {
        flatSince = null;
      }
      await sleepFn(intervalMs);
    }
  }

  return { cancelled, edgeShutdown, flatConfirmed };
}

/**
 * SAFETY_ABORT bookkeeping: persist runs/safety-abort.json {ts, runId, trips,
 * cooldownUntil} and refuse new load-generating runs until cooldownUntil passes
 * or the file is removed by the operator (manual clearance). Returns the record.
 * @param {{runsDir: string, runId: string, trips: object[], policy: object, _now?: () => number}} p
 */
export function recordSafetyAbort(p) {
  const { runsDir, runId, trips, policy } = p ?? {};
  if (typeof runsDir !== 'string' || runsDir.length === 0) throw new TypeError('recordSafetyAbort: runsDir required');
  if (typeof runId !== 'string' || runId.length === 0) throw new TypeError('recordSafetyAbort: runId required');
  const now = typeof p._now === 'function' ? p._now() : Date.now();
  const cooldownMin = isNum(policy?.safetyAbort?.cooldownMin) ? policy.safetyAbort.cooldownMin : 60;
  const record = {
    ts: new Date(now).toISOString(),
    runId,
    trips: Array.isArray(trips) ? trips : [],
    cooldownUntil: new Date(now + cooldownMin * 60_000).toISOString(),
  };
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, ABORT_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Check the cooldown gate before a load-generating run. Missing file =>
 * unblocked; unreadable/corrupt file or unparseable cooldownUntil => BLOCKED
 * (fail closed — the operator clears by removing the file). Returns
 * {blocked: boolean, until?: string}. @param {{runsDir: string, _now?: () => number}} p */
export function safetyAbortGate(p) {
  const file = join(p.runsDir, ABORT_FILE);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { blocked: false };
    return { blocked: true };
  }
  let record;
  try { record = JSON.parse(raw); } catch { return { blocked: true }; }
  const until = record?.cooldownUntil;
  const untilMs = Date.parse(until ?? '');
  if (!Number.isFinite(untilMs)) return { blocked: true };
  const now = typeof p._now === 'function' ? p._now() : Date.now();
  return now < untilMs ? { blocked: true, until } : { blocked: false };
}
