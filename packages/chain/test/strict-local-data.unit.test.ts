import { describe, expect, it } from 'vitest';

import { snapshotExactDataRecord } from '../src/strict-local-data.js';

describe('strict local data helpers', () => {
  it('matches an exact record independently of expected-key order', () => {
    const snapshot = snapshotExactDataRecord({ a: 1, b: 2 }, ['b', 'a']);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(snapshot).toEqual({ a: 1, b: 2 });
  });

  it('rejects duplicate expected keys and still rejects missing or unknown fields', () => {
    expect(() => snapshotExactDataRecord({ a: 1 }, ['a', 'a']))
      .toThrow(/expected keys must be unique/);
    expect(() => snapshotExactDataRecord({ a: 1 }, ['a', 'b']))
      .toThrow(/unknown or missing fields/);
    expect(() => snapshotExactDataRecord({ a: 1, b: 2 }, ['a']))
      .toThrow(/unknown or missing fields/);
  });
});
