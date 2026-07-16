/**
 * `normalizeContextGraphId` strips EXACTLY ONE leading `did:dkg:context-graph:`
 * prefix and trims whitespace — matching the daemon. It deliberately does NOT
 * canonicalise trailing slashes or repeated prefixes: the daemon allows `/` and
 * `:` in context-graph ids, so those denote DISTINCT valid ids, and this helper
 * backs ~all client requests. Pinning the contract directly (the round-3 attempt
 * to make it idempotent silently aliased distinct ids and added a ReDoS).
 */
import { describe, it, expect } from 'vitest';
import { normalizeContextGraphId } from '../src/client.js';

describe('normalizeContextGraphId — single DID-prefix strip, no further canonicalisation', () => {
  it.each([
    ['bare id', 'test-cg', 'test-cg'],
    ['single DID form', 'did:dkg:context-graph:test-cg', 'test-cg'],
    ['whitespace-padded DID', '  did:dkg:context-graph:test-cg  ', 'test-cg'],
    ['empty', '', ''],
    ['sub-graph-bearing id (internal slashes kept)', '0xowner/proj', '0xowner/proj'],
    // The cases below MUST be preserved, not canonicalised — they are distinct
    // valid ids the daemon may treat differently:
    ['trailing slash preserved', 'test-cg/', 'test-cg/'],
    ['DID form with trailing slash', 'did:dkg:context-graph:test-cg/', 'test-cg/'],
    ['only ONE prefix stripped', 'did:dkg:context-graph:did:dkg:context-graph:foo', 'did:dkg:context-graph:foo'],
  ])('%s: %j -> %j', (_label, input, expected) => {
    expect(normalizeContextGraphId(input)).toBe(expected);
  });
});
