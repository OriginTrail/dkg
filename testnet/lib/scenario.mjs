// OT-RFC-61 §4.2/§5 — scenario runner. Phase 0: the certify workload.
// Orchestrates: edge.mjs (ops) + fleet.mjs (snapshots) + watch.mjs (trips) +
// scoring.mjs (aggregates/gates) + evidence.mjs (records). bin/harness.mjs owns
// the outer mode dispatch; this module owns the workload loop.
//
// rfc59 provenance: runPublishScenario reproduces publishBurst/publishLanePair/
// pollFinalized + the certify branch of main(); mergePeak is the rfc59 mergePeak
// keyed by alias with attestation-based restart detection.

import os from 'node:os';

import * as edgeMod from './edge.mjs';
import * as fleetMod from './fleet.mjs';
import * as scoringMod from './scoring.mjs';
import { percentile as utilPercentile, sleep } from './util.mjs';
import * as watchMod from './watch.mjs';

function jobFailed(job) {
  if (!job) return true;
  const status = String(job.status || '').toLowerCase();
  return status === 'failed' || status === 'error' || job.error != null;
}

function jobErrorText(job) {
  return String(job?.error || job?.reason || job?.status || 'job_failed');
}

/**
 * rfc59 pollFinalized port over the new EdgeClient: poll authoritative KA state
 * (GET /api/knowledge-assets/:name) until memoryLayer=VM or the deadline.
 * deadlineMs <= now means exactly ONE authoritative read (used to re-score a
 * daemon-terminal job failure without a long poll).
 * Extra exported helper (additive to the frozen contract).
 * @param {object} edge EdgeClient
 * @param {{name: string, cg: string, deadlineMs: number, intervalMs?: number,
 *          _now?: () => number, _sleep?: (ms: number) => Promise<void>,
 *          isAborted?: () => boolean}} opts
 * @returns {Promise<{finalized: boolean, ual?: string|null, reservedUal?: string|null, tx?: string|null, reason?: string}>}
 */
export async function pollVmFinalized(edge, opts) {
  const { name, cg, deadlineMs, intervalMs = 1000, isAborted } = opts;
  const now = opts._now || Date.now;
  const zzz = opts._sleep || sleep;
  for (;;) {
    try {
      const s = await edge.knowledgeAssetState({ name, cg });
      const layer = String(s?.memoryLayer || '').toUpperCase();
      const events = (s?.events || []).map((e) => String(e.toLayer || e.type || '').toUpperCase());
      if (layer === 'VM' || events.some((e) => e === 'VM' || /FINALIZ/.test(e))) {
        // reservedUal is a prepublish identity; only publishedUal is on-chain.
        return {
          finalized: true,
          ual: s.publishedUal || null,
          reservedUal: s.reservedUal || null,
          tx: s.txHash || s.tx || null,
        };
      }
      if (/FAIL|ERROR|REVERT/i.test(String(s?.status || ''))) {
        return { finalized: false, reason: `state:${s.status}` };
      }
    } catch {
      /* keep polling until the authoritative deadline */
    }
    if (isAborted && isAborted()) return { finalized: false, reason: 'harness_quiesce' };
    const remaining = deadlineMs - now();
    if (remaining <= 0) break;
    await zzz(Math.min(intervalMs, remaining));
  }
  return { finalized: false, reason: 'vm_poll_timeout' };
}

/** Build the attestation-comparable shape from a fleet_snapshot per-core entry. */
export function attestationFromSnapshotCore(core) {
  return {
    alias: core.alias,
    commit: core.build?.commit ?? null,
    buildTime: core.build?.buildTime ?? null,
    workerPid: core.workerPid ?? null,
    workerStartTs: core.systemd?.execMainStartTs ?? null,
  };
}

