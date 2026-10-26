// Publisher pick-up metrics of the async queue contention benchmark (OT-RFC-73 P2b). Pure: no I/O and no dist imports,
// so the node:test known answers run anywhere.
//
// Pick-up (D-15, the G0b / G1b definition): accepted -> first claim, over the jobs accepted inside the measure window,
// the run's value being the p50; a job nobody claimed by the end of the run is right-censored there (its wait is a lower
// bound, so it counts as the run end minus its acceptance, never as absent).
// Worker-free pick-up (D-16, G2 / G3): ready -> claimed, where ready is the latest of acceptedAt, lastRetriedAt and
// lastRecoveredAt, over the jobs that became ready while at least one of the N configured wallets held no wallet lock
// (each wallet runs one publisher worker, so a free wallet means a worker was free to claim). The busy intervals come
// from wallet-lock writes and deletes, never from job finish times: the same rule the product's WalletBusyTracker
// (core, P1b) applies to the live `async_admission_usage` line, so this number and that line mean the same thing.
import { depthSeries, summarize } from './verdict.mjs';

/** A persisted lift job (or a `ljob` row) as run-relative times: the publisher stamps Date.now(), `epoch0` is the run's. */
export function jobRow(job, epoch0) {
  const ts = job.timestamps ?? {};
  const rel = (v) => {
    const t = typeof v === 'string' ? Date.parse(v) : v;
    return Number.isFinite(t) ? t - epoch0 : null;
  };
  const acceptedAt = rel(ts.acceptedAt);
  const retriedAt = rel(ts.lastRetriedAt);
  const recoveredAt = rel(ts.lastRecoveredAt);
  return {
    jobId: job.jobId,
    name: job.request?.knowledgeAssetVmPublish?.name ?? null,
    status: job.status ?? null,
    acceptedAt,
    readyAt: acceptedAt === null ? null : Math.max(acceptedAt, retriedAt ?? -Infinity, recoveredAt ?? -Infinity),
    claimedAt: rel(ts.claimedAt),
    finalizedAt: rel(ts.finalizedAt),
    failedAt: rel(ts.failedAt),
    // the record keeps the LAST claim only: a retried or recovered job's claimedAt is no longer its first claim
    reclaimed: retriedAt !== null || recoveredAt !== null,
  };
}

/**
 * Wallet availability from the wallet-lock events [{ t, ev: 'written' | 'deleted', walletId }] (run-relative ms, in
 * emission order): classify(t) is 'free' when some configured wallet held no lock at t, 'busy' when every one did, and
 * 'unknown' before `knownFrom` (or with no wallet configured). A wallet is busy from its first write until its delete
 * (a renewal of an open lock changes nothing); busy means strictly inside the interval, so the lock a claiming worker
 * writes at the very instant the job became ready does not count against that job. The benchmark runs on a fresh
 * namespace with every wallet free at the epoch, hence knownFrom 0.
 */
export function walletClassifier(events, walletIds, knownFrom = 0) {
  const wallets = [...new Set(walletIds)];
  const open = new Map();
  const closed = new Map();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (!wallets.includes(e.walletId)) continue;
    if (e.ev === 'written') {
      if (!open.has(e.walletId)) open.set(e.walletId, e.t);
    } else if (e.ev === 'deleted' && open.has(e.walletId)) {
      const start = open.get(e.walletId);
      closed.set(e.walletId, [...(closed.get(e.walletId) ?? []), { start, end: Math.max(start, e.t) }]);
      open.delete(e.walletId);
    }
  }
  const busyAt = (w, t) =>
    (open.has(w) && open.get(w) < t) || (closed.get(w) ?? []).some((i) => i.start < t && t < i.end);
  return (t) => {
    if (!wallets.length || !(t >= knownFrom)) return 'unknown';
    return wallets.some((w) => !busyAt(w, t)) ? 'free' : 'busy';
  };
}

/**
 * The publisher stream's job-side metrics of one run. rows = jobRow()s of this run's jobs; window = { from, to }
 * (run-relative ms); runEnd = when the publisher stopped claiming (the censoring time of an unclaimed job);
 * walletEvents and walletIds feed walletClassifier. A trace that recorded no lock write although jobs were claimed is
 * dead (the product no longer emits what the wrapper listens for): every job is then 'unknown', not 'free', and
 * workerFree.traceLive says so, so the worker-free number is missing rather than silently the plain pick-up.
 *   pickup          the D-15 distribution (n, p50, p95, ...) with the counts that say how much of it is censored
 *   workerFree      the D-16 distribution over the jobs ready while a wallet was free: nQualifying is its sample size,
 *                   nBusy the jobs ready with every wallet locked, nUnknown those with no wallet state
 *   claimToFinishMs finalized jobs of the window, claimed -> finalized (reported next to pick-up, no threshold)
 *   unclaimed       accepted-but-unclaimed depth over the window, sampled every second
 */
