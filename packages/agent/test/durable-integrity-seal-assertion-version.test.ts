import { describe, it, expect } from 'vitest';
import {
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  ASSERTION_SEAL_PREDICATES,
} from '@origintrail-official/dkg-core';
import { parseAssertionSealQuads } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { selectVerifiedDurableSyncQuads } from '../src/sync/durable-integrity.js';

/**
 * GH#1778 — a graph-scoped author seal shared member->curator reaches the
 * curator over the durable `_meta` sync lane. The seal subject carries
 * `dkg:assertionVersion`, which collides with the durable sync-control
 * predicate set; for a not-yet-published KA (no on-chain UAL descriptor to
 * authenticate against) it used to be stripped, leaving 13/14 quads and making
 * `parseAssertionSealQuads` throw "Partial graph-scoped assertion seal".
 *
 * These tests pin: (1) a self-consistent seal keeps ALL 14 quads and parses,
 * in both snapshot and delta modes; (2) the admission is fail-closed — a
 * forged version on a subject that is not a self-consistent seal rooted at its
 * own author coordinate is still dropped.
 */

const CG = 'construction';
const AUTHOR = '0xA32f1cc125401B55911678847426759094055B2d';
const NAME = 'justTriplets';
const META_GRAPH = contextGraphMetaUri(CG);
const ASSERTION_URI = contextGraphAssertionUri(CG, AUTHOR, NAME);
const KA_UAL = `did:dkg:84532/${AUTHOR.toLowerCase()}/7`;
const RESERVED_KA_ID = (BigInt(AUTHOR) << 96n) | 7n;

function buildSeal(overrides?: {
  assertionUri?: string;
  authorAddress?: string;
  kaUal?: string;
  reservedKaId?: bigint;
  contentScopeVersion?: 1 | 2;
}): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: overrides?.assertionUri ?? ASSERTION_URI,
    metaGraph: META_GRAPH,
    merkleRoot: new Uint8Array(32).fill(0xab),
    authorAddress: overrides?.authorAddress ?? AUTHOR,
    authorAttestationR: new Uint8Array(32).fill(0x11),
    authorAttestationVS: new Uint8Array(32).fill(0x22),
    authorSchemeVersion: 1,
    chainId: 84532n,
    kav10Address: '0x1234567890123456789012345678901234567890',
    reservedKaId: overrides?.reservedKaId ?? RESERVED_KA_ID,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    contentScopeVersion: (overrides?.contentScopeVersion ?? GRAPH_KA_CONTENT_SCOPE_VERSION) as typeof GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: overrides?.kaUal ?? KA_UAL,
    assertionVersion: 1n,
    publicTripleCount: 3,
    privateTripleCount: 0,
  }) as Quad[];
}

function keptMeta(metaQuads: Quad[], mode: { kind: 'fullSnapshot' } | { kind: 'sinceBatchId'; sinceBatchId: bigint }): Quad[] {
  const sel = selectVerifiedDurableSyncQuads([], metaQuads, false, mode);
  return sel.metaIndexes.map((i) => metaQuads[i]!);
}

const MODES: Array<{ kind: 'fullSnapshot' } | { kind: 'sinceBatchId'; sinceBatchId: bigint }> = [
  { kind: 'fullSnapshot' },
  { kind: 'sinceBatchId', sinceBatchId: 0n },
];

describe('GH#1778 durable-sync retains the seal assertionVersion', () => {
  for (const mode of MODES) {
    it(`keeps all 14 seal quads and parses (mode=${mode.kind})`, () => {
      const seal = buildSeal();
      const kept = keptMeta(seal, mode).filter((q) => q.subject === ASSERTION_URI);
      expect(kept).toHaveLength(seal.length);
      expect(kept.some((q) => q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION)).toBe(true);
      // The whole point: the seal now parses at the author subject.
      expect(() => parseAssertionSealQuads(kept, ASSERTION_URI)).not.toThrow();
      const parsed = parseAssertionSealQuads(kept, ASSERTION_URI);
      expect(parsed?.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
      expect(parsed?.assertionVersion).toBe('1');
    });
  }

  it('keeps assertionVersion for a self-consistent SUB-GRAPH seal', () => {
    const subUri = contextGraphAssertionUri(CG, AUTHOR, NAME, 'wing-a');
    const seal = buildSeal({ assertionUri: subUri });
    const kept = keptMeta(seal, { kind: 'fullSnapshot' }).filter((q) => q.subject === subUri);
    expect(kept).toHaveLength(seal.length);
    expect(() => parseAssertionSealQuads(kept, subUri)).not.toThrow();
  });

  it('drops assertionVersion on a non-seal subject (no assertionMerkleRoot) — unchanged fail-closed behaviour', () => {
    const foreign: Quad = {
      subject: `did:dkg:context-graph:${CG}/assertion/${AUTHOR}/other`,
      predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
      object: '"9"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: META_GRAPH,
    };
    const kept = keptMeta([foreign], { kind: 'fullSnapshot' });
    expect(kept).toHaveLength(0);
  });

  it('drops assertionVersion when the seal author disagrees with the kaUal author (fail-closed)', () => {
    // Seal at AUTHOR's coordinate but kaUal names a DIFFERENT author.
    const mismatched = buildSeal({ kaUal: `did:dkg:84532/0x${'cd'.repeat(20)}/7` });
    const kept = keptMeta(mismatched, { kind: 'fullSnapshot' }).filter((q) => q.subject === ASSERTION_URI);
    expect(kept.some((q) => q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION)).toBe(false);
    // The rest of the seal still flows (descriptive), so parse throws "partial".
    expect(() => parseAssertionSealQuads(kept, ASSERTION_URI)).toThrow(/Partial graph-scoped assertion seal/);
  });

  it('drops assertionVersion when the seal subject is planted at a foreign author coordinate (fail-closed)', () => {
    // A valid, self-consistent seal for AUTHOR/KA_UAL, but planted under a
    // DIFFERENT address segment in the subject URI (a "wrong place" attack).
    const victim = `0x${'ee'.repeat(20)}`;
    const plantedUri = contextGraphAssertionUri(CG, victim, NAME);
    const planted = buildSeal({ assertionUri: plantedUri });
    const kept = keptMeta(planted, { kind: 'fullSnapshot' }).filter((q) => q.subject === plantedUri);
    expect(kept.some((q) => q.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION)).toBe(false);
  });
});