/** One full KA lifecycle op: create → share → publish → VM finalization. */
async function runOneOp(ctx, lane, index, wave) {
  const { scenario, edge, evidence, runId, ctl, now, pollIntervalMs, opTimeoutMs } = ctx;
  const workload = scenario.workload || {};
  const cg = (scenario.cg || {})[lane];
  const payload = ctx.makePayload({
    runId,
    lane,
    index,
    controlFixtureEvery: workload.controlFixtureEvery ?? 10,
  });
  const name = `rfc61-${runId}-${lane}-${index}`;
  const durations = { create: null, share: null, publish: null, vm_finalization: null };
  const attempt = { ts: now(), shed: false };
  ctx.attemptsLog.push(attempt);
  const opState = { cancelled: false };
  const handle = { cancel: async () => { opState.cancelled = true; } };
  ctx.inflight.add(handle);

  const aborted = () => ctl.aborted || opState.cancelled;

  const finish = (outcome, reason, extra = {}) => {
    const record = {
      op: workload.op || 'publish',
      lane,
      cg,
      index,
      wave,
      name,
      subject: payload.subject,
      expected_object: payload.expectedObject,
      bytes: Buffer.byteLength(String(payload.quads || ''), 'utf8'),
      outcome,
      reason: reason ?? null,
      durations_ms: { ...durations },
      anchor_meta: { poll_interval_ms: pollIntervalMs },
      ual: extra.ual ?? null,
      tx: extra.tx ?? null,
      control_fixture: payload.controlFixture === true,
      recovered_after_client_error: extra.recovered === true,
    };
    if (outcome === 'admission_shed') attempt.shed = true;
    evidence.write('op_result', record);
    ctx.opResults.push(record);
    return record;
  };

  let phase = 'create';
  let phaseStart = now();
  try {
    if (aborted()) return finish('aborted', 'harness_quiesce');
    await edge.createKnowledgeAsset({ name, cg, quads: payload.quads });
    durations.create = now() - phaseStart;

    phase = 'share';
    if (aborted()) return finish('aborted', 'harness_quiesce');
    phaseStart = now();
    const shareJob = await edge.shareAsync({ name, cg });
    const shared = await edge.waitShareJob({
      jobId: shareJob.jobId, timeoutMs: opTimeoutMs, intervalMs: pollIntervalMs,
    });
    durations.share = now() - phaseStart;
    if (jobFailed(shared)) {
      // Create/share failures have no publish to recover (rfc59 §6 rule).
      return finish(ctx.classify({ jobError: jobErrorText(shared) }), jobErrorText(shared));
    }

    phase = 'publish';
    if (aborted()) return finish('aborted', 'harness_quiesce');
    phaseStart = now();
    const publishJob = await edge.publishAsync({ name, cg });
    const published = await edge.waitPublishJob({
      jobId: publishJob.jobId, timeoutMs: opTimeoutMs, intervalMs: pollIntervalMs,
    });
    durations.publish = now() - phaseStart;

    let ual = published?.ual ?? null;
    let tx = published?.txHash ?? published?.tx ?? null;
    let recovered = false;
    if (jobFailed(published)) {
      // §6 recovery re-scoring: one authoritative KA-state read before failing —
      // the daemon said failed, so a single read decides (no long re-poll).
      const t = now();
      const rescored = await pollVmFinalized(edge, {
        name, cg, deadlineMs: now(), intervalMs: pollIntervalMs, _now: now,
      });
      if (durations.vm_finalization == null) durations.vm_finalization = now() - t;
      if (!rescored.finalized) {
        return finish(ctx.classify({ jobError: jobErrorText(published) }), jobErrorText(published));
      }
      ual = rescored.ual;
      tx = rescored.tx ?? tx;
      recovered = true;
    }

    if (!recovered) {
      phase = 'vm_finalization';
      if (aborted()) return finish('aborted', 'harness_quiesce', { ual, tx });
      phaseStart = now();
      const finalized = await pollVmFinalized(edge, {
        name, cg, deadlineMs: now() + opTimeoutMs, intervalMs: pollIntervalMs,
        _now: now, isAborted: aborted,
      });
      durations.vm_finalization = now() - phaseStart;
      if (aborted() && !finalized.finalized) return finish('aborted', 'harness_quiesce', { ual, tx });
      if (!finalized.finalized) {
        const reason = finalized.reason || 'vm_poll_timeout';
        return finish(ctx.classify({ jobError: reason }), reason, { ual, tx });
      }
      ual = finalized.ual ?? ual;
      tx = finalized.tx ?? tx;
    }

    return finish('success', null, { ual, tx, recovered });
  } catch (error) {
    if (durations[phase] == null) durations[phase] = now() - phaseStart;
    if (aborted()) return finish('aborted', 'harness_quiesce');
    if (phase === 'publish' || phase === 'vm_finalization') {
      // Client-side error after the daemon may have accepted work: re-score
      // against authoritative KA state for up to the op timeout (rfc59
      // "recovered_after_cli_error" port — here recovered_after_client_error).
      const t = now();
      const rescored = await pollVmFinalized(edge, {
        name, cg, deadlineMs: now() + opTimeoutMs, intervalMs: pollIntervalMs,
        _now: now, isAborted: aborted,
      });
      if (durations.vm_finalization == null) durations.vm_finalization = now() - t;
      if (rescored.finalized) {
        return finish('success', null, { ual: rescored.ual, tx: rescored.tx, recovered: true });
      }
      if (aborted()) return finish('aborted', 'harness_quiesce');
    }
    const text = String(error?.message || error);
    return finish(ctx.classify({ jobError: text }), text);
  } finally {
    ctx.inflight.delete(handle);
  }
}

