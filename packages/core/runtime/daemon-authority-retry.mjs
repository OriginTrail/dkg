// SPDX-License-Identifier: Apache-2.0
// Build-free authority retry policy shared by packaged clients and repository scripts.

export const READ_AUTHORITY_CODE = 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE';
export const AUTHORITY_CODE = 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE';
export const RETRYABLE_AUTHORITY_CODES = Object.freeze([READ_AUTHORITY_CODE, AUTHORITY_CODE]);

/** The wait before each retry, in order, when the node asks for no longer one. */
export const AUTHORITY_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 8_000]);
/** The longest single wait: a node that asks for more gets its answer reported instead. */
export const AUTHORITY_RETRY_MAX_DELAY_MS = 15_000;

/** Whether an answer (status and parsed body) is the retryable authority 503. */
export function isRetryableAuthorityAnswer(status, json, codes = RETRYABLE_AUTHORITY_CODES) {
  return status === 503 && json !== null && typeof json === 'object'
    && json.retryable === true && typeof json.code === 'string' && codes.includes(json.code);
}

/** A Retry-After value in ms: delta-seconds or an HTTP-date. Anything else counts as absent. */
export function retryAfterMs(header, nowMs = Date.now()) {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  if (/^[0-9]+$/.test(value)) return Number(value) * 1_000;
  if (!/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * The wait before retry `retry` (from 0), in ms: its back-off, or what the node
 * asked for when that is longer, so a retry never comes before the node asked.
 * `null` when the client stops here: the retries are spent, or the node asked for
 * more than one wait may take.
 */
export function authorityRetryDelayMs(retry, retryAfter, nowMs = Date.now()) {
  const backoff = AUTHORITY_RETRY_DELAYS_MS[retry];
  if (backoff === undefined) return null;
  const delay = Math.max(backoff, retryAfterMs(retryAfter, nowMs) ?? 0);
  return delay <= AUTHORITY_RETRY_MAX_DELAY_MS ? delay : null;
}

