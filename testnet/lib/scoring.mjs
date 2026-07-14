// OT-RFC-61 §6 — scoring semantics: aggregates, coverage gates, verdict.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.

/** Run outcomes. */
export const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'INCONCLUSIVE', 'SAFETY_ABORT', 'NOT_RUN']);

/**
 * Classify a failure from client output/daemon state into the closed enum
 * (evidence.mjs FAILURE_CLASSES) — rfc59 classifyFailure port, extended.
 * Unknown → throws (never fold silently); caller may catch and use `error:<class>`.
 * @param {{stdout?: string, stderr?: string, jobError?: string, httpStatus?: number}} e
 * @returns {string}
 */
export function classifyFailure(e) { throw new Error('TODO'); }

/**
 * Aggregate op_result records for one (op, lane): attempts, successes,
 * successRate, nearest-rank p50/p95/p99/max over SUCCESSFUL durations only,
 * failure counts by class, partial flag + attempted/completed/inFlight when the
 * run was quiesced (§6: in-flight at harness quiesce => 'aborted', excluded
 * from the success-rate denominator; SUT-aborted remain failures).
 * @param {Array<object>} opResults @param {{op: string, lane: string, durationField: string, partial?: boolean}} opts
 */
export function aggregate(opResults, opts) { throw new Error('TODO'); }

/**
 * Evaluate one gate. Every latency/percentile gate REQUIRES minSamples and
 * minSuccessRate (RFC-61 §6 coverage gates) — absent coverage fields => throw
 * (a spec bug, not a runtime condition). Returns {id, outcome: 'PASS'|'FAIL'|
 * 'INCONCLUSIVE', observed, threshold, evidence}.
 * @param {{id: string, kind: 'successRate'|'percentile'|'exactZero'|'bool'|'max',
 *          threshold: any, observed: any, samples?: number, minSamples?: number,
 *          successRate?: number, minSuccessRate?: number, inconclusiveReason?: string}} gate
 */
export function evaluateGate(gate) { throw new Error('TODO'); }

/**
 * Fold gate outcomes into the run verdict:
 * any FAIL => FAIL; else any INCONCLUSIVE => INCONCLUSIVE; else PASS.
 * A safetyAbort flag forces SAFETY_ABORT regardless (terminal, consumes attempt).
 * @param {{gates: Array<object>, safetyAbort?: boolean}} p
 * @returns {{outcome: string, gates: Array<object>}}
 */
export function computeVerdict(p) { throw new Error('TODO'); }

/** Render a human verdict table (fixed-width, no color) for terminal output.
 * @param {{outcome: string, gates: Array<object>}} verdict @returns {string} */
export function formatVerdict(verdict) { throw new Error('TODO'); }
