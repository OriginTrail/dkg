/**
 * The share job listing's cursor and page-size rules (OT-RFC-73 P8a, AC6): a versioned, opaque, schema-checked cursor with one
 * textual form per value, and a typed error for everything else.
 */
import { describe, expect, it } from 'vitest';
import { SAFE_JOB_ID_MAX_LENGTH } from '../src/job-id.js';
import {
  PROMOTE_LIST_DEFAULT_PAGE_SIZE,
  PROMOTE_LIST_MAX_PAGE_SIZE,
  PromoteListRequestError,
  comparePromoteJobCursors,
  decodePromoteJobCursor,
  encodePromoteJobCursor,
  resolvePromotePageSize,
} from '../src/promote-list-cursor.js';
import { mulberry32, randomJobId } from './_helpers/share-job-rows.js';

const raw = (json: string) => `v1.${Buffer.from(json, 'utf8').toString('base64url')}`;
const cursorError = { name: 'PromoteListRequestError', code: 'PROMOTE_LIST_CURSOR_INVALID' };

describe('the cursor codec', () => {
  it('round-trips any timestamp and job id the queue can produce', () => {
    const rand = mulberry32(8_001);
    const stamps = [0, 1, 1_700_000_000_000, Number.MAX_SAFE_INTEGER];
    for (let i = 0; i < 400; i++) {
      const cursor = { enqueuedAt: i < stamps.length ? stamps[i]! : Math.floor(rand() * 2_000_000_000_000), jobId: randomJobId(rand, i % 7 === 0 ? SAFE_JOB_ID_MAX_LENGTH : 24) };
      const text = encodePromoteJobCursor(cursor);
      expect(text).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
      expect(text.length).toBeLessThanOrEqual(512);
      expect(decodePromoteJobCursor(text)).toEqual(cursor);
    }
  });

  it('is versioned and opaque: the text carries the version prefix and no readable job id or timestamp', () => {
    const text = encodePromoteJobCursor({ enqueuedAt: 1_700_000_000_123, jobId: 'job-visible-id' });
    expect(text.startsWith('v1.')).toBe(true);
    expect(text).not.toContain('job-visible-id');
    expect(text).not.toContain('1700000000123');
  });

  it('writes one text per cursor, so the same position is always the same string', () => {
    const cursor = { enqueuedAt: 42, jobId: 'a.b_c:d-e' };
    expect(encodePromoteJobCursor(cursor)).toBe(encodePromoteJobCursor({ ...cursor }));
    expect(encodePromoteJobCursor(cursor)).toBe(raw('{"t":42,"j":"a.b_c:d-e"}'));
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { enqueuedAt: 1, jobId: 'a' }],
    ['an array', ['v1.x']],
    ['the empty string', ''],
    ['the bare prefix', 'v1.'],
    ['no version', encodePromoteJobCursor({ enqueuedAt: 1, jobId: 'a' }).slice(3)],
    ['another version', encodePromoteJobCursor({ enqueuedAt: 1, jobId: 'a' }).replace('v1.', 'v2.')],
    ['an upper-case version', encodePromoteJobCursor({ enqueuedAt: 1, jobId: 'a' }).replace('v1.', 'V1.')],
    ['text over the length cap', `v1.${'A'.repeat(600)}`],
    ['padding', `${encodePromoteJobCursor({ enqueuedAt: 1, jobId: 'ab' })}=`],
    ['characters outside base64url', 'v1.eyJ0IjoxLCJqIjoiYSJ9+/'],
    ['whitespace', ` ${encodePromoteJobCursor({ enqueuedAt: 1, jobId: 'a' })}`],
    ['text that is not JSON', raw('not json')],
    ['JSON that is not an object', raw('[1,"a"]')],
    ['null JSON', raw('null')],
  ])('refuses %s', (_name, value) => {
    expect(() => decodePromoteJobCursor(value)).toThrowError(expect.objectContaining(cursorError));
    expect(() => decodePromoteJobCursor(value)).toThrowError(PromoteListRequestError);
  });

  it.each([
    ['a missing job id', '{"t":1}'],
    ['a missing timestamp', '{"j":"a"}'],
    ['an extra key', '{"t":1,"j":"a","x":1}'],
    ['the keys in another order', '{"j":"a","t":1}'],
    ['whitespace in the JSON', '{"t": 1, "j": "a"}'],
    ['a timestamp as a string', '{"t":"1","j":"a"}'],
    ['a fractional timestamp', '{"t":1.5,"j":"a"}'],
    ['a timestamp written as 1.0', '{"t":1.0,"j":"a"}'],
    ['a negative timestamp', '{"t":-1,"j":"a"}'],
    ['negative zero', '{"t":-0,"j":"a"}'],
    ['a timestamp above the safe integers', '{"t":9007199254740993,"j":"a"}'],
    ['an exponent timestamp', '{"t":1e3,"j":"a"}'],
    ['an empty job id', '{"t":1,"j":""}'],
    ['a job id that starts with punctuation', '{"t":1,"j":"-a"}'],
    ['a job id with a space', '{"t":1,"j":"a b"}'],
    ['a job id with an angle bracket', '{"t":1,"j":"a>b"}'],
    ['a job id with a quote', '{"t":1,"j":"a\\"b"}'],
    ['a job id with a slash', '{"t":1,"j":"a/b"}'],
    ['a non-ASCII job id', '{"t":1,"j":"j\\u00e9"}'],
    ['a job id over the length limit', `{"t":1,"j":"${'a'.repeat(SAFE_JOB_ID_MAX_LENGTH + 1)}"}`],
    ['a job id that is a number', '{"t":1,"j":5}'],
    ['an injection attempt in the job id', '{"t":1,"j":"a\\"> } DROP ALL #"}'],
  ])('refuses a body with %s', (_name, json) => {
    expect(() => decodePromoteJobCursor(raw(json))).toThrowError(expect.objectContaining(cursorError));
  });

  it('refuses an alternative base64 spelling of a valid cursor', () => {
    // A body whose length is not a multiple of 3 has unused bits in its last character; any other character with the same used
    // bits decodes to the same bytes, and the codec accepts only the one it writes.
    let found = 0;
    for (let n = 1; n <= 12; n++) {
      const text = encodePromoteJobCursor({ enqueuedAt: 5, jobId: 'x'.repeat(n) });
      const body = text.slice(3), bytes = Buffer.from(body, 'base64url');
      for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
        const other = `${body.slice(0, -1)}${c}`;
        if (c !== body.slice(-1) && Buffer.from(other, 'base64url').equals(bytes)) {
          found++;
          expect(() => decodePromoteJobCursor(`v1.${other}`)).toThrowError(expect.objectContaining(cursorError));
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('refuses to encode a position the queue could not have produced', () => {
    for (const cursor of [
      { enqueuedAt: -1, jobId: 'a' }, { enqueuedAt: 1.5, jobId: 'a' }, { enqueuedAt: Number.NaN, jobId: 'a' },
      { enqueuedAt: Number.MAX_SAFE_INTEGER + 2, jobId: 'a' }, { enqueuedAt: 1, jobId: '' }, { enqueuedAt: 1, jobId: 'a b' },
    ]) expect(() => encodePromoteJobCursor(cursor)).toThrowError(PromoteListRequestError);
  });

  it('never echoes the rejected input in the error', () => {
    const hostile = 'v1.<script>alert(1)</script>';
    try { decodePromoteJobCursor(hostile); expect.unreachable(); } catch (error) {
      expect(error).toBeInstanceOf(PromoteListRequestError);
      expect((error as Error).message).not.toContain('script');
      expect((error as Error).message).toBe('cursor is not a valid share job cursor');
    }
  });
});

describe('the page size', () => {
  it('is 100 when absent and any integer from 1 to 1,000 otherwise', () => {
    expect(PROMOTE_LIST_DEFAULT_PAGE_SIZE).toBe(100);
    expect(PROMOTE_LIST_MAX_PAGE_SIZE).toBe(1_000);
    expect(resolvePromotePageSize(undefined)).toBe(100);
    for (const size of [1, 2, 99, 100, 101, 999, 1_000]) expect(resolvePromotePageSize(size)).toBe(size);
  });

  it.each([0, -1, 1_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, '10', null, {}, [], true])('refuses %j', (value) => {
    expect(() => resolvePromotePageSize(value)).toThrowError(expect.objectContaining({ name: 'PromoteListRequestError', code: 'PROMOTE_LIST_PAGE_SIZE_INVALID' }));
  });
});

describe('the listing order', () => {
  it('orders by timestamp and then by job id code point, not by locale', () => {
    const at = (enqueuedAt: number, jobId: string) => ({ enqueuedAt, jobId });
    expect(comparePromoteJobCursors(at(1, 'z'), at(2, 'a'))).toBeLessThan(0);
    expect(comparePromoteJobCursors(at(2, 'a'), at(1, 'z'))).toBeGreaterThan(0);
    expect(comparePromoteJobCursors(at(5, 'B-up'), at(5, 'a-low'))).toBeLessThan(0);
    expect(comparePromoteJobCursors(at(5, 'job-10'), at(5, 'job-2'))).toBeLessThan(0);
    expect(comparePromoteJobCursors(at(5, 'same'), at(5, 'same'))).toBe(0);
  });
});