/** rfc59 publishBurst port: `count` ops on one lane at bounded concurrency. */
async function runLaneBurst(ctx, { lane, wave, count, indexOffset, concurrency }) {
  const results = [];
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, Math.max(count, 1)));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (ctx.ctl.aborted) return;
      const i = next++;
      if (i >= count) return;
      results.push(await runOneOp(ctx, lane, indexOffset + i, wave));
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Execute a publish-scenario workload (Phase 0: certify-100 shape) against the
 * driver edge with a live S3 watch. See the contract JSDoc in the header of
 * this file's stub for responsibilities; additive optional fields on `p`:
 *   pollIntervalMs (default 1000), opTimeoutMs (default 180000), ledger
 *   (loaded ledger.json for journal deltas; absent => deltas score
 *   cursorValid:false / 'ledger_unavailable', never silent zeroes),
 *   _snapshotFleet, _journalSignatureDeltas, _evaluateTrips, _quiesce,
 *   _makePayload, _verifyReadback, _classifyFailure, _sameArtifact, _now
 *   (test injection; real modules used when absent).
 * @param {{
 *   scenario: object, fleet: object, policy: object, edge: object,
 *   evidence: object, runId: string,
 *   baseline: {snapshot: object, cursors: object[], attested: object[]},
 *   snapshotIntervalMs?: number
 * }} p
 * @returns {Promise<{
 *   opResults: object[], readbacks: object[], signatureDeltas: object[],
 *   finalSnapshot: object, peak: object, safetyAborted: boolean, trips: object[]
 * }>}
 */
