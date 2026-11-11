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
  USER_AUTHORED_TRUST_LEVEL_CODE,
  UserAuthoredTrustLevelError,
} from '../src/index.js';

const LEGACY_TRUST_LEVEL = 'https://dkg.network/ontology#trustLevel';

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

  it.each([
    ['canonical', TRUST_LEVEL_PREDICATE],
    ['legacy', LEGACY_TRUST_LEVEL],
  ])('recognizes the %s trustLevel predicate in angle brackets, as the store writes it', (_name, predicate) => {
    expect(isTrustLevelQuad({ predicate: `<${predicate}>` })).toBe(true);
    expect(isSwmMerkleExcludedQuad({ predicate: `<${predicate}>` })).toBe(true);
    expect(() => assertNoUserAuthoredTrustLevelQuads([{ subject: 'urn:a', predicate: `<${predicate}>` }]))
      .toThrow(UserAuthoredTrustLevelError);
  });

  it('excludes a bracketed workspace-owner row too, and still keeps bracketed author predicates', () => {
    expect(isSwmMerkleExcludedQuad({ predicate: `<${WORKSPACE_OWNER_PREDICATE}>` })).toBe(true);
    expect(isSwmMerkleExcludedQuad({ predicate: '<http://schema.org/name>' })).toBe(false);
    expect(isTrustLevelQuad({ predicate: `<${TRUST_LEVEL_PREDICATE}>x` })).toBe(false);
  });

  it('rejects user-authored trust metadata with a code that routes answer with 400', () => {
    let thrown: unknown;
    try {
      assertNoUserAuthoredTrustLevelQuads([{ subject: 'urn:a', predicate: 'urn:other' }, { subject: 'urn:b', predicate: TRUST_LEVEL_PREDICATE }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UserAuthoredTrustLevelError);
    expect(thrown).toMatchObject({ name: 'UserAuthoredTrustLevelError', code: USER_AUTHORED_TRUST_LEVEL_CODE });
    expect(Object.getOwnPropertyDescriptor(thrown, 'code')?.value).toBe('USER_AUTHORED_TRUST_LEVEL');
  });

  // Every quad these helpers see on the SWM read paths is read back from the
  // store, so its predicate is bare: comparing the unwrapped form selects the
  // same rows, and a root recomputed over them does not change.
  it('excludes exactly the bare rows an exact comparison excludes', () => {
    const graph = 'did:dkg:context-graph:cg/_shared_memory';
    const swm = [
      { subject: 'urn:a', predicate: 'http://schema.org/name', object: '"A"', graph },
      { subject: 'urn:a', predicate: TRUST_LEVEL_PREDICATE, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph },
      { subject: 'urn:a', predicate: LEGACY_TRUST_LEVEL, object: '"1"', graph },
      { subject: 'urn:a', predicate: WORKSPACE_OWNER_PREDICATE, object: '"peer"', graph },
      { subject: 'urn:b', predicate: 'http://schema.org/name', object: '"B"', graph },
    ];
    const exact = new Set([TRUST_LEVEL_PREDICATE, LEGACY_TRUST_LEVEL, WORKSPACE_OWNER_PREDICATE]);
    const kept = swm.filter((quad) => !isSwmMerkleExcludedQuad(quad));
    expect(kept).toEqual(swm.filter((quad) => !exact.has(quad.predicate)));
    expect(kept).toEqual([swm[0], swm[4]]);
  });
});
