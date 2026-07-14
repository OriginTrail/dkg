import { describe, expect, it } from 'vitest';
import {
  ASSERTION_SEAL_PREDICATES,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildAssertionSealQuads,
  parseAssertionSealQuads,
} from '../src/index.js';

const ASSERTION_URI = 'urn:dkg:assertion:graph-scope';
const UAL = 'did:dkg:base:8453/0x70997970C51812dc3A010C7d01b50e0d17dc79C8/0007';

function buildGraphSeal() {
  return buildAssertionSealQuads({
    assertionUri: ASSERTION_URI,
    metaGraph: 'did:dkg:context-graph:cg-1/_meta',
    merkleRoot: new Uint8Array(32).fill(0xab),
    authorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    authorAttestationR: new Uint8Array(32).fill(0x11),
    authorAttestationVS: new Uint8Array(32).fill(0x22),
    authorSchemeVersion: 1,
    chainId: 8453n,
    kav10Address: '0x666D0c3da3dBc946D5128D06115bb4eed4595580',
    reservedKaId: (BigInt('0x70997970C51812dc3A010C7d01b50e0d17dc79C8') << 96n) | 7n,
    finalizedAtIso: '2026-07-15T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: 2,
    publicTripleCount: 1_000,
  });
}

describe('graph-scoped assertion seal', () => {
  it('round-trips one KA identity and emits no root membership rows', () => {
    const quads = buildGraphSeal();
    expect(quads.some((quad) =>
      quad.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY ||
      quad.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_ENTITY,
    )).toBe(false);

    expect(parseAssertionSealQuads(quads, ASSERTION_URI)).toMatchObject({
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7',
      assertionVersion: '2',
      publicTripleCount: 1_000,
      rootEntities: [],
    });
  });

  it('fails closed if v2 is mixed with a legacy root row', () => {
    const quads = buildGraphSeal();
    quads.push({
      subject: ASSERTION_URI,
      predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY,
      object: '<urn:legacy:root>',
      graph: 'did:dkg:context-graph:cg-1/_meta',
    });
    expect(() => parseAssertionSealQuads(quads, ASSERTION_URI))
      .toThrow(/must not contain root entities/);
  });
});
