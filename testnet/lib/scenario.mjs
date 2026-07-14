// OT-RFC-61 §4.2/§5 — scenario runner. Phase 0: the certify workload.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.
// Orchestrates: edge.mjs (ops) + fleet.mjs (snapshots) + watch.mjs (trips) +
// scoring.mjs (aggregates/gates) + evidence.mjs (records). bin/harness.mjs owns
// the outer mode dispatch; this module owns the workload loop.

/**
 * Execute a publish-scenario workload (Phase 0: certify-100 shape) against the
 * driver edge with a live S3 watch. Responsibilities:
 *  - waves × per-lane bursts at scenario concurrency (lanes run in parallel,
 *    rfc59 publishLanePair port) using edge.makePayload / createKnowledgeAsset /
 *    shareAsync / publishAsync + §6 recovery re-scoring via knowledgeAssetState;
 *  - one op_result per KA with per-phase durations + anchor_meta.poll_interval_ms;
 *  - light fleet snapshot loop every snapshotIntervalMs on a timer; host_telemetry
 *    records at the same cadence; evaluateTrips after every snapshot — on fire:
 *    quiesce + safety_abort record + stop (partial aggregates flagged);
 *  - per-wave byte-exact readback (edge.verifyReadback) → readback_result;
 *  - soak (scenario.soakSeconds) with the watch still active;
 *  - final full snapshot + journalSignatureDeltas vs baseline cursors.
 * Returns everything bin needs for gating:
 * @param {{
 *   scenario: object, fleet: object, policy: object, edge: object /* EdgeClient *\/,
 *   evidence: object /* EvidenceWriter *\/, runId: string,
 *   baseline: {snapshot: object, cursors: object[], attested: object[]},
 *   snapshotIntervalMs?: number
 * }} p
 * @returns {Promise<{
 *   opResults: object[], readbacks: object[], signatureDeltas: object[],
 *   finalSnapshot: object, peak: object, safetyAborted: boolean, trips: object[]
 * }>}
 */
export async function runPublishScenario(p) { throw new Error('TODO'); }

/**
 * Track fleet peaks across snapshots (max RSS, max memory.current fraction,
 * restart-count/pid/start-ts changes vs baseline attestation — sticky
 * unreachability). rfc59 mergePeak port keyed by alias.
 * @param {object|null} peak @param {object} snapshot @param {object[]} baselineAttested
 */
export function mergePeak(peak, snapshot, baselineAttested) { throw new Error('TODO'); }

/**
 * Map scenario.gates + run artifacts to scoring.evaluateGate inputs (Phase 0
 * certify battery: overall/per-lane success with minSamples, publish p95 with
 * coverage, control fixtures, unique UALs, readback, fleet gates incl.
 * memoryPeakFraction from sampled memory.current (§9.4), core restarts via
 * attestation deltas, oom delta, gated signatures with cursorValid handling,
 * mid-run SHA change => all network-dependent gates INCONCLUSIVE).
 * @param {{scenario: object, run: object, baseline: object}} p
 * @returns {Array<object>} gate inputs for scoring.evaluateGate
 */
export function buildGates(p) { throw new Error('TODO'); }
