import { describe, it, expect } from 'vitest';
import { parsePagination, PaginationError } from '../src/pagination.js';
describe('parsePagination', () => {
  it('applies defaults when no params present', () => {
    const { limit, offset } = parsePagination(new URLSearchParams());
    expect(limit).toBe(30);
    expect(offset).toBe(0);
  });
  it('parses explicit limit and offset', () => {
    const { limit, offset } = parsePagination(new URLSearchParams('limit=50&offset=10'));
    expect(limit).toBe(50);
    expect(offset).toBe(10);
  });
  it('accepts limit at the cap (1000)', () => {
    const { limit } = parsePagination(new URLSearchParams('limit=1000'));
    expect(limit).toBe(1000);
  });
  it('clamps limit above the cap to 1000', () => {
    const { limit } = parsePagination(new URLSearchParams('limit=2000'));
    expect(limit).toBe(1000);
  });
  it('rejects negative limit with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('limit=-1'))).toThrow(PaginationError);
  });
  it('rejects negative offset with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('offset=-5'))).toThrow(PaginationError);
  });
  it('rejects non-numeric limit with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('limit=abc'))).toThrow(PaginationError);
  });
  it('rejects non-numeric offset with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('offset=xyz'))).toThrow(PaginationError);
  });
  it('rejects offset above Number.MAX_SAFE_INTEGER with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('offset=9007199254740992'))).toThrow(
      PaginationError,
    );
  });
  it('rejects limit above Number.MAX_SAFE_INTEGER with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('limit=9007199254740992'))).toThrow(
      PaginationError,
    );
  });
  it('rejects fractional limit with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('limit=1.5'))).toThrow(PaginationError);
  });
  it('rejects present-but-empty ?limit= with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('limit='))).toThrow(PaginationError);
  });
  it('rejects present-but-empty ?offset= with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('offset='))).toThrow(PaginationError);
  });
  it('rejects whitespace-only ?limit= with PaginationError', () => {
    expect(() => parsePagination(new URLSearchParams('limit=   '))).toThrow(PaginationError);
  });
  it('PaginationError carries a descriptive message and field name', () => {
    try {
      parsePagination(new URLSearchParams('limit=-1'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaginationError);
      expect((err as PaginationError).field).toBe('limit');
      expect((err as Error).message).toMatch(/limit/);
    }
  });
});
