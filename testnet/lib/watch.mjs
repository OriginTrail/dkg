// OT-RFC-61 §8 S3 — abort-trip evaluation + quiesce controller.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.

/**
 * Evaluate all S3 trips against the latest fleet snapshot + edge-side counters.
 * FAIL-CLOSED: a signal that is missing/unreadable for a reachable core fires
 * its trip with reason 'signal-unavailable'. Trips (policy.trips keys):
 *  - memoryPsiSomeAvg10 (sustained — caller passes history window)
 *  - memoryCurrentVsHighFraction
 *  - oomKillDelta (vs baseline)
 *  - coreUnreachableFromBaseline (ANY baseline-reachable core lost)
 *  - acceptQueueRecvQAtBacklog (or N consecutive connect-probe failures)
 *  - diskFreeFloorBytes / diskFreeFloorFraction
 *  - admissionShedFractionOfAttempts over admissionShedWindowSec (edge-side)
 *    OR fleet /api/status admission-rejection delta
 *  - rpcExhaustionDeltaPerRun (fleet /api/status counters vs baseline)
 * @param {{
 *   policy: object, baseline: object, snapshot: object,
 *   snapshotHistory: object[], edgeWindow: {attempts: number, shed: number, windowSec: number}
 * }} p
 * @returns {Array<{trip: string, alias?: string, observed: any, threshold: any, reason?: string}>} fired trips ([] = healthy)
 */
export function evaluateTrips(p) { throw new Error('TODO'); }

/**
 * Quiesce controller (S3): stop submitting; cancel/abandon in-flight client
 * operations via the provided handles; if any remain, stop the local edge
 * daemon(s) within policy.quiesce.edgeShutdownTimeoutSec; then confirm flat
 * counters (no admission attempts from us, no publisher jobs progressing) for
 * policy.quiesce.flatCounterConfirmSec before returning.
 * NEVER touches fleet hosts.
 * @param {{
 *   inflight: Array<{cancel: () => Promise<void>}>,
 *   edges: Array<object>, policy: object,
 *   confirmFlat: () => Promise<boolean>
 * }} p
 * @returns {Promise<{cancelled: number, edgeShutdown: boolean, flatConfirmed: boolean}>}
 */
export async function quiesce(p) { throw new Error('TODO'); }

/**
 * SAFETY_ABORT bookkeeping: persist runs/safety-abort.json {ts, runId, trips,
 * cooldownUntil} and refuse new load-generating runs until cooldownUntil passes
 * or the file is removed by the operator (manual clearance).
 * @param {{runsDir: string, runId: string, trips: object[], policy: object}} p
 */
export function recordSafetyAbort(p) { throw new Error('TODO'); }

/** Check the cooldown gate before a load-generating run. Returns
 * {blocked: boolean, until?: string}. @param {{runsDir: string}} p */
export function safetyAbortGate(p) { throw new Error('TODO'); }