export async function runPublishScenario(p) {
  const { scenario, fleet, policy, edge, evidence, runId, baseline, snapshotIntervalMs = 5000 } = p;
  const now = p._now || Date.now;
  const snapshotFleetFn = p._snapshotFleet || fleetMod.snapshotFleet;
  const evaluateTripsFn = p._evaluateTrips || watchMod.evaluateTrips;
  const quiesceFn = p._quiesce || watchMod.quiesce;
  const makePayload = p._makePayload || edgeMod.makePayload;
  const verifyReadbackFn = p._verifyReadback || edgeMod.verifyReadback;
  const classifyFn = p._classifyFailure || scoringMod.classifyFailure;
  const sameArtifact = p._sameArtifact || fleetMod.sameArtifact;
  const pollIntervalMs = p.pollIntervalMs ?? 1000;
  const opTimeoutMs = p.opTimeoutMs ?? 180_000;

  const ctl = { aborted: false };
  const trips = [];
  const opResults = [];
  const readbacks = [];
  const inflight = new Set();
  const attemptsLog = [];
  const snapshotHistory = [];
  let peak = null;
  let quiesceResult = null;

  const ctx = {
    scenario, edge, evidence, runId, ctl, now, pollIntervalMs, opTimeoutMs,
    inflight, attemptsLog, opResults, makePayload,
    // classifyFailure throws on unknown modes (never fold silently); the
    // composed `error:<class>` form is the sanctioned catch-side fallback.
    classify: (e) => {
      try { return classifyFn(e); } catch { return 'error:unclassified'; }
    },
  };

  const windowSecRaw = policy?.trips?.admissionShedWindowSec;
  const windowSec = Number(
    (windowSecRaw && typeof windowSecRaw === 'object' ? windowSecRaw.default : windowSecRaw) ?? 60,
  );
  const edgeWindow = () => {
    const cutoff = now() - windowSec * 1000;
    const recent = attemptsLog.filter((a) => a.ts >= cutoff);
    return { attempts: recent.length, shed: recent.filter((a) => a.shed).length, windowSec };
  };

  const onTrip = async (fired) => {
    if (ctl.aborted) return;
    ctl.aborted = true;
    trips.push(...fired);
    clearInterval(timer);
    quiesceResult = await quiesceFn({
      inflight: [...inflight],
      edges: [edge],
      policy,
      confirmFlat: async () => inflight.size === 0,
    });
    for (const trip of fired) {
      evidence.write('safety_abort', { ...trip, quiesce: quiesceResult });
    }
  };

  let ticking = false;
  const tick = async () => {
    if (ticking || ctl.aborted) return;
    ticking = true;
    try {
      const snapshot = await snapshotFleetFn(fleet, { light: true });
      snapshotHistory.push(snapshot);
      peak = mergePeak(peak, snapshot, baseline?.attested || [], { _sameArtifact: sameArtifact });
      evidence.write('fleet_snapshot', {
        kind: snapshot.kind ?? 'light',
        snapshotTs: snapshot.ts ?? null,
        cores: snapshot.cores ?? [],
      });
      evidence.write('host_telemetry', {
        loadavg: os.loadavg(),
        cpuFraction: os.cpus().length ? os.loadavg()[0] / os.cpus().length : null,
        memFreeBytes: os.freemem(),
        note: 'driver-laptop',
      });
      let fired;
      try {
        fired = evaluateTripsFn({
          policy,
          baseline: baseline?.snapshot,
          snapshot,
          snapshotHistory,
          edgeWindow: edgeWindow(),
        });
      } catch (error) {
        // S3 fail-closed: a watch that cannot evaluate is itself a fired trip.
        fired = [{
          trip: 'watch_evaluation_error',
          observed: String(error?.message || error),
          threshold: null,
          reason: 'signal-unavailable',
        }];
      }
      if (Array.isArray(fired) && fired.length > 0) await onTrip(fired);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, snapshotIntervalMs);
  timer.unref?.();

  try {
    const lanes = scenario.lanes || [];
    const waves = Number(scenario.workload?.waves ?? 1);
    const concurrency = Math.max(1, Number(scenario.workload?.concurrency ?? 1));

    for (let wave = 1; wave <= waves && !ctl.aborted; wave++) {
      // Lane pairs run in parallel at PER-LANE concurrency (rfc59 publishLanePair).
      const laneResults = await Promise.all(lanes.map((lane) => {
        const perWave = Number(scenario.workload?.perWave?.[lane] ?? 0);
        return runLaneBurst(ctx, {
          lane, wave, count: perWave, indexOffset: (wave - 1) * perWave, concurrency,
        });
      }));
      if (ctl.aborted) break;

      for (let i = 0; i < lanes.length; i++) {
        if (ctl.aborted) break;
        const lane = lanes[i];
        const successes = laneResults[i].filter((r) => r.outcome === 'success');
        const items = successes.map((r) => ({ subject: r.subject, expectedObject: r.expected_object }));
        const indexBySubject = new Map(successes.map((r) => [r.subject, r.index]));
        let rb;
        try {
          const verified = items.length === 0
            ? { matched: 0, mismatches: [] }
            : await verifyReadbackFn(edge, {
              items,
              cg: scenario.cg?.[lane],
              view: 'verifiable-memory',
              chunkSize: scenario.readback?.chunkSize,
            });
          rb = {
            lane,
            wave,
            expected: items.length,
            matched: verified.matched,
            mismatches: (verified.mismatches || []).map((m) => ({
              index: indexBySubject.get(m.subject) ?? null,
              kind: m.kind,
            })),
            byteExact: scenario.readback?.byteExact !== false,
          };
        } catch (error) {
          rb = {
            lane,
            wave,
            expected: items.length,
            matched: 0,
            mismatches: items.map((it) => ({
              index: indexBySubject.get(it.subject) ?? null,
              kind: 'readback_query_failed',
            })),
            byteExact: scenario.readback?.byteExact !== false,
            error: String(error?.message || error),
          };
        }
        evidence.write('readback_result', rb);
        readbacks.push(rb);
      }
    }

    // Soak: workload stopped, ONLY the snapshot/trip loop keeps running.
    const soakSeconds = Number(scenario.soakSeconds ?? 0);
    if (!ctl.aborted && soakSeconds > 0) {
      evidence.write('soak_start', { soakSeconds });
      const soakEnd = now() + soakSeconds * 1000;
      while (!ctl.aborted && now() < soakEnd) {
        await sleep(Math.min(1000, Math.max(1, soakEnd - now())));
      }
      evidence.write('soak_end', { soakSeconds });
    }
  } finally {
    clearInterval(timer);
  }

  // Final FULL snapshot + exact journal signature deltas (also on abort — the
  // partial evidence must still bind to a final fleet state).
  const finalSnapshot = await snapshotFleetFn(fleet, { light: false });
  peak = mergePeak(peak, finalSnapshot, baseline?.attested || [], { _sameArtifact: sameArtifact });
  evidence.write('fleet_snapshot', {
    kind: finalSnapshot.kind ?? 'full',
    snapshotTs: finalSnapshot.ts ?? null,
    cores: finalSnapshot.cores ?? [],
  });

  let signatureDeltas;
  if (p._journalSignatureDeltas) {
    signatureDeltas = await p._journalSignatureDeltas(fleet, baseline?.cursors || []);
  } else if (p.ledger) {
    signatureDeltas = await fleetMod.journalSignatureDeltas(fleet, baseline?.cursors || [], {
      ledger: p.ledger,
      sidecar: (alias, lines) => evidence.writeSidecar('journal_signature_raw', { alias, lines }),
    });
  } else {
    // No ledger available: never silent zeroes (§9.2) — score INCONCLUSIVE.
    // Totals are null on breakage, matching fleet.journalSignatureDeltas.
    signatureDeltas = (baseline?.cursors || []).map((c) => ({
      alias: c.alias,
      cursorValid: false,
      counts: {},
      gatedTotal: null,
      recordedTotal: null,
      ledgerVersion: null,
      error: 'ledger_unavailable',
    }));
  }
  evidence.write('journal_signature_deltas', {
    cores: signatureDeltas,
    ledgerVersion: p.ledger?.version ?? null,
  });

  return {
    opResults,
    readbacks,
    signatureDeltas,
    finalSnapshot,
    peak: peak || {},
    safetyAborted: ctl.aborted,
    trips,
    partial: ctl.aborted,
    quiesce: quiesceResult,
  };
}

/**
 * Track fleet peaks across snapshots (max RSS, max memory.current fraction,
 * restart-count/pid/start-ts changes vs baseline attestation — sticky
 * unreachability). rfc59 mergePeak port keyed by alias.
 * @param {object|null} peak @param {object} snapshot @param {object[]} baselineAttested
 * @param {{_sameArtifact?: Function}} [opts] additive test injection
 */
export function mergePeak(peak, snapshot, baselineAttested, opts = {}) {
  const sameArtifact = opts._sameArtifact || fleetMod.sameArtifact;
  const out = peak || {};
  for (const core of snapshot?.cores || []) {
    if (!core?.alias) continue;
    let entry = out[core.alias];
    if (!entry) {
      entry = out[core.alias] = {
        alias: core.alias,
        reachable: true,
        restartDetected: false,
        lastError: null,
        maxRss: 0,
        maxMemoryCurrentBytes: 0,
        maxMemoryCurrentFraction: null,
        maxMemoryPeakBytes: 0,
        maxOomKills: 0,
        maxNRestarts: 0,
        maxRecvQ: 0,
        minDiskFreeBytes: null,
        minDiskFreeFraction: null,
        activeState: null,
        commit: null,
        samples: 0,
      };
    }
    if (core.reachable === false) {
      // Reachability is a whole-window invariant: sticky once lost.
      entry.reachable = false;
      entry.lastError = core.error || 'unreachable';
      continue;
    }
    entry.samples += 1;
    if (Number.isFinite(core.rss) && core.rss > entry.maxRss) entry.maxRss = core.rss;
    const cg = core.cgroup || {};
    if (Number.isFinite(cg.memoryCurrent) && cg.memoryCurrent > entry.maxMemoryCurrentBytes) {
      entry.maxMemoryCurrentBytes = cg.memoryCurrent;
    }
    const ceiling = Number.isFinite(cg.memoryHigh) && cg.memoryHigh > 0 ? cg.memoryHigh
      : Number.isFinite(cg.memoryMax) && cg.memoryMax > 0 ? cg.memoryMax : null;
    if (ceiling != null && Number.isFinite(cg.memoryCurrent)) {
      const fraction = cg.memoryCurrent / ceiling;
      if (entry.maxMemoryCurrentFraction == null || fraction > entry.maxMemoryCurrentFraction) {
        entry.maxMemoryCurrentFraction = fraction;
      }
    }
    if (Number.isFinite(cg.memoryPeak) && cg.memoryPeak > entry.maxMemoryPeakBytes) {
      entry.maxMemoryPeakBytes = cg.memoryPeak;
    }
    if (Number.isFinite(cg.oomKills) && cg.oomKills > entry.maxOomKills) entry.maxOomKills = cg.oomKills;
    const sysd = core.systemd || {};
    if (Number.isFinite(sysd.nRestarts) && sysd.nRestarts > entry.maxNRestarts) {
      entry.maxNRestarts = sysd.nRestarts;
    }
    if (Number.isFinite(core.listen?.recvQ) && core.listen.recvQ > entry.maxRecvQ) {
      entry.maxRecvQ = core.listen.recvQ;
    }
    const disk = core.diskFree || {};
    if (Number.isFinite(disk.bytes) && (entry.minDiskFreeBytes == null || disk.bytes < entry.minDiskFreeBytes)) {
      entry.minDiskFreeBytes = disk.bytes;
    }
    if (Number.isFinite(disk.fraction) && (entry.minDiskFreeFraction == null || disk.fraction < entry.minDiskFreeFraction)) {
      entry.minDiskFreeFraction = disk.fraction;
    }
    if (sysd.activeState) entry.activeState = sysd.activeState;
    if (core.build?.commit) entry.commit = core.build.commit;

    const base = (baselineAttested || []).find((a) => a.alias === core.alias);
    if (base && base.attested !== false) {
      // §9.1: restart detection combines counters WITH pid/start-ts deltas —
      // sameArtifact covers commit + pid + start ts against the baseline.
      const current = attestationFromSnapshotCore(core);
      if (!sameArtifact(base, current)) entry.restartDetected = true;
    }
  }
  return out;
}

function rate(successes, attempts) {
  return attempts > 0 ? successes / attempts : 0;
}

/**
 * Map scenario.gates + run artifacts to scoring.evaluateGate inputs (Phase 0
 * certify battery). Pure. Additive optional injection on `p`: _percentile
 * (defaults util.percentile), _sameArtifact (defaults fleet.sameArtifact).
 * @param {{scenario: object, run: object, baseline: object}} p
 * @returns {Array<object>} gate inputs for scoring.evaluateGate
 */
export function buildGates(p) {
  const { scenario, run, baseline } = p;
  const pctl = p._percentile || utilPercentile;
  const sameArtifact = p._sameArtifact || fleetMod.sameArtifact;
  const g = scenario.gates || {};
  const ops = run.opResults || [];
  // §6: harness-quiesce 'aborted' ops are excluded from every denominator.
  const scored = ops.filter((o) => o.outcome !== 'aborted');
  const successes = scored.filter((o) => o.outcome === 'success');
  const gates = [];

  // §3.1 mid-run SHA change: final snapshot attestation vs baseline attestation.
  let shaChanged = false;
  for (const core of run.finalSnapshot?.cores || []) {
    if (core.reachable === false) continue;
    const base = (baseline?.attested || []).find((a) => a.alias === core.alias);
    if (!base || base.attested === false) continue;
    if (!sameArtifact(base, attestationFromSnapshotCore(core))) { shaChanged = true; break; }
  }
  const inc = shaChanged ? { inconclusiveReason: 'fleet-sha-changed' } : {};

  const sr = g.successRate || {};
  gates.push({
    id: 'success_rate_overall',
    kind: 'successRate',
    threshold: sr.overall ?? 0.95,
    observed: rate(successes.length, scored.length),
    samples: scored.length,
    minSamples: sr.minSamples?.overall ?? 0,
    ...inc,
  });
  for (const lane of scenario.lanes || []) {
    const laneScored = scored.filter((o) => o.lane === lane);
    const laneOk = laneScored.filter((o) => o.outcome === 'success');
    gates.push({
      id: `success_rate_${lane}`,
      kind: 'successRate',
      threshold: sr.perLane ?? sr.overall ?? 0.95,
      observed: rate(laneOk.length, laneScored.length),
      samples: laneScored.length,
      minSamples: sr.minSamples?.perLane ?? 0,
      ...inc,
    });
  }

  if (g.publishP95Ms != null) {
    // Percentile over SUCCESSFUL publish durations only, with mandatory
    // coverage (minSamples + minSuccessRate) per §6.
    const values = successes.map((o) => o.durations_ms?.publish).filter(Number.isFinite);
    gates.push({
      id: 'publish_p95_ms',
      kind: 'percentile',
      threshold: g.publishP95Ms,
      observed: pctl(values, 95),
      samples: values.length,
      minSamples: sr.minSamples?.overall ?? 1,
      successRate: rate(successes.length, scored.length),
      minSuccessRate: sr.overall ?? 0.95,
      ...inc,
    });
  }

  if (g.controlFixtures) {
    const fixtures = scored.filter((o) => o.control_fixture);
    const finalized = fixtures.filter((o) => o.outcome === 'success');
    const mismatchKeys = new Set((run.readbacks || []).flatMap((rb) =>
      (rb.mismatches || []).map((m) => `${rb.lane}:${m.index}`)));
    const readBack = finalized.filter((o) => !mismatchKeys.has(`${o.lane}:${o.index}`));
    const ok = fixtures.length > 0
      && (!g.controlFixtures.mustFinalize || finalized.length === fixtures.length)
      && (!g.controlFixtures.mustReadBack || readBack.length === fixtures.length);
    gates.push({
      id: 'control_fixtures',
      kind: 'bool',
      threshold: true,
      observed: ok,
      evidence: { expected: fixtures.length, finalized: finalized.length, readBack: readBack.length },
      ...inc,
    });
  }

  if (g.uniqueUals) {
    const uals = successes.map((o) => o.ual).filter(Boolean);
    const ok = uals.length === successes.length && new Set(uals).size === uals.length;
    gates.push({
      id: 'unique_uals',
      kind: 'bool',
      threshold: true,
      observed: ok,
      evidence: { successes: successes.length, uals: uals.length, unique: new Set(uals).size },
      ...inc,
    });
  }

  const totalMismatches = (run.readbacks || []).reduce((n, rb) => n + (rb.mismatches?.length || 0), 0);
  gates.push({
    id: 'readback_mismatches',
    kind: 'exactZero',
    threshold: 0,
    observed: totalMismatches,
    ...inc,
  });

  const f = g.fleet || {};
  const peakEntries = Object.values(run.peak || {});
  if (f.coreRestarts != null) {
    // Deliberately NOT marked inconclusive on SHA change — the restart gate IS
    // the evidence of the change; workload gates carry the inconclusive flag.
    const restarts = peakEntries.filter((e) => e.restartDetected).length;
    gates.push({ id: 'fleet_core_restarts', kind: 'exactZero', threshold: f.coreRestarts, observed: restarts });
  }
  if (f.oomKillDelta != null) {
    const baseByAlias = new Map((baseline?.snapshot?.cores || []).map((c) => [c.alias, c]));
    let delta = 0;
    for (const e of peakEntries) {
      const b = baseByAlias.get(e.alias);
      delta += Math.max(0, (e.maxOomKills || 0) - (b?.cgroup?.oomKills || 0));
    }
    gates.push({ id: 'fleet_oom_kill_delta', kind: 'exactZero', threshold: f.oomKillDelta, observed: delta });
  }
  if (f.gatedSignatures != null) {
    const deltas = run.signatureDeltas || [];
    const invalid = deltas.filter((d) => d.cursorValid === false);
    const gatedTotal = deltas.reduce((n, d) => n + (d.gatedTotal || 0), 0);
    gates.push({
      id: 'fleet_gated_signatures',
      kind: 'exactZero',
      threshold: f.gatedSignatures,
      observed: gatedTotal,
      ...(invalid.length > 0 ? { inconclusiveReason: 'journal-cursor-invalid' } : {}),
    });
  }
  if (f.memoryPeakFraction != null) {
    // §9.4: sampled memory.current ÷ effective ceiling — cgroup lifetime
    // memory.peak is supporting evidence only (tracked in mergePeak).
    const fractions = peakEntries
      .map((e) => e.maxMemoryCurrentFraction)
      .filter((v) => Number.isFinite(v));
    const missing = peakEntries.some((e) => e.reachable !== false && !Number.isFinite(e.maxMemoryCurrentFraction));
    gates.push({
      id: 'fleet_memory_peak_fraction',
      kind: 'max',
      threshold: f.memoryPeakFraction,
      observed: fractions.length ? Math.max(...fractions) : null,
      ...(missing || fractions.length === 0 ? { inconclusiveReason: 'memory-signal-unavailable' } : {}),
    });
  }

  return gates;
}
