/**
 * OT-RFC-73 P9a: the publisher job page cursor and limit, as a P9b route will use them. Pure: no store.
 */
import { describe, expect, it } from 'vitest';
import {
  LIFT_JOB_PAGE_DEFAULT_LIMIT,
  LIFT_JOB_PAGE_MAX_LIMIT,
  LiftJobPageError,
  compareLiftJobPageKeys,
  decodeLiftJobPageCursor,
  encodeLiftJobPageCursor,
  liftJobPageLimit,
  type LiftJobPageKey,
} from '../src/lift-job-page.js';
import * as publisher from '../src/index.js';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const KEY: LiftJobPageKey = { acceptedAt: 1_761_523_200_123, jobId: '3f1c2a9e-7b1d-4c58-9d0e-aa11bb22cc33' };

function refusal(run: () => unknown): LiftJobPageError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LiftJobPageError);
    return error as LiftJobPageError;
  }
  throw new Error('expected the call to throw');
}

describe('publisher job page cursor', () => {
  it('round-trips a position and is the one canonical spelling of it', () => {
    const cursor = encodeLiftJobPageCursor(KEY);
    expect(decodeLiftJobPageCursor(cursor)).toEqual(KEY);
    expect(encodeLiftJobPageCursor(decodeLiftJobPageCursor(cursor))).toBe(cursor);
    // Opaque and URL-safe: it can travel in a query string without escaping.
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    // Versioned and queue-tagged: the JSON a future reader can dispatch on.
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({ v: 1, q: 'lift', t: KEY.acceptedAt, j: KEY.jobId });
  });

  it('accepts the whole job id grammar and the edges of the timestamp range', () => {
    for (const key of [
      { acceptedAt: 0, jobId: 'a' },
      { acceptedAt: Number.MAX_SAFE_INTEGER, jobId: 'A.b_c:d-9' },
      { acceptedAt: 5, jobId: 'x'.repeat(256) },
    ]) {
      expect(decodeLiftJobPageCursor(encodeLiftJobPageCursor(key))).toEqual(key);
    }
  });

  it.each([
    ['an empty string', ''],
    ['text that is not base64url', 'not a cursor!'],
    ['base64 with padding', `${encodeLiftJobPageCursor(KEY)}=`],
    ['base64 of something that is not JSON', b64('hello')],
    ['JSON null', b64('null')],
    ['a JSON array', b64('[1,"lift",5,"a"]')],
    ['a JSON string', b64('"cursor"')],
    ['a cursor for another version', b64('{"v":2,"q":"lift","t":5,"j":"a"}')],
    ['a cursor with no version', b64('{"q":"lift","t":5,"j":"a"}')],
    ['a cursor made for another queue', b64('{"v":1,"q":"promote","t":5,"j":"a"}')],
    ['a cursor with an extra field', b64('{"v":1,"q":"lift","t":5,"j":"a","x":1}')],
    ['a cursor missing a field', b64('{"v":1,"q":"lift","t":5}')],
    ['a timestamp that is a string', b64('{"v":1,"q":"lift","t":"5","j":"a"}')],
    ['a negative timestamp', b64('{"v":1,"q":"lift","t":-1,"j":"a"}')],
    ['a fractional timestamp', b64('{"v":1,"q":"lift","t":1.5,"j":"a"}')],
    ['a timestamp beyond the safe integers', b64('{"v":1,"q":"lift","t":9007199254740993,"j":"a"}')],
    ['a job id that is a number', b64('{"v":1,"q":"lift","t":5,"j":7}')],
    ['a job id outside the grammar (space)', b64('{"v":1,"q":"lift","t":5,"j":"a b"}')],
    ['a job id that could break out of an IRI', b64('{"v":1,"q":"lift","t":5,"j":"a>b"}')],
    ['a job id that starts with punctuation', b64('{"v":1,"q":"lift","t":5,"j":"-a"}')],
    ['an empty job id', b64('{"v":1,"q":"lift","t":5,"j":""}')],
    ['a job id longer than the grammar allows', b64(`{"v":1,"q":"lift","t":5,"j":"${'x'.repeat(257)}"}`)],
    ['the same position spelled with other key order', b64('{"q":"lift","v":1,"j":"a","t":5}')],
    ['the same position spelled with whitespace', b64('{"v": 1, "q": "lift", "t": 5, "j": "a"}')],
    ['a cursor longer than any a page can produce', 'A'.repeat(1_025)],
  ])('refuses %s with a typed malformed_cursor error', (_name, cursor) => {
    const error = refusal(() => decodeLiftJobPageCursor(cursor));
    expect(error.code).toBe('malformed_cursor');
    expect(error.name).toBe('LiftJobPageError');
    expect(error).toBeInstanceOf(Error);
  });

  it('refuses a non-string without throwing anything untyped', () => {
    for (const value of [undefined, null, 5, {}, ['x']]) {
      expect(refusal(() => decodeLiftJobPageCursor(value as never)).code).toBe('malformed_cursor');
    }
  });

  it('will not mint a cursor for a position it could not resume from', () => {
    expect(refusal(() => encodeLiftJobPageCursor({ acceptedAt: 5, jobId: 'has space' })).code).toBe('unreadable_row');
    expect(refusal(() => encodeLiftJobPageCursor({ acceptedAt: 5, jobId: '' })).code).toBe('unreadable_row');
    expect(refusal(() => encodeLiftJobPageCursor({ acceptedAt: -1, jobId: 'a' })).code).toBe('unreadable_row');
    expect(refusal(() => encodeLiftJobPageCursor({ acceptedAt: 1.5, jobId: 'a' })).code).toBe('unreadable_row');
    expect(refusal(() => encodeLiftJobPageCursor({ acceptedAt: Number.NaN, jobId: 'a' })).code).toBe('unreadable_row');
  });
});

