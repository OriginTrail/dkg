/**
 * Slice 06 — unit tests for `verifyTokenScope`.
 *
 * Pure function — no I/O, no fixtures. Property: `'*'` grants every
 * scope; explicit lists grant exactly the listed scopes; unknown tokens
 * fail closed.
 */
import { describe, expect, it } from 'vitest';
import { verifyTokenScope, type TokenStore } from '../src/auth.js';
import type { TokenRecord } from '../src/token-store.js';

function buildStore(records: TokenRecord[]): TokenStore {
  const store = new Map<string, TokenRecord>();
  for (const r of records) store.set(r.prefix, r);
  return store;
}

describe('verifyTokenScope', () => {
  it('grants any scope when the record is wildcard "*"', () => {
    const store = buildStore([
      { prefix: 'rooty-tk', fullToken: 'rooty-tkABCDEF', scopes: '*' },
    ]);
    expect(verifyTokenScope('rooty-tkABCDEF', 'kafka:endpoint:read', store)).toBe(true);
    expect(verifyTokenScope('rooty-tkABCDEF', 'kafka:endpoint:write', store)).toBe(true);
    expect(verifyTokenScope('rooty-tkABCDEF', 'arbitrary:scope:we-invent', store)).toBe(true);
  });

  it('grants only listed scopes for a scoped record', () => {
    const store = buildStore([
      {
        prefix: 'reader-1',
        fullToken: 'reader-1XXXXXX',
        scopes: ['kafka:endpoint:read'],
      },
    ]);
    expect(verifyTokenScope('reader-1XXXXXX', 'kafka:endpoint:read', store)).toBe(true);
    expect(verifyTokenScope('reader-1XXXXXX', 'kafka:endpoint:write', store)).toBe(false);
    expect(verifyTokenScope('reader-1XXXXXX', 'anything-else', store)).toBe(false);
  });

  it('returns false for unknown / undefined / empty tokens', () => {
    const store = buildStore([
      { prefix: 'rooty-tk', fullToken: 'rooty-tkABCDEF', scopes: '*' },
    ]);
    expect(verifyTokenScope(undefined, 'any', store)).toBe(false);
    expect(verifyTokenScope('', 'any', store)).toBe(false);
    expect(verifyTokenScope('not-in-store', 'any', store)).toBe(false);
  });

  it('does not perform glob/wildcard matching on non-"*" lists', () => {
    // ADR-0003: no CG-bound scopes, no wildcards within lists. A scope
    // string is exact-match against the required scope.
    const store = buildStore([
      { prefix: 'glob-bad', fullToken: 'glob-badZZZZZZ', scopes: ['kafka:*'] },
    ]);
    expect(verifyTokenScope('glob-badZZZZZZ', 'kafka:endpoint:read', store)).toBe(false);
    // The literal "kafka:*" does match its own string, but that's a
    // pathological scope name no caller should ever ask for. Documenting
    // for future maintainers, not endorsing.
    expect(verifyTokenScope('glob-badZZZZZZ', 'kafka:*', store)).toBe(true);
  });

  it('handles multiple scoped records in the same store independently', () => {
    const store = buildStore([
      {
        prefix: 'reader-x',
        fullToken: 'reader-xAAAAAA',
        scopes: ['kafka:endpoint:read'],
      },
      {
        prefix: 'writer-y',
        fullToken: 'writer-yBBBBBB',
        scopes: ['kafka:endpoint:write'],
      },
    ]);
    expect(verifyTokenScope('reader-xAAAAAA', 'kafka:endpoint:read', store)).toBe(true);
    expect(verifyTokenScope('reader-xAAAAAA', 'kafka:endpoint:write', store)).toBe(false);
    expect(verifyTokenScope('writer-yBBBBBB', 'kafka:endpoint:write', store)).toBe(true);
    expect(verifyTokenScope('writer-yBBBBBB', 'kafka:endpoint:read', store)).toBe(false);
  });
});