export function pickupBlock({ rows, window, runEnd, walletEvents, walletIds }) {
  const traceLive = !rows.some((j) => j.claimedAt !== null) || walletEvents.some((e) => e.ev === 'written');
  const classify = traceLive ? walletClassifier(walletEvents, walletIds) : () => 'unknown';
  const inWindow = rows.filter((j) => j.acceptedAt !== null && j.acceptedAt >= window.from && j.acceptedAt < window.to);
  const waitOf = (j, base) =>
    j.claimedAt !== null
      ? { ms: Math.max(0, j.claimedAt - base), censored: false }
      : { ms: Math.max(0, runEnd - base), censored: true };
  const counts = (waits) => ({
    nClaimed: waits.filter((w) => !w.censored).length,
    nCensored: waits.filter((w) => w.censored).length,
  });
  const waits = inWindow.map((j) => waitOf(j, j.acceptedAt));
  const byAvailability = { free: [], busy: [], unknown: [] };
  for (const j of inWindow) byAvailability[classify(j.readyAt)].push(waitOf(j, j.readyAt));
  const free = byAvailability.free;
  const finalized = inWindow.filter((j) => j.claimedAt !== null && j.finalizedAt !== null);
  return {
    pickup: {
      nAccepted: inWindow.length,
      ...counts(waits),
      ...summarize(waits.map((w) => w.ms)),
      claimedOnly: summarize(waits.filter((w) => !w.censored).map((w) => w.ms)),
    },
    workerFree: {
      traceLive,
      nQualifying: free.length,
      nBusy: byAvailability.busy.length,
      nUnknown: byAvailability.unknown.length,
      ...counts(free),
      ...summarize(free.map((w) => w.ms)),
    },
    claimToFinishMs: summarize(finalized.map((j) => j.finalizedAt - j.claimedAt)),
    unclaimed: {
      ...depthSeries(
        rows.filter((j) => j.acceptedAt !== null).map((j) => [j.acceptedAt, j.claimedAt ?? Infinity]),
        window.from,
        window.to,
      ),
      unclaimedAtEnd: rows.filter((j) => j.acceptedAt !== null && j.claimedAt === null).length,
    },
    reclaimed: rows.filter((j) => j.reclaimed).length,
    states: rows.reduce((acc, j) => ({ ...acc, [j.status]: (acc[j.status] ?? 0) + 1 }), {}),
    finalizedInWindow: rows.filter(
      (j) => j.finalizedAt !== null && j.finalizedAt >= window.from && j.finalizedAt < window.to,
    ).length,
  };
}

/**
 * summary.publish: the publisher stream of one run. `admission` = admissionSummary of its (finalized) requests,
 * `rows` = jobRow()s of this run's persisted jobs, `handler` = the synthetic handler's counts, `runner` = the lift side's
 * runner state (errors, whether it stopped in time). completionsPerMin counts finalized jobs of the measure window.
 */
export function publishSummary({
  admission,
  groundTruth,
  rows,
  window,
  runEnd,
  walletEvents,
  walletIds,
  scheduledArrivals,
  reconcileError,
  handler,
  runner,
  config,
}) {
  const block = pickupBlock({ rows, window, runEnd, walletEvents, walletIds });
  const measureMs = window.to - window.from;
  return {
    ...admission,
    groundTruth,
    scheduledArrivals,
    jobsFound: rows.length,
    reconcileError,
    ...block,
    claimed: rows.filter((j) => j.claimedAt !== null).length,
    finalized: rows.filter((j) => j.finalizedAt !== null).length,
    completionsPerMin: Math.round((block.finalizedInWindow / (measureMs / 60_000)) * 100) / 100,
    walletEvents: {
      written: walletEvents.filter((e) => e.ev === 'written').length,
      deleted: walletEvents.filter((e) => e.ev === 'deleted').length,
    },
    handler,
    runner,
    config,
  };
}
