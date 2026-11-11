// SPDX-License-Identifier: Apache-2.0

import {
  DAEMON_AUTHORITY_UNAVAILABLE_CODE,
  DAEMON_RETRYABLE_AUTHORITY_CODES,
  daemonAuthorityRetryDelayMs,
  isRetryableDaemonAuthorityAnswer,
} from '@origintrail-official/dkg-core/daemon-request-deadlines';

/**
 * The retryable authority 503: the check that refused read and changed nothing.
 * A route can still answer it late in a request, when it rethrows a read's
 * failure, so only a request whose repeat is harmless waits and sends it again.
 * Reads and a subscribe repeat on either code.
 */
export const REPEATS_ON_ANY_AUTHORITY_ANSWER: readonly string[] = DAEMON_RETRYABLE_AUTHORITY_CODES;

/**
 * A synchronous publish repeats only on the answer of its own authority check,
 * which comes before anything is signed or sent (`vm/publish`, #3044). A read's
 * marker rethrown from later in the request says nothing about what it sent.
 */
export const REPEATS_ON_OWN_AUTHORITY_ANSWER: readonly string[] = Object.freeze([DAEMON_AUTHORITY_UNAVAILABLE_CODE]);

/** How much of the deadline a repeat must leave for itself, so it is not cut off unanswered. */
const AUTHORITY_RETRY_DEADLINE_MARGIN_MS = 1_000;

export interface RequestDeadline {
  /** Overrides the method's default deadline. */
  timeoutMs?: number;
  /**
   * Set on the long Knowledge Asset mutations: a timeout then throws
   * `DaemonOutcomeUnknownError` carrying this hint.
   */
  outcomeUnknownHint?: string;
  /**
   * The codes of the retryable authority 503 this request is sent again on,
   * within the same deadline. GET requests repeat on both; every other method
   * only names them when a repeat is harmless.
   */
  repeatOn?: readonly string[];
}

/**
 * The wait before a request answered with `res` and `body` is sent again, or
 * `null` when the answer stands: it is not one this request repeats on, the
 * retries are spent, the daemon asks for more than a wait may take, or the
 * deadline has no room for the wait and another answer.
 */
export function authorityRetryWaitMs(
  res: Pick<Response, 'status' | 'headers'>,
  body: unknown,
  retry: number,
  repeatOn: readonly string[],
  remainingMs: number,
): number | null {
  if (!isRetryableDaemonAuthorityAnswer(res.status, body, repeatOn)) return null;
  const waitMs = daemonAuthorityRetryDelayMs(retry, res.headers.get('retry-after'));
  return waitMs !== null && waitMs + AUTHORITY_RETRY_DEADLINE_MARGIN_MS < remainingMs ? waitMs : null;
}
