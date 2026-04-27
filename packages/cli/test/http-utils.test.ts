import { describe, expect, it } from 'vitest';
import { isValidContextGraphId } from '../src/daemon/http-utils.js';

describe('isValidContextGraphId', () => {
  it('rejects traversal path segments', () => {
    for (const id of [
      '../etc/passwd',
      '../../root',
      './../_private',
      'legit-cg/../../other-cg',
      'legit-cg/%2e%2e/other-cg',
    ]) {
      expect(isValidContextGraphId(id)).toBe(false);
    }
  });

  it('keeps existing slug, DID, URN, and URL-style identifiers valid', () => {
    for (const id of [
      'devnet-test',
      'did:dkg:context-graph:devnet-test',
      'urn:dkg:project:smart-contracts',
      'https://example.org/context-graphs/devnet-test',
      'agent@example.org/context.graph-v1',
    ]) {
      expect(isValidContextGraphId(id)).toBe(true);
    }
  });
});
