import { describe, expect, it } from 'vitest';
import {
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  buildTrustLevelQuads,
  isTrustLevelQuad,
  isSwmMerkleExcludedQuad,
  WORKSPACE_OWNER_PREDICATE,
  assertNoUserAuthoredTrustLevelQuads,
  isTrustLevel,
} from '../src/index.js';

describe('trust metadata helpers', () => {
  it('builds canonical dkg:trustLevel quads from TrustLevel values', () => {
    const quads = buildTrustLevelQuads(
      ['urn:a', 'urn:a', 'urn:b'],
      TrustLevel.ConsensusVerified,
      'did:dkg:context-graph:cg',
    );

    expect(quads).toEqual([
      {
        subject: 'urn:a',
        predicate: TRUST_LEVEL_PREDICATE,
        object: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: 'did:dkg:context-graph:cg',
      },
      {
        subject: 'urn:b',
        predicate: TRUST_LEVEL_PREDICATE,
        object: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: 'did:dkg:context-graph:cg',
      },
    ]);
  });

  it('recognizes canonical and legacy trustLevel predicates as protocol metadata', () => {
    expect(isTrustLevelQuad({ predicate: TRUST_LEVEL_PREDICATE })).toBe(true);
    expect(isTrustLevelQuad({ predicate: 'https://dkg.network/ontology#trustLevel' })).toBe(true);
    expect(isTrustLevelQuad({ predicate: 'http://schema.org/name' })).toBe(false);
  });

  // 2026-07-07 MERKLE_MISMATCH_IN_SWM regression: the publisher and the core
  // responder BOTH exclude these bookkeeping quads before recomputing the KC
  // merkle root over their SWM copies. If the two exclusion sets ever diverge,
  // folded-private ACKs fail. This pins the single-source predicate they share.
  it('isSwmMerkleExcludedQuad excludes trust-level AND workspace-owner bookkeeping, nothing else', () => {
    // trust-level (canonical + legacy) — excluded
    expect(isSwmMerkleExcludedQuad({ predicate: TRUST_LEVEL_PREDICATE })).toBe(true);
    expect(isSwmMerkleExcludedQuad({ predicate: 'https://dkg.network/ontology#trustLevel' })).toBe(true);
    // workspace-owner bookkeeping — excluded
    expect(WORKSPACE_OWNER_PREDICATE).toBe('http://dkg.io/ontology/workspaceOwner');
    expect(isSwmMerkleExcludedQuad({ predicate: WORKSPACE_OWNER_PREDICATE })).toBe(true);
    // ordinary author payload — kept (hashed into the root)
    expect(isSwmMerkleExcludedQuad({ predicate: 'http://schema.org/name' })).toBe(false);
    expect(isSwmMerkleExcludedQuad({ predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' })).toBe(false);
  });

  it('validates TrustLevel values at runtime', () => {
    expect(isTrustLevel(TrustLevel.PartiallyVerified)).toBe(true);
    expect(isTrustLevel(99)).toBe(false);
    expect(() =>
      buildTrustLevelQuads(['urn:a'], 99 as TrustLevel, 'did:dkg:context-graph:cg'),
    ).toThrow(/Invalid TrustLevel 99/);
  });

  it('rejects user-authored trustLevel quads', () => {
    expect(() =>
      assertNoUserAuthoredTrustLevelQuads([
        {
          subject: 'urn:a',
          predicate: TRUST_LEVEL_PREDICATE,
        },
      ]),
    ).toThrow(/User-authored dkg:trustLevel metadata is not allowed/);
  });
});
