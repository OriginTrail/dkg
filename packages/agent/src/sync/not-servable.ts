// SPDX-License-Identifier: Apache-2.0

/**
 * "This request cannot be served here right now": the reply of a sync responder
 * for a request it has just failed to serve within its own limits and will not
 * run again until a cooling period ends.
 *
 * The page protocol has no reply frame for a refusal, so it travels as the
 * handler's error text. The text starts with the words every released
 * requester already classifies as a busy responder ("sync responder … busy"),
 * so a requester that does not know this reply keeps its existing retry and
 * backoff behaviour; one that does stops retrying the page and holds the graph
 * for that peer.
 */
const SYNC_NOT_SERVABLE_PREFIX = 'sync responder busy: request not servable';

export type SyncNotServableReason =
  /** A store query of the request ran into the store's deadline. */
  | 'store-deadline'
  /** The request is beyond what the responder can page within its bounds. */
  | 'too-large';

export interface SyncNotServable {
  readonly reason: SyncNotServableReason;
  /** The responder's own cooling time left, when it sent one. */
  readonly retryAfterMs?: number;
}

export function formatSyncNotServable(reason: SyncNotServableReason, retryAfterMs: number): string {
  return `${SYNC_NOT_SERVABLE_PREFIX} (reason=${reason}; retry-after-ms=${Math.max(0, Math.ceil(retryAfterMs))})`;
}

/**
 * Earlier responders report these two conditions as plain text. Reading them
 * as the same reply lets a requester apply its hold with them as well.
 */
const UNTYPED_STORE_DEADLINE = /exceeded its (?:store|server-side query) deadline/;
const UNTYPED_TOO_LARGE = /snapshot exceeds per-snapshot (?:rows|estimated bytes) budget/;

/** Read a not-servable reply from a sync failure; `null` for every other failure. */
export function readSyncNotServable(error: unknown): SyncNotServable | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const start = message.indexOf(SYNC_NOT_SERVABLE_PREFIX);
  if (start < 0) {
    if (UNTYPED_STORE_DEADLINE.test(message)) return { reason: 'store-deadline' };
    return UNTYPED_TOO_LARGE.test(message) ? { reason: 'too-large' } : null;
  }
  const detail = message.slice(start + SYNC_NOT_SERVABLE_PREFIX.length);
  const reason: SyncNotServableReason = /reason=too-large\b/.test(detail) ? 'too-large' : 'store-deadline';
  const retryAfter = /retry-after-ms=(\d{1,12})\b/.exec(detail);
  return retryAfter ? { reason, retryAfterMs: Number(retryAfter[1]) } : { reason };
}
