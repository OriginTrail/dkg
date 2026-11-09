// SPDX-License-Identifier: Apache-2.0
import { isSafeJobId } from './job-id.js';
import type { LiftJobState } from './lift-job-states.js';
import type { PersistedLiftJob } from './lift-job.js';

/**
 * OT-RFC-73 P9a: the contract of the publisher queue's bounded job listing.
 *
 * A page is a keyset window over the total order (`acceptedAt`, `jobId`). Both parts of the key are immutable for the
 * life of a job (`timestamps.acceptedAt` is in `LIFT_JOB_IMMUTABLE_FIELDS`, the job id names the subject), so a state
 * transition between two pages never moves a job past the cursor and an insert behind the cursor is simply not part of
 * the walk. `jobId` is compared by code unit, which is code point order for the ASCII job id grammar (`isSafeJobId`);
 * that is NOT the `localeCompare` order of the complete `list()`, which only matters among jobs accepted in the same
 * millisecond.
 *
 * This module has no store access. The query lives in `lift-job-listing-selectors.ts`.
 */

/** Page size when the caller names none. */
export const LIFT_JOB_PAGE_DEFAULT_LIMIT = 100;
/** The largest page a caller can ask for. */
export const LIFT_JOB_PAGE_MAX_LIMIT = 1_000;

export interface LiftJobPageRequest {
  /** Only jobs in this state. */
  readonly status?: LiftJobState;
  /**
   * Only the knowledge-asset publish jobs of this context graph, which is what `publisherJobReadScope` calls the
   * `context-graph` scope. Raw-lift jobs are operator-only and never appear in a graph-scoped page.
   */
  readonly contextGraphId?: string;
  /** The previous page's `nextCursor`, passed back unchanged. Omit it for the first page. */
  readonly cursor?: string;
  /** Jobs per page: an integer from 1 to {@link LIFT_JOB_PAGE_MAX_LIMIT}, {@link LIFT_JOB_PAGE_DEFAULT_LIMIT} when omitted. */
  readonly limit?: number;
}

export interface LiftJobPage {
  /**
   * The page, in key order. It can hold fewer than `limit` jobs while `nextCursor` is set: a row whose payload no
   * longer decodes is skipped, exactly as `list()` skips it, and the walk continues past it.
   */
  readonly jobs: PersistedLiftJob[];
  /** Resume point for the next page, or `null` when no further row followed this page at the time of the read. */
  readonly nextCursor: string | null;
  /**
   * `nextCursor === null`. It means no further row at the time of this read, never proof of absence: a job admitted
   * behind the cursor afterwards is not seen by this walk, and one admitted ahead of it still is.
   */
  readonly complete: boolean;
}

/** The bounded listing as a capability, segregated off the base publisher contract like its siblings. */
export interface VmPublishJobPager {
  listPage(request?: LiftJobPageRequest): Promise<LiftJobPage>;
}

/** The position of a job in the page order. */
export interface LiftJobPageKey {
  readonly acceptedAt: number;
  readonly jobId: string;
}

/**
 * What a caller did wrong, or what the store answered that the walk cannot continue from:
 *
 *  - `malformed_cursor`, `invalid_limit`: the request. A route maps them to `400`.
 *  - `unreadable_row`, `unordered_page`: the stored rows. The page refuses to hand out a cursor it could not resume
 *    from (a row whose id or time cannot be a position), or a page the engine ordered differently from the cursor,
 *    because either would skip or repeat jobs. The complete `list()` still answers.
 */
export type LiftJobPageErrorCode = 'malformed_cursor' | 'invalid_limit' | 'unreadable_row' | 'unordered_page';

export class LiftJobPageError extends Error {
  constructor(readonly code: LiftJobPageErrorCode, message: string) {
    super(message);
    this.name = 'LiftJobPageError';
  }
}

/** Total order of the page: `acceptedAt`, then `jobId` by code unit. */
export function compareLiftJobPageKeys(a: LiftJobPageKey, b: LiftJobPageKey): number {
  if (a.acceptedAt !== b.acceptedAt) return a.acceptedAt < b.acceptedAt ? -1 : 1;
  if (a.jobId === b.jobId) return 0;
  return a.jobId < b.jobId ? -1 : 1;
}

/** The page size to use, or `invalid_limit`. */
export function liftJobPageLimit(limit: number | undefined): number {
  if (limit === undefined) return LIFT_JOB_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIFT_JOB_PAGE_MAX_LIMIT) {
    throw new LiftJobPageError('invalid_limit', `limit must be an integer from 1 to ${LIFT_JOB_PAGE_MAX_LIMIT}`);
  }
  return limit;
}

const CURSOR_VERSION = 1;
/** Names the queue, so a cursor made for another queue's listing is refused rather than read as a position. */
const CURSOR_QUEUE = 'lift';
const CURSOR_MAX_LENGTH = 1_024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * An opaque, versioned cursor: base64url of `{"v":1,"q":"lift","t":<acceptedAt>,"j":"<jobId>"}`. It is a position
 * and nothing else. It carries no authority, so it is not signed: forging one can only choose where in the caller's
 * own, already scoped listing to start, and every page applies the status and context graph filters again.
 */
export function encodeLiftJobPageCursor(key: LiftJobPageKey): string {
  if (!isCursorTimestamp(key.acceptedAt)) {
    throw new LiftJobPageError('unreadable_row', `acceptedAt ${String(key.acceptedAt)} cannot be a cursor position`);
  }
  if (!isSafeJobId(key.jobId)) {
    throw new LiftJobPageError('unreadable_row', `jobId ${JSON.stringify(key.jobId)} cannot be a cursor position`);
  }
  return Buffer.from(cursorJson(key.acceptedAt, key.jobId), 'utf8').toString('base64url');
}

/** The position a cursor names, or `malformed_cursor`. Strict: one canonical spelling per position. */
export function decodeLiftJobPageCursor(cursor: string): LiftJobPageKey {
  const refuse = (why: string): never => {
    throw new LiftJobPageError('malformed_cursor', `cursor is not valid: ${why}`);
  };
  if (typeof cursor !== 'string' || cursor.length === 0) return refuse('empty');
  if (cursor.length > CURSOR_MAX_LENGTH) return refuse('too long');
  if (!BASE64URL.test(cursor)) return refuse('not base64url');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return refuse('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refuse('not an object');
  const fields = parsed as Record<string, unknown>;
  const names = Object.keys(fields).sort();
  if (names.length !== 4 || names.join() !== 'j,q,t,v') return refuse('unexpected fields');
  if (fields['v'] !== CURSOR_VERSION) return refuse('unsupported version');
  if (fields['q'] !== CURSOR_QUEUE) return refuse('not a publisher job cursor');
  const acceptedAt = fields['t'];
  const jobId = fields['j'];
  if (!isCursorTimestamp(acceptedAt)) return refuse('bad timestamp');
  if (typeof jobId !== 'string' || !isSafeJobId(jobId)) return refuse('bad job id');
  // One spelling per position: padding bits, key order and whitespace cannot give the same position a second cursor.
  if (encodeLiftJobPageCursor({ acceptedAt, jobId }) !== cursor) return refuse('not canonical');
  return { acceptedAt, jobId };
}

function isCursorTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cursorJson(acceptedAt: number, jobId: string): string {
  return `{"v":${CURSOR_VERSION},"q":"${CURSOR_QUEUE}","t":${acceptedAt},"j":${JSON.stringify(jobId)}}`;
}
