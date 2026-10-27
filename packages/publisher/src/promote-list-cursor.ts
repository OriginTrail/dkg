import { isSafeJobId } from './job-id.js';

/**
 * Paging of the share queue's job listing (OT-RFC-73 P8a): the cursor, the page-size rule and the two typed errors of a page, the
 * request's (`PromoteListRequestError`, which a route maps to `400`) and the stored rows' (`PromoteListStoredRowError`).
 *
 * A cursor names the last row of the previous page by the two fields that never change for a job, `enqueuedAt` and `jobId`,
 * so a walk stays correct when jobs change state or are inserted between pages. It is versioned, opaque to clients and
 * schema-checked: exactly one textual form decodes, anything else is refused as a whole, and the values only ever reach a
 * query through `literal()` / `integer()`.
 */

export const PROMOTE_LIST_DEFAULT_PAGE_SIZE = 100;
export const PROMOTE_LIST_MAX_PAGE_SIZE = 1_000;

const CURSOR_VERSION = 'v1';
const CURSOR_PREFIX = `${CURSOR_VERSION}.`;
/** `v1.` plus the base64url of `{"t":<safe integer>,"j":<256 characters>}` is under 400 characters. */
const CURSOR_MAX_LENGTH = 512;
const CURSOR_BODY = /^[A-Za-z0-9_-]+$/;

export interface PromoteJobCursor {
  /** `enqueuedAt` of the last row of the page, in epoch milliseconds. */
  readonly enqueuedAt: number;
  readonly jobId: string;
}

export type PromoteListRequestErrorCode = 'PROMOTE_LIST_CURSOR_INVALID' | 'PROMOTE_LIST_PAGE_SIZE_INVALID';

/** A paged listing request the caller got wrong. A route answers it with `400`; the message never echoes the input. */
export class PromoteListRequestError extends Error {
  override readonly name = 'PromoteListRequestError';
  constructor(readonly code: PromoteListRequestErrorCode) {
    super(code === 'PROMOTE_LIST_CURSOR_INVALID'
      ? 'cursor is not a valid share job cursor'
      : `pageSize must be an integer from 1 to ${PROMOTE_LIST_MAX_PAGE_SIZE}`);
  }
}

export type PromoteListStoredRowErrorCode = 'unreadable_row' | 'unordered_page' | 'unresumable_page';

/**
 * A page the stored rows cannot support: the fault is in the store, not in the request, so a route answers it as an internal
 * error and never with the `400` of `PromoteListRequestError`. Like the publisher's `LiftJobPageError`, a caller tells the faults
 * apart by `instanceof` and `code`, never by the wording of `message`, which is a diagnostic for the node log and may change.
 *
 *  - `unreadable_row`: the position of the last row of the page cannot be encoded as a cursor (a stored enqueue time below zero, a
 *    job ID the grammar refuses). The complete listing, which never encodes a cursor, still returns the row.
 *  - `unordered_page`: the store returned the keys in another order than the cursor's, or a key at or before the cursor (a store
 *    that collates differently, or ignores the cursor), which would skip or repeat a job.
 *  - `unresumable_page`: a full page held no share job, so there is no row to continue from and a walk would loop.
 */
export class PromoteListStoredRowError extends Error {
  override readonly name = 'PromoteListStoredRowError';
  constructor(readonly code: PromoteListStoredRowErrorCode, message: string) {
    super(message);
  }
}

function isCursor(cursor: { enqueuedAt: unknown; jobId: unknown }): cursor is PromoteJobCursor {
  return typeof cursor.enqueuedAt === 'number' && Number.isSafeInteger(cursor.enqueuedAt) && cursor.enqueuedAt >= 0
    && typeof cursor.jobId === 'string' && isSafeJobId(cursor.jobId);
}

const canonicalBody = (cursor: PromoteJobCursor): string => JSON.stringify({ t: cursor.enqueuedAt, j: cursor.jobId });

/**
 * The cursor of a position the SERVER read, so a position that cannot be encoded (a stored row with a negative enqueue time, a job id the
 * grammar refuses) is a fault of the stored data, a `PromoteListStoredRowError`, never the `PromoteListRequestError` a route answers with `400`.
 */
export function encodePromoteJobCursor(cursor: PromoteJobCursor): string {
  if (!isCursor(cursor)) throw new PromoteListStoredRowError('unreadable_row', 'Share job listing: the position of the last row of the page cannot be encoded as a cursor');
  return CURSOR_PREFIX + Buffer.from(canonicalBody(cursor), 'utf8').toString('base64url');
}

/** Decode a cursor a client sent back. Anything but a cursor `encodePromoteJobCursor` could have produced is refused. */
export function decodePromoteJobCursor(value: unknown): PromoteJobCursor {
  const invalid = () => new PromoteListRequestError('PROMOTE_LIST_CURSOR_INVALID');
  if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH || !value.startsWith(CURSOR_PREFIX)) throw invalid();
  const body = value.slice(CURSOR_PREFIX.length);
  if (!CURSOR_BODY.test(body)) throw invalid();
  const text = Buffer.from(body, 'base64url').toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid(); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();
  const { t, j } = parsed as Record<string, unknown>;
  const cursor = { enqueuedAt: t, jobId: j };
  if (!isCursor(cursor)) throw invalid();
  // One textual form per cursor: no extra keys, no whitespace, no alternative base64 spelling.
  if (canonicalBody(cursor) !== text || encodePromoteJobCursor(cursor) !== value) throw invalid();
  return cursor;
}

/** The page size of a paged call: 100 when absent, otherwise an integer from 1 to 1,000. */
export function resolvePromotePageSize(value: unknown): number {
  if (value === undefined) return PROMOTE_LIST_DEFAULT_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PROMOTE_LIST_MAX_PAGE_SIZE) {
    throw new PromoteListRequestError('PROMOTE_LIST_PAGE_SIZE_INVALID');
  }
  return value;
}

/** Order of two cursors / keys in the listing: oldest `enqueuedAt` first, then `jobId` by code point (jobIds are ASCII). */
export function comparePromoteJobCursors(a: PromoteJobCursor, b: PromoteJobCursor): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
  return a.jobId === b.jobId ? 0 : a.jobId < b.jobId ? -1 : 1;
}
