import { describe, it, expect } from 'vitest';
import { appendInPlace } from '../src/sync/append-in-place.js';

// Safely above V8's argument-spread limit (empirically ~1.25e5 on Node 22), so
// `target.push(...source)` reliably overflows the stack at this size.
const OVERFLOW_SIZE = 500_000;

describe('appendInPlace', () => {
  it('appends a source larger than the argument-spread limit without overflowing the stack', () => {
    const source = Array.from({ length: OVERFLOW_SIZE }, (_, i) => i);
    const target: number[] = [];
    expect(() => appendInPlace(target, source)).not.toThrow();
    expect(target).toHaveLength(OVERFLOW_SIZE);
    expect(target[0]).toBe(0);
    expect(target[OVERFLOW_SIZE - 1]).toBe(OVERFLOW_SIZE - 1);
  });

  it('documents the crash it guards against: the spread form throws at the same size', () => {
    const source = Array.from({ length: OVERFLOW_SIZE }, (_, i) => i);
    const target: number[] = [];
    // The exact pattern that crashed the sync responder
    // (`rows.push(...graphRows.filter(...))`): a `RangeError: Maximum call
    // stack size exceeded`. appendInPlace replaces every such site.
    expect(() => target.push(...source)).toThrow(RangeError);
  });

  it('appends onto a non-empty target in order, preserving existing elements', () => {
    const target = ['a', 'b'];
    appendInPlace(target, ['c', 'd', 'e']);
    expect(target).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('is a no-op for an empty source', () => {
    const target = [1, 2, 3];
    appendInPlace(target, []);
    expect(target).toEqual([1, 2, 3]);
  });
});
