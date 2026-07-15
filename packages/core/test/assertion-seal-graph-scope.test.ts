import { describe, expect, it } from 'vitest';
import {
  ASSERTION_SEAL_PREDICATES,
  buildAssertionSealQuads,
  parseAssertionSealQuads,
} from '../src/assertion-seal.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '../src/ka-content-scope.js';

const ASSERTION_URI = 'urn:dkg:assertion:graph-scope';
const META_GRAPH = 'did:dkg:context-graph:cg-1/_meta';

const baseArgs = {
  assertionUri: ASSERTION_URI,
  metaGraph: META_GRAPH,
  merkleRoot: new Uint8Array(32).fill(0xab),
  authorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  authorAttestationR: new Uint8Array(32).fill(0x11),
  authorAttestationVS: new Uint8Array(32).fill(0x22),
  authorSchemeVersion: 1,
  chainId: 31337n,
  kav10Address: '0x666D0c3da3dBc946D5128D06115bb4eed4595580',
  reservedKaId: (BigInt('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') << 96n) | 1n,
  finalizedAtIso: '2026-07-15T00:00:00.000Z',
  contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
  kaUal: 'did:dkg:otp:20430/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/1',
  assertionVersion: '2',
} as const;

describe('graph-scoped assertion seal', () => {
  it('round-trips one KA-level private commitment without root entities', () => {
    const privateMerkleRoot = new Uint8Array(32).fill(0xcd);
    const quads = buildAssertionSealQuads({
      ...baseArgs,
      publicTripleCount: 7,
      privateMerkleRoot,
      privateTripleCount: 3,
    });

    const seal = parseAssertionSealQuads(quads, ASSERTION_URI);
    expect(seal).toMatchObject({
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: baseArgs.kaUal,
      assertionVersion: '2',
      publicTripleCount: 7,
      privateTripleCount: 3,
      rootEntities: [],
    });
    expect(seal?.privateMerkleRoot).toEqual(privateMerkleRoot);
    expect(quads.some((quad) =>
      quad.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY
    )).toBe(false);
  });

  it('allows fully public and fully private graph-scoped assertions', () => {
    expect(parseAssertionSealQuads(buildAssertionSealQuads({
      ...baseArgs,
      publicTripleCount: 1,
      privateTripleCount: 0,
    }), ASSERTION_URI)).toMatchObject({
      publicTripleCount: 1,
      privateTripleCount: 0,
    });

    expect(parseAssertionSealQuads(buildAssertionSealQuads({
      ...baseArgs,
      publicTripleCount: 0,
      privateMerkleRoot: new Uint8Array(32).fill(0xef),
      privateTripleCount: 1,
    }), ASSERTION_URI)).toMatchObject({
      publicTripleCount: 0,
      privateTripleCount: 1,
    });
  });

  it('rejects empty content and inconsistent private commitment metadata', () => {
    expect(() => buildAssertionSealQuads({
      ...baseArgs,
      publicTripleCount: 0,
      privateTripleCount: 0,
    })).toThrow(/at least one public or private triple/);

    expect(() => buildAssertionSealQuads({
      ...baseArgs,
      publicTripleCount: 1,
      privateTripleCount: 1,
    })).toThrow(/32-byte privateMerkleRoot/);

    expect(() => buildAssertionSealQuads({
      ...baseArgs,
      publicTripleCount: 1,
      privateMerkleRoot: new Uint8Array(32),
      privateTripleCount: 0,
    })).toThrow(/positive privateTripleCount/);
  });
});
