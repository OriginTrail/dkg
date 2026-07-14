// OT-RFC-61 harness — shared primitives.
// Ports of devnet _bootstrap/harness.ts + rfc59 harness.mjs helpers. Zero deps.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.

/** Sleep for ms. */
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Poll `probe` every `intervalMs` until it returns a truthy value or `timeoutMs` elapses.
 * Resolves the truthy value; throws Error(`waitFor timeout: ${label}`) on timeout.
 * (Port of devnet harness.ts waitFor.)
 * @param {string} label
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @param {() => Promise<any>|any} probe
 */
export async function waitFor(label, timeoutMs, intervalMs, probe) { throw new Error('TODO'); }

/**
 * fetch() with retries on transient network errors (ECONNRESET/ECONNREFUSED/socket hangup)
 * only — HTTP error statuses are returned, not retried. (Port of devnet fetchRetry.)
 * @param {string} url @param {object} [init] @param {{retries?: number, backoffMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchRetry(url, init, opts) { throw new Error('TODO'); }

/**
 * Extract the LAST balanced top-level JSON object from mixed text (CLI stdout).
 * Returns parsed object or null. (Port of devnet parseLastJsonBlock.)
 * @param {string} text
 */
export function parseLastJsonBlock(text) { throw new Error('TODO'); }

/**
 * Nearest-rank percentile over a numeric array (RFC-61 §6). p in (0,100].
 * Empty array -> null. Does NOT interpolate.
 * @param {number[]} values @param {number} p
 * @returns {number|null}
 */
export function percentile(values, p) { throw new Error('TODO'); }

/**
 * Normalize a SPARQL JSON-results term to a comparable string
 * ("<iri>" | '"lexical"^^<datatype>' | '"lexical"@lang' | '_:b'). Port of devnet normTerm.
 * @param {{type: string, value: string, datatype?: string, "xml:lang"?: string}} term
 */
export function normTerm(term) { throw new Error('TODO'); }

/**
 * Canonical digest (sha256 hex) of a SPARQL SELECT result: rows -> sorted normalized
 * tuples -> newline-joined. Order-insensitive. For §6 query_result_mismatch checks.
 * @param {{head: {vars: string[]}, results: {bindings: object[]}}} json
 */
export function bindingSetDigest(json) { throw new Error('TODO'); }

/**
 * sha256 hex of a string or Buffer.
 * @param {string|Buffer} data
 */
export function sha256(data) { throw new Error('TODO'); }

/**
 * Wrap a promise with a timeout. Rejects Error(`${label} timeout after ${ms}ms`).
 * @template T @param {Promise<T>} promise @param {number} ms @param {string} label
 * @returns {Promise<T>}
 */
export function promiseWithTimeout(promise, ms, label) { throw new Error('TODO'); }

/**
 * Deterministic PRNG (mulberry32) seeded from a string. Returns () => float [0,1).
 * Used so workload generation is reproducible per (scenario, run_id). @param {string} seed
 */
export function seededRandom(seed) { throw new Error('TODO'); }

/** ISO basic timestamp (YYYYMMDDTHHMMSSZ) for run ids. @param {Date} [d] */
export function isoBasic(d) { throw new Error('TODO'); }