describe('publisher job page limit', () => {
  it('defaults to 100 and allows up to 1,000', () => {
    expect(LIFT_JOB_PAGE_DEFAULT_LIMIT).toBe(100);
    expect(LIFT_JOB_PAGE_MAX_LIMIT).toBe(1_000);
    expect(liftJobPageLimit(undefined)).toBe(100);
    expect(liftJobPageLimit(1)).toBe(1);
    expect(liftJobPageLimit(1_000)).toBe(1_000);
  });

  it.each([0, -1, 1_001, 100_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s with invalid_limit', (limit) => {
    expect(refusal(() => liftJobPageLimit(limit)).code).toBe('invalid_limit');
  });
});

describe('publisher job page key order', () => {
  it('orders by acceptedAt, then by job id code unit (upper case before lower case, unlike localeCompare)', () => {
    const at = (acceptedAt: number, jobId: string): LiftJobPageKey => ({ acceptedAt, jobId });
    expect(compareLiftJobPageKeys(at(1, 'z'), at(2, 'a'))).toBeLessThan(0);
    expect(compareLiftJobPageKeys(at(2, 'a'), at(1, 'z'))).toBeGreaterThan(0);
    expect(compareLiftJobPageKeys(at(1, 'a'), at(1, 'a'))).toBe(0);
    expect(compareLiftJobPageKeys(at(1, 'B-2'), at(1, 'b-1'))).toBeLessThan(0);
    expect('B-2'.localeCompare('b-1')).toBeGreaterThan(0);
    expect(compareLiftJobPageKeys(at(1, 'job-10'), at(1, 'job-9'))).toBeLessThan(0);
  });
});

describe('publisher package surface', () => {
  it('exports the page contract for the routes', () => {
    expect(publisher.LiftJobPageError).toBe(LiftJobPageError);
    expect(publisher.encodeLiftJobPageCursor).toBe(encodeLiftJobPageCursor);
    expect(publisher.decodeLiftJobPageCursor).toBe(decodeLiftJobPageCursor);
    expect(publisher.liftJobPageLimit).toBe(liftJobPageLimit);
    expect(publisher.LIFT_JOB_PAGE_DEFAULT_LIMIT).toBe(100);
    expect(publisher.LIFT_JOB_PAGE_MAX_LIMIT).toBe(1_000);
  });
});
