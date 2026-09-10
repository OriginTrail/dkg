// OT-RFC-61 harness — shared primitives.
// Ports of devnet _bootstrap/harness.ts + rfc59 harness.mjs helpers. Zero deps.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.

import { createHash } from 'node:crypto';

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
export async function waitFor(label, timeoutMs, intervalMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor timeout: ${label}`);
    await sleep(intervalMs);
  }
}

/** True when the error (or any link of its `cause` chain) is a transient
 * network-level failure worth retrying: ECONNRESET / ECONNREFUSED / socket
 * hang-up. HTTP statuses never reach here (fetch does not throw on them). */
export function isTransientNetworkError(err) {
  const seen = new Set();
  for (let e = err; e && typeof e === 'object' && !seen.has(e); e = e.cause) {
    seen.add(e);
    const code = String(e.code ?? '');
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET') return true;
    const msg = String(e.message ?? '');
    if (/ECONNRESET|ECONNREFUSED|socket hang ?up|other side closed/i.test(msg)) return true;
  }
  return false;
}

/**
 * fetch() with retries on transient network errors (ECONNRESET/ECONNREFUSED/socket hangup)
 * only — HTTP error statuses are returned, not retried. (Port of devnet fetchRetry.)
 * @param {string} url @param {object} [init] @param {{retries?: number, backoffMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchRetry(url, init, opts) {
  const o = opts ?? {};
  const retries = o.retries ?? 2; // retries AFTER the first attempt: 3 tries total (devnet parity)
  const backoffMs = o.backoffMs ?? 400;
  const doFetch = o._fetch ?? fetch; // injectable for hermetic tests
  const doSleep = o._sleep ?? sleep;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const perTryInit = { ...(init ?? {}) };
      if (o.timeoutMs && !perTryInit.signal) perTryInit.signal = AbortSignal.timeout(o.timeoutMs);
      return await doFetch(url, perTryInit);
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === retries) throw err;
      await doSleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr; // unreachable; keeps control flow explicit
}

/** Is the double-quote at text[i] escaped (odd number of preceding backslashes)? */
function isEscapedQuote(text, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/** Backward brace-balance scan: find the '{' matching the '}' at `end`
 * (string-aware, so braces inside JSON string literals do not count).
 * Returns the index of the matching '{' or -1. */
function matchOpenBrace(text, end) {
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const c = text[i];
    if (c === '"' && !isEscapedQuote(text, i)) { inString = !inString; continue; }
    if (inString) continue;
    if (c === '}') depth++;
    else if (c === '{' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Extract the LAST balanced top-level JSON object from mixed text (CLI stdout).
 * Returns parsed object or null. (Port of devnet parseLastJsonBlock.)
 * @param {string} text
 */
export function parseLastJsonBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // Walk candidate object ends ('}') from the end of the text; for each,
  // brace-balance backwards to its matching '{' and try JSON.parse on the
  // span. First success wins => the LAST balanced top-level object.
  for (let end = text.lastIndexOf('}'); end >= 0; end = end === 0 ? -1 : text.lastIndexOf('}', end - 1)) {
    const start = matchOpenBrace(text, end);
    if (start < 0) continue;
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // keep scanning earlier object ends
    }
  }
  return null;
}

/**
 * Nearest-rank percentile over a numeric array (RFC-61 §6). p in (0,100].
 * Empty array -> null. Does NOT interpolate.
 * (Parity with rfc59 harness.mjs percentile, which takes q in [0,1].)
 * @param {number[]} values @param {number} p
 * @returns {number|null}
 */
export function percentile(values, p) {
  const sorted = (values ?? []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const q = Math.max(0, Math.min(100, p)) / 100;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/**
 * Normalize a SPARQL JSON-results term to a comparable string
 * ("<iri>" | '"lexical"^^<datatype>' | '"lexical"@lang' | '_:b'). Port of devnet normTerm.
 * Idempotent on cells already in N-Triples term-string form; elides the
 * redundant xsd:string datatype.
 * @param {{type: string, value: string, datatype?: string, "xml:lang"?: string}} term
 */
export function normTerm(term) {
  if (typeof term === 'string') return term;
  const o = term ?? {};
  if (o.value === undefined) return '';
  const lang = o['xml:lang'] ?? o.lang;
  if (lang) return `"${o.value}"@${lang}`;
  if (o.datatype && o.datatype !== XSD_STRING) return `"${o.value}"^^<${o.datatype}>`;
  if (o.type === 'uri') return o.value.startsWith('<') ? o.value : `<${o.value}>`;
  if (o.type === 'bnode') return o.value.startsWith('_:') ? o.value : `_:${o.value}`;
  return /^["_<]/.test(o.value) ? o.value : `"${o.value}"`;
}

/**
 * Canonical digest (sha256 hex) of a SPARQL SELECT result: rows -> sorted normalized
 * tuples -> newline-joined. Order-insensitive. For §6 query_result_mismatch checks.
 * Each row is its bound var=term pairs (vars sorted; unbound vars omitted)
 * joined with \t; rows are sorted AFTER normalization and joined with \n.
 * @param {{head: {vars: string[]}, results: {bindings: object[]}}} json
 */
export function bindingSetDigest(json) {
  const bindings = json?.results?.bindings ?? [];
  const rows = bindings.map((binding) =>
    Object.keys(binding)
      .sort()
      .map((v) => `${v}=${normTerm(binding[v])}`)
      .join('\t'));
  rows.sort();
  return sha256(rows.join('\n'));
}

/**
 * sha256 hex of a string or Buffer.
 * @param {string|Buffer} data
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Wrap a promise with a timeout. Rejects Error(`${label} timeout after ${ms}ms`).
 * @template T @param {Promise<T>} promise @param {number} ms @param {string} label
 * @returns {Promise<T>}
 */
export function promiseWithTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** FNV-1a 32-bit hash of a string (seed derivation for seededRandom). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic PRNG (mulberry32) seeded from a string. Returns () => float [0,1).
 * Used so workload generation is reproducible per (scenario, run_id). @param {string} seed
 */
export function seededRandom(seed) {
  let a = fnv1a(String(seed));
  return function mulberry32() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ISO basic timestamp (YYYYMMDDTHHMMSSZ) for run ids. @param {Date} [d] */
export function isoBasic(d) {
  return (d ?? new Date()).toISOString().replace(/\.\d+/, '').replace(/[-:]/g, '');
}
