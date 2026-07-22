import { describe, it, expect } from 'vitest';
import {
  generateKCMetadata,
  generateTentativeMetadata,
  getTentativeStatusQuad,
  getConfirmedStatusQuad,
  generateConfirmedMetadata,
  generateConfirmedFullMetadata,
  generateGraphKnowledgeAssetMetadata,
  generateShareMetadata,
  generateAssertionCreatedMetadata,
  generateAssertionPromotedMetadata,
  generateAssertionUpdatedMetadata,
  generateAssertionDiscardedMetadata,
  assertionStateQuad,
  assertionLayerQuad,
  deriveStatus,
  assertionLayerPointerQuad,
  stampLayerPointerSparql,
  WM_CURRENT_ASSERTION_PRED,
  SWM_CURRENT_ASSERTION_PRED,
  VM_CURRENT_ASSERTION_PRED,
  PROV_WAS_REVISION_OF,
  type KCMetadata,
  type KAMetadata,
  type GraphKnowledgeAssetMetadata,
  type OnChainProvenance,
  type ShareMetadata,
  type AssertionCreatedMeta,
  type AssertionPromotedMeta,
  type AssertionDiscardedMeta,
} from '../src/metadata.js';
import { assertionLifecycleUri, contextGraphAssertionUri, contextGraphSharedMemoryUri, MemoryLayer } from '@origintrail-official/dkg-core';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

const CONTEXT_GRAPH = 'agent-registry';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const UAL = 'did:dkg:kc:test-kc-001';

function makeMeta(overrides?: Partial<KCMetadata>): KCMetadata {
  return {
    ual: UAL,
    contextGraphId: CONTEXT_GRAPH,
    merkleRoot: new Uint8Array([0xab, 0xcd, 0xef]),
    publisherPeerId: '12D3KooWTestPeer',
    timestamp: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

function makeKA(overrides?: Partial<KAMetadata>): KAMetadata {
  return {
    rootEntity: 'did:dkg:entity:alice',
    kcUal: UAL,
    tokenId: 1n,
    publicTripleCount: 5,
    privateTripleCount: 0,
    ...overrides,
  };
}

const PROVENANCE: OnChainProvenance = {
  txHash: '0xdeadbeef',
  blockNumber: 12345,
  blockTimestamp: 1709251200,
  publisherAddress: '0x1234567890abcdef1234567890abcdef12345678',
  batchId: 42n,
  chainId: 'base-sepolia',
};

const GRAPH_UAL =
  'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7';

function makeGraphMeta(): GraphKnowledgeAssetMetadata {
  return {
    ual: GRAPH_UAL,
    contextGraphId: CONTEXT_GRAPH,
    merkleRoot: new Uint8Array(32).fill(7),
    publisherPeerId: '12D3KooWGraphPeer',
    timestamp: new Date('2026-03-01T00:00:00Z'),
    assertionVersion: '1',
    publicTripleCount: 2,
    privateTripleCount: 0,
    assertionGraph: `${META_GRAPH}/vm/7`,
  };
}

describe('generateKCMetadata', () => {
  it('RFC ka-metadata-trim: emits NO rdf:type rows (KC nor aggregate/per-token KA)', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    expect(quads.find(q => q.predicate === RDF_TYPE)).toBeUndefined();
  });

  it('includes merkleRoot, contextGraph and publishedAt (KEPT — kafka discovery ordering, review F1); kaCount dropped (Phase 1)', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    const predicates = quads.filter(q => q.subject === UAL).map(q => q.predicate);
    expect(predicates).toContain(`${DKG}merkleRoot`);
    expect(predicates).toContain(`${DKG}contextGraph`);
    expect(predicates).not.toContain(`${DKG}kaCount`);
    // Adversarial review F1: `dkg:publishedAt` is a KEEP, not a Phase-1 drop —
    // the kafka-plugin discovery queries ORDER BY it on the KC/UAL row.
    expect(predicates).toContain(`${DKG}publishedAt`);
  });

  it('all quads use the correct meta graph', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    for (const q of quads) {
      expect(q.graph).toBe(META_GRAPH);
    }
  });

  it('RFC ka-metadata-trim P3.1: collapsed shape — member entity on the UAL subject, no <ual>/<n> token rows, no partOf', () => {
    const ka = makeKA({ tokenId: 7n });
    const quads = generateKCMetadata(makeMeta(), [ka]);

    // No `<ual>/<n>` token subject is minted any more.
    expect(quads.find(q => q.subject === `${UAL}/7`)).toBeUndefined();
    // `dkg:partOf` is gone from the writer entirely (1 publish = 1 KA = 1 UAL).
    expect(quads.find(q => q.predicate === `${DKG}partOf`)).toBeUndefined();

    // The UAL subject carries the member-entity row. Phase 2: the §10.1
    // `dkg:entity` dual-write was collapsed back to the single
    // `dkg:rootEntity` row (readers stay read-both for replica rows).
    const ualPreds = quads.filter(q => q.subject === UAL).map(q => q.predicate);
    expect(ualPreds).toContain(`${DKG}rootEntity`);
    expect(ualPreds).not.toContain(`${DKG}entity`);
    // tokenId/publicTripleCount/rdf:type stay dropped (Phase 1).
    expect(quads.find(q => q.predicate === `${DKG}tokenId`)).toBeUndefined();
    expect(quads.find(q => q.predicate === `${DKG}publicTripleCount`)).toBeUndefined();
    expect(quads.find(q => q.predicate === RDF_TYPE)).toBeUndefined();
  });

  it('includes privateTripleCount only when > 0', () => {
    const publicOnly = generateKCMetadata(makeMeta(), [makeKA({ privateTripleCount: 0 })]);
    expect(publicOnly.some(q => q.predicate === `${DKG}privateTripleCount`)).toBe(false);

    const withPrivate = generateKCMetadata(makeMeta(), [
      makeKA({ privateTripleCount: 3, privateMerkleRoot: new Uint8Array([1, 2, 3]) }),
    ]);
    expect(withPrivate.some(q => q.predicate === `${DKG}privateTripleCount`)).toBe(true);
    expect(withPrivate.some(q => q.predicate === `${DKG}privateMerkleRoot`)).toBe(true);
  });

  it('handles multiple member-entity rows under one KA (collapsed onto the UAL subject + pairing token rows)', () => {
    const kas = [makeKA({ tokenId: 1n }), makeKA({ tokenId: 2n, rootEntity: 'did:dkg:entity:bob' })];
    const quads = generateKCMetadata(makeMeta(), kas);
    // RFC ka-metadata-trim P3.1: every member entity lives on the UAL
    // subject …
    expect(new Set(quads.filter(q => q.subject === UAL && q.predicate === `${DKG}rootEntity`).map(q => q.object)))
      .toEqual(new Set(['did:dkg:entity:alice', 'did:dkg:entity:bob']));
    // … and (Codex review "multi-root-access": the collapse is CONDITIONAL)
    // multi-root publishes additionally re-emit the `<ual>/<tokenId>` pairing
    // rows so private access can tie member root N to private bag N.
    expect(quads).toContainEqual(
      { subject: `${UAL}/1`, predicate: `${DKG}rootEntity`, object: 'did:dkg:entity:alice', graph: META_GRAPH },
    );
    expect(quads).toContainEqual(
      { subject: `${UAL}/2`, predicate: `${DKG}rootEntity`, object: 'did:dkg:entity:bob', graph: META_GRAPH },
    );
    expect(quads).toContainEqual(
      { subject: `${UAL}/2`, predicate: `${DKG}partOf`, object: UAL, graph: META_GRAPH },
    );
  });

  it('Design B + P3.1: the bare <ual> IS the KA — member entities, counts and private roots on one node (+ pairing token rows when multi-root)', () => {
    // One file = one on-chain KA, however many entities. RFC ka-metadata-trim
    // P3.1 collapsed the legacy `<UAL>/1, <UAL>/2, …` per-root label rows into
    // the UAL subject (post-rc.17 invariant: 1 publish = 1 KA = 1 UAL).
    // Readers are read-both — old-shape token rows still arrive via sync from
    // older nodes. Codex review "multi-root-access": MULTI-root publishes
    // additionally re-emit the `<ual>/<tokenId>` pairing rows (the collapsed
    // rows cannot tie member root N to private bag N); single-root publishes
    // keep the full collapse (see the P3.1 test above).
    const kas = [
      makeKA({ tokenId: 1n, rootEntity: 'did:dkg:entity:alice', publicTripleCount: 5, privateTripleCount: 2, privateMerkleRoot: new Uint8Array([1, 2]) }),
      makeKA({ tokenId: 2n, rootEntity: 'did:dkg:entity:bob', publicTripleCount: 3, privateTripleCount: 1, privateMerkleRoot: new Uint8Array([3, 4]) }),
      makeKA({ tokenId: 3n, rootEntity: 'did:dkg:entity:carol', publicTripleCount: 2 }),
    ];
    const quads = generateKCMetadata(makeMeta(), kas);

    // The UAL subject carries every member entity (single `dkg:rootEntity`
    // row — RFC ka-metadata-trim Phase 2 collapsed the §10.1 dual-write) …
    expect(new Set(quads.filter(q => q.subject === UAL && q.predicate === `${DKG}rootEntity`).map(q => q.object)))
      .toEqual(new Set(['did:dkg:entity:alice', 'did:dkg:entity:bob', 'did:dkg:entity:carol']));
    expect(quads.find(q => q.subject === UAL && q.predicate === `${DKG}entity`)).toBeUndefined();

    // … the aggregate private count, and EVERY per-root private merkle root.
    expect(quads.find(q => q.subject === UAL && q.predicate === `${DKG}privateTripleCount`)?.object)
      .toBe('"3"^^<http://www.w3.org/2001/XMLSchema#integer>');
    expect(new Set(quads.filter(q => q.subject === UAL && q.predicate === `${DKG}privateMerkleRoot`).map(q => q.object)))
      .toEqual(new Set(['"0102"', '"0304"']));

    // Multi-root: per-token pairing rows tie root N to private root N.
    expect(quads).toContainEqual(
      { subject: `${UAL}/1`, predicate: `${DKG}privateMerkleRoot`, object: '"0102"', graph: META_GRAPH },
    );
    expect(quads).toContainEqual(
      { subject: `${UAL}/2`, predicate: `${DKG}privateMerkleRoot`, object: '"0304"', graph: META_GRAPH },
    );
    expect(quads).toContainEqual(
      { subject: `${UAL}/3`, predicate: `${DKG}rootEntity`, object: 'did:dkg:entity:carol', graph: META_GRAPH },
    );
    // Token 3 (carol) has no private bag — no pairing row for it.
    expect(quads.find(q => q.subject === `${UAL}/3` && q.predicate === `${DKG}privateMerkleRoot`)).toBeUndefined();

    // RFC ka-metadata-trim: no publicTripleCount / tokenId / rdf:type anywhere
    // (those stay dropped — the re-emit covers only the pairing rows).
    expect(quads.find(q => q.predicate === `${DKG}publicTripleCount`)).toBeUndefined();
    expect(quads.find(q => q.predicate === `${DKG}tokenId`)).toBeUndefined();
    expect(quads.find(q => q.predicate === RDF_TYPE)).toBeUndefined();
  });

  it('GH #748 fallback: attribution is the peer-ID literal when neither agentAddress nor authorAddress is supplied', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    const attribution = quads.find(q => q.subject === UAL && q.predicate === `${PROV}wasAttributedTo`);
    expect(attribution).toBeDefined();
    expect(attribution!.object).toBe('"12D3KooWTestPeer"');
  });

  it('GH #748: attribution is the agent DID URI when agentAddress is supplied', () => {
    const ADDR = '0xaF7E932F79263f1A303790Bd6C01b096f5334BBB';
    const quads = generateKCMetadata(makeMeta({ agentAddress: ADDR }), [makeKA()]);
    const attribution = quads.find(q => q.subject === UAL && q.predicate === `${PROV}wasAttributedTo`);
    expect(attribution).toBeDefined();
    // GH #748 Codex round 3: EVM-shape addresses lowercased so the same
    // wallet doesn't split into multiple RDF subjects (see `agentDid()`
    // and `canonicalAgentDidSubject` in agent/profile.ts:20).
    expect(attribution!.object).toBe(`did:dkg:agent:${ADDR.toLowerCase()}`);
  });

  it('GH #748: attribution falls back to authorAddress when agentAddress is omitted', () => {
    const ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const quads = generateKCMetadata(
      makeMeta({ authorAddress: ADDR }),
      [makeKA()],
    );
    const attribution = quads.find(q => q.subject === UAL && q.predicate === `${PROV}wasAttributedTo`);
    expect(attribution).toBeDefined();
    // GH #748 Codex round 3: EVM-shape addresses lowercased so the same
    // wallet doesn't split into multiple RDF subjects (see `agentDid()`
    // and `canonicalAgentDidSubject` in agent/profile.ts:20).
    expect(attribution!.object).toBe(`did:dkg:agent:${ADDR.toLowerCase()}`);
  });

  it('GH #748 Codex round 7: zero-address authorAddress is treated as unattributed (no fake agent DID)', () => {
    // `publisherNodeIdentityIdOverride = 0` writes `authorAddress = 0x0…0`
    // as the sentinel for "no author". The fallback chain must NOT mint a
    // real-looking `did:dkg:agent:0x000…000` URI — fall through to the
    // peer-ID literal so downstream provenance correctly reflects the
    // unattributed publish.
    const ZERO = '0x0000000000000000000000000000000000000000';
    const quads = generateKCMetadata(
      makeMeta({ authorAddress: ZERO }),
      [makeKA()],
    );
    const attribution = quads.find(q => q.subject === UAL && q.predicate === `${PROV}wasAttributedTo`);
    expect(attribution).toBeDefined();
    // Must NOT be the synthesised zero-address agent DID.
    expect(attribution!.object).not.toBe(`did:dkg:agent:${ZERO}`);
    // Falls back to peer-ID literal — preserves the pre-fix unattributed shape.
    expect(attribution!.object).toBe('"12D3KooWTestPeer"');
  });

  it('GH #748 Codex round 7: zero-address with mixed casing also treated as unattributed', () => {
    // Sanity: case-insensitive zero-address detection.
    const ZERO_MIXED = '0x0000000000000000000000000000000000000000';
    const quads = generateKCMetadata(makeMeta({ agentAddress: ZERO_MIXED }), [makeKA()]);
    const attribution = quads.find(q => q.subject === UAL && q.predicate === `${PROV}wasAttributedTo`);
    expect(attribution!.object).toBe('"12D3KooWTestPeer"');
  });

  it('GH #748: explicit agentAddress takes precedence over authorAddress', () => {
    const AGENT = '0xaF7E932F79263f1A303790Bd6C01b096f5334BBB';
    const AUTHOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const quads = generateKCMetadata(
      makeMeta({ agentAddress: AGENT, authorAddress: AUTHOR }),
      [makeKA()],
    );
    const attribution = quads.find(q => q.subject === UAL && q.predicate === `${PROV}wasAttributedTo`);
    expect(attribution!.object).toBe(`did:dkg:agent:${AGENT.toLowerCase()}`);
  });
});

describe('generateKCMetadata — RFC ka-metadata-trim: no dkg:Publication mirror', () => {
  // The former RFC-001 §3.5 `dkg:Publication` provenance subject (and the
  // per-KA `dkg:publication` edge) had zero readers and was dropped in
  // Phase 1 — the on-chain `KnowledgeBatch.authorAddress` is canonical.

  const AUTHOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  it('never emits a publication subject, authoredBy or publication edge — even with authorAddress set', () => {
    const kas = [makeKA({ tokenId: 1n }), makeKA({ tokenId: 2n })];
    const quads = generateKCMetadata(makeMeta({ authorAddress: AUTHOR }), kas);
    expect(quads.find(q => q.subject.startsWith('urn:dkg:publication:'))).toBeUndefined();
    expect(quads.find(q => q.predicate === `${DKG}authoredBy`)).toBeUndefined();
    expect(quads.find(q => q.predicate === `${DKG}publication`)).toBeUndefined();
    expect(quads.find(q => q.predicate === `${DKG}publishOperationId`)).toBeUndefined();
  });
});

describe('generateTentativeMetadata', () => {
  it('adds dkg:status "tentative" quad', () => {
    const quads = generateTentativeMetadata(makeMeta(), [makeKA()]);
    const statusQuad = quads.find(q => q.predicate === `${DKG}status`);
    expect(statusQuad).toBeDefined();
    expect(statusQuad!.object).toBe('"tentative"');
  });

  it('includes all base KC metadata quads', () => {
    const base = generateKCMetadata(makeMeta(), [makeKA()]);
    const tentative = generateTentativeMetadata(makeMeta(), [makeKA()]);
    expect(tentative.length).toBe(base.length + 1);
  });
});

describe('getTentativeStatusQuad', () => {
  it('returns a single quad with correct graph and status', () => {
    const q = getTentativeStatusQuad(UAL, CONTEXT_GRAPH);
    expect(q.subject).toBe(UAL);
    expect(q.predicate).toBe(`${DKG}status`);
    expect(q.object).toBe('"tentative"');
    expect(q.graph).toBe(META_GRAPH);
  });
});

describe('getConfirmedStatusQuad', () => {
  it('returns a single quad with confirmed status', () => {
    const q = getConfirmedStatusQuad(UAL, CONTEXT_GRAPH);
    expect(q.subject).toBe(UAL);
    expect(q.predicate).toBe(`${DKG}status`);
    expect(q.object).toBe('"confirmed"');
    expect(q.graph).toBe(META_GRAPH);
  });
});

describe('generateConfirmedMetadata', () => {
  it('includes status, txHash and batchId; drops blockNumber/blockTimestamp/publisherAddress/chainId (Phase 1)', () => {
    const quads = generateConfirmedMetadata(UAL, CONTEXT_GRAPH, PROVENANCE);
    const preds = quads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}status`);
    expect(preds).toContain(`${DKG}transactionHash`);
    expect(preds).toContain(`${DKG}batchId`);
    expect(preds).not.toContain(`${DKG}blockNumber`);
    expect(preds).not.toContain(`${DKG}blockTimestamp`);
    expect(preds).not.toContain(`${DKG}publisherAddress`);
    expect(preds).not.toContain(`${DKG}chainId`);
  });

  it('all quads target the correct subject and meta graph', () => {
    const quads = generateConfirmedMetadata(UAL, CONTEXT_GRAPH, PROVENANCE);
    for (const q of quads) {
      expect(q.subject).toBe(UAL);
      expect(q.graph).toBe(META_GRAPH);
    }
  });
});

describe('generateConfirmedFullMetadata', () => {
  it('combines KC/KA structure with confirmed provenance', () => {
    const quads = generateConfirmedFullMetadata(makeMeta(), [makeKA()], PROVENANCE);
    const statusQuad = quads.find(q => q.predicate === `${DKG}status`);
    expect(statusQuad).toBeDefined();
    expect(statusQuad!.object).toBe('"confirmed"');

    // KC structure present (merkleRoot row; rdf:type rows were trimmed).
    const kcRoot = quads.find(q => q.subject === UAL && q.predicate === `${DKG}merkleRoot`);
    expect(kcRoot).toBeDefined();

    const txQuad = quads.find(q => q.predicate === `${DKG}transactionHash`);
    expect(txQuad).toBeDefined();
  });
});

describe('generateGraphKnowledgeAssetMetadata confirmation state', () => {
  it('preserves the tentative metadata shape without confirmation provenance', () => {
    const quads = generateGraphKnowledgeAssetMetadata(
      makeGraphMeta(),
      { status: 'tentative' },
    );
    const byPredicate = new Map(quads.map((quad) => [quad.predicate, quad.object]));

    expect(byPredicate.get(`${DKG}status`)).toBe('"tentative"');
    expect(byPredicate.has(`${DKG}transactionHash`)).toBe(false);
    expect(byPredicate.has(`${DKG}batchId`)).toBe(false);
    expect(byPredicate.has(`${DKG}materializedVersion`)).toBe(false);
  });

  it('preserves transaction-confirmed provenance', () => {
    const quads = generateGraphKnowledgeAssetMetadata(makeGraphMeta(), {
      status: 'confirmed',
      confirmation: { kind: 'transaction', provenance: PROVENANCE },
    });
    const byPredicate = new Map(quads.map((quad) => [quad.predicate, quad.object]));

    expect(byPredicate.get(`${DKG}status`)).toBe('"confirmed"');
    expect(byPredicate.get(`${DKG}transactionHash`)).toBe(`"${PROVENANCE.txHash}"`);
    expect(byPredicate.get(`${DKG}batchId`)).toContain('42');
    expect(byPredicate.has(`${DKG}materializedVersion`)).toBe(false);
  });

  it('preserves finalized-materialization provenance without a transaction claim', () => {
    const quads = generateGraphKnowledgeAssetMetadata(makeGraphMeta(), {
      status: 'confirmed',
      confirmation: {
        kind: 'finalized-materialization',
        provenance: {
          batchId: 7n,
          materializedVersion: { blockNumber: 123, txIndex: 4 },
        },
      },
    });
    const byPredicate = new Map(quads.map((quad) => [quad.predicate, quad.object]));

    expect(byPredicate.get(`${DKG}status`)).toBe('"confirmed"');
    expect(byPredicate.get(`${DKG}batchId`)).toContain('7');
    expect(byPredicate.get(`${DKG}materializedVersion`)).toBe('"123:4"');
    expect(byPredicate.has(`${DKG}transactionHash`)).toBe(false);
  });
});

describe('generateShareMetadata', () => {
  const wsMeta: ShareMetadata = {
    shareOperationId: 'op-123',
    contextGraphId: CONTEXT_GRAPH,
    rootEntities: ['did:dkg:entity:alice', 'did:dkg:entity:bob'],
    publisherPeerId: '12D3KooWTestPeer',
    timestamp: new Date('2026-03-01T00:00:00Z'),
  };
  const wsGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;

  it('generates correct workspace operation quads', () => {
    const quads = generateShareMetadata(wsMeta, wsGraph);
    const typeQuad = quads.find(q => q.predicate === RDF_TYPE);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${DKG}WorkspaceOperation`);
    expect(typeQuad!.graph).toBe(wsGraph);
  });

  it('includes a rootEntity quad for each entity', () => {
    const quads = generateShareMetadata(wsMeta, wsGraph);
    const rootQuads = quads.filter(q => q.predicate === `${DKG}rootEntity`);
    expect(rootQuads).toHaveLength(2);
    const objects = rootQuads.map(q => q.object);
    expect(objects).toContain('did:dkg:entity:alice');
    expect(objects).toContain('did:dkg:entity:bob');
  });

  it('includes publishedAt and attribution', () => {
    const quads = generateShareMetadata(wsMeta, wsGraph);
    const preds = quads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}publishedAt`);
    expect(preds).toContain('http://www.w3.org/ns/prov#wasAttributedTo');
  });

  it('GH #748 fallback: attribution is the peer-ID literal when agentAddress is omitted', () => {
    const quads = generateShareMetadata(wsMeta, wsGraph);
    const attribution = quads.find(q => q.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo');
    expect(attribution).toBeDefined();
    expect(attribution!.object).toBe('"12D3KooWTestPeer"');
  });

  it('GH #748: attribution is the agent DID URI when agentAddress is supplied', () => {
    const ADDR = '0xaF7E932F79263f1A303790Bd6C01b096f5334BBB';
    const quads = generateShareMetadata(
      { ...wsMeta, agentAddress: ADDR },
      wsGraph,
    );
    const attribution = quads.find(q => q.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo');
    expect(attribution).toBeDefined();
    // GH #748 Codex round 3: EVM-shape addresses lowercased to converge with
    // `canonicalAgentDidSubject` in agent/profile.ts:20.
    expect(attribution!.object).toBe(`did:dkg:agent:${ADDR.toLowerCase()}`);
    // The peer ID is still recorded separately for transport-layer audit.
    const peerIdQuad = quads.find(q => q.predicate === `${DKG}publisherPeerId`);
    expect(peerIdQuad!.object).toBe('"12D3KooWTestPeer"');
  });

  it('GH #748 Codex round 3: agentDid lowercases EVM-shape addresses, passes through non-EVM', () => {
    // EVM checksummed → lowercased (test via the share writer which calls agentDid)
    const checksummedAddr = '0xaF7E932F79263f1A303790Bd6C01b096f5334BBB';
    const lowerQuads = generateShareMetadata(
      { ...wsMeta, agentAddress: checksummedAddr.toLowerCase() }, wsGraph,
    );
    const upperQuads = generateShareMetadata(
      { ...wsMeta, agentAddress: checksummedAddr }, wsGraph,
    );
    const lowerAttr = lowerQuads.find(q => q.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo');
    const upperAttr = upperQuads.find(q => q.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo');
    // Same wallet, two casings, must converge on one DID.
    expect(lowerAttr!.object).toBe(upperAttr!.object);
    expect(lowerAttr!.object).toBe('did:dkg:agent:0xaf7e932f79263f1a303790bd6c01b096f5334bbb');
  });

  it('includes compact operation reference fields', () => {
    const quads = generateShareMetadata({ ...wsMeta, subGraphName: 'research' }, wsGraph);
    expect(quads).toContainEqual(expect.objectContaining({
      predicate: `${DKG}contextGraphId`,
      object: `"${CONTEXT_GRAPH}"`,
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      predicate: `${DKG}shareOperationId`,
      object: '"op-123"',
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      predicate: `${DKG}publisherPeerId`,
      object: '"12D3KooWTestPeer"',
    }));
    expect(quads).toContainEqual(expect.objectContaining({
      predicate: `${DKG}subGraphName`,
      object: '"research"',
    }));
  });
});

// RFC ka-metadata-trim Phase 1: `generateAuthorshipProof` was deleted (zero
// code readers; on-chain `KnowledgeBatch.authorAddress` is canonical) — its
// test block was removed with it.

// RFC ka-metadata-trim Phase 3 (P3.4): `generateShareTransitionMetadata` was
// deleted (the node-ui receipt hook reads the seal-subject receipt rows
// directly; old-store ShareTransition rows are covered by its read-both
// fallback) — its test block was removed with it.

describe('RFC ka-metadata-trim P3.3 — provenanceEvents gate', () => {
  const PROV_NS = 'http://www.w3.org/ns/prov#';
  const createdMeta = {
    contextGraphId: CONTEXT_GRAPH,
    agentAddress: '0x1234567890abcdef1234567890abcdef12345678',
    assertionName: 'lite-mode-ka',
    timestamp: new Date('2026-05-01T00:00:00Z'),
    kaNumber: 7n,
    reservedUal: 'did:dkg:hardhat:31337/0x1234567890abcdef1234567890abcdef12345678/7',
  };

  it('created: provenanceEvents=false skips the event node but keeps every state/identity row', () => {
    const quads = generateAssertionCreatedMetadata(createdMeta, { provenanceEvents: false });
    // No prov:Activity event rows at all.
    expect(quads.find(q => q.predicate === `${PROV_NS}startedAtTime`)).toBeUndefined();
    expect(quads.find(q => q.object === `${PROV_NS}Activity`)).toBeUndefined();
    expect(quads.find(q => q.subject.includes('/event/'))).toBeUndefined();
    // State/identity rows untouched.
    const preds = quads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}state`);
    expect(preds).toContain(`${DKG}memoryLayer`);
    expect(preds).toContain(`${DKG}assertionGraph`);
    expect(preds).toContain(`${DKG}assertionName`);
    expect(preds).toContain(`${DKG}kaId`);
    expect(preds).toContain(`${DKG}reservedUal`);
    expect(preds).toContain(`${PROV_NS}wasAttributedTo`);
  });

  it('created: defaults to writing the event node (flag omitted / true)', () => {
    for (const opts of [undefined, { provenanceEvents: true }]) {
      const quads = generateAssertionCreatedMetadata(createdMeta, opts);
      expect(quads.find(q => q.object === `${DKG}AssertionCreated`)).toBeDefined();
    }
  });

  it('promoted: provenanceEvents=false keeps the subject re-stamp + share operation id + member rows, skips the event', () => {
    const meta = {
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: createdMeta.agentAddress,
      assertionName: 'lite-mode-ka',
      kaNumber: 7n,
      shareOperationId: 'op-1',
      rootEntities: ['urn:test:root'],
      timestamp: new Date('2026-05-01T00:00:00Z'),
      merkleHex: 'ab'.repeat(32),
    };
    const { insert, delete: del } = generateAssertionPromotedMetadata(meta, { provenanceEvents: false });
    expect(insert.find(q => q.subject.includes('/event/'))).toBeUndefined();
    expect(insert).toContainEqual(expect.objectContaining({
      subject: assertionLifecycleUri(CONTEXT_GRAPH, createdMeta.agentAddress, 'lite-mode-ka'),
      predicate: `${DKG}shareOperationId`,
      object: '"op-1"',
    }));
    const subjectPreds = insert.map(q => q.predicate);
    expect(subjectPreds).toContain(`${DKG}state`);
    expect(subjectPreds).toContain(`${DKG}memoryLayer`);
    expect(subjectPreds).toContain(`${DKG}assertionGraph`);
    // SUBSTRATE-1 member stamp + SWM pointer always land on the subject.
    // RFC ka-metadata-trim Phase 2: single `dkg:rootEntity` row (the §10.1
    // `dkg:entity` dual-write was collapsed; readers stay read-both).
    expect(insert.find(q => q.predicate === `${DKG}rootEntity` && q.object === 'urn:test:root')).toBeDefined();
    expect(insert.find(q => q.predicate === `${DKG}entity`)).toBeUndefined();
    expect(insert.find(q => q.predicate === SWM_CURRENT_ASSERTION_PRED)).toBeDefined();
    // The delete set (state/layer/graph re-stamp) is unaffected.
    expect(del.length).toBeGreaterThan(0);
  });

  // Adversarial review F2 — discarded/updated took no LifecycleMetadataOptions
  // and wrote their event nodes unconditionally, bypassing lite mode.
  it('discarded: provenanceEvents=false keeps dkg:state "discarded", gates the event AND prov:wasInvalidatedBy', () => {
    const meta = {
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: createdMeta.agentAddress,
      assertionName: 'lite-mode-ka',
      timestamp: new Date('2026-05-01T00:00:00Z'),
    };
    const { insert, delete: del } = generateAssertionDiscardedMetadata(meta, { provenanceEvents: false });
    // No event node, and no dangling prov:wasInvalidatedBy edge pointing at it.
    expect(insert.find(q => q.subject.includes('/event/'))).toBeUndefined();
    expect(insert.find(q => q.predicate === `${PROV_NS}wasInvalidatedBy`)).toBeUndefined();
    expect(insert.find(q => q.object === `${PROV_NS}Activity`)).toBeUndefined();
    // The state change is ALWAYS recorded.
    expect(insert.find(q => q.predicate === `${DKG}state` && q.object === '"discarded"')).toBeDefined();
    // The delete set (created-state/WM-layer cleanup) is unaffected.
    expect(del.length).toBeGreaterThan(0);
  });

  it('discarded: defaults to writing the event node + prov:wasInvalidatedBy (flag omitted / true)', () => {
    const meta = {
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: createdMeta.agentAddress,
      assertionName: 'lite-mode-ka',
      timestamp: new Date('2026-05-01T00:00:00Z'),
    };
    for (const opts of [undefined, { provenanceEvents: true }]) {
      const { insert } = generateAssertionDiscardedMetadata(meta, opts);
      expect(insert.find(q => q.object === `${DKG}AssertionDiscarded`)).toBeDefined();
      expect(insert.find(q => q.predicate === `${PROV_NS}wasInvalidatedBy`)).toBeDefined();
    }
  });

  it('updated: provenanceEvents=false keeps state/layer/VM-pointer + revision chain, skips the event', () => {
    const meta = {
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: createdMeta.agentAddress,
      assertionName: 'lite-mode-ka',
      kcUal: 'did:dkg:hardhat:31337/0xstorage/42',
      timestamp: new Date('2026-05-01T00:00:00Z'),
      newMerkleHex: 'cd'.repeat(32),
      priorMerkleHex: 'ab'.repeat(32),
    };
    const { insert, delete: del } = generateAssertionUpdatedMetadata(meta, { provenanceEvents: false });
    expect(insert.find(q => q.subject.includes('/event/'))).toBeUndefined();
    expect(insert.find(q => q.predicate === `${DKG}kcUal`)).toBeUndefined();
    expect(insert.find(q => q.object === `${PROV_NS}Activity`)).toBeUndefined();
    // State/identity rows + the revision chain are ALWAYS written.
    const preds = insert.map(q => q.predicate);
    expect(preds).toContain(`${DKG}state`);
    expect(preds).toContain(`${DKG}memoryLayer`);
    expect(preds).toContain(VM_CURRENT_ASSERTION_PRED);
    expect(preds).toContain(`${PROV_NS}wasRevisionOf`);
    // Prior-pointer DELETE re-stamp is unaffected.
    expect(del.length).toBeGreaterThan(0);
  });

  it('updated: defaults to writing the event node (flag omitted / true)', () => {
    const meta = {
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: createdMeta.agentAddress,
      assertionName: 'lite-mode-ka',
      kcUal: 'did:dkg:hardhat:31337/0xstorage/42',
      timestamp: new Date('2026-05-01T00:00:00Z'),
      newMerkleHex: 'cd'.repeat(32),
    };
    for (const opts of [undefined, { provenanceEvents: true }]) {
      const { insert } = generateAssertionUpdatedMetadata(meta, opts);
      expect(insert.find(q => q.object === `${DKG}AssertionUpdated`)).toBeDefined();
    }
  });
});

// ── Assertion Lifecycle Metadata (Event-Sourced, PROV-O) ────────────────

const AGENT_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const AGENT_URI = `did:dkg:agent:${AGENT_ADDR}`;
const ASSERTION = 'game-turn-42';
const LIFECYCLE_URI = assertionLifecycleUri(CONTEXT_GRAPH, AGENT_ADDR, ASSERTION);
const ASSERTION_GRAPH = contextGraphAssertionUri(CONTEXT_GRAPH, AGENT_ADDR, ASSERTION);

function findEventUri(quads: { subject: string; predicate: string; object: string }[]): string {
  const q = quads.find(q => q.predicate === `${PROV}generated` && q.object === LIFECYCLE_URI);
  return q!.subject;
}

function findEventUriFromInsert(insert: { subject: string; predicate: string; object: string }[]): string {
  const q = insert.find(q => q.predicate === `${PROV}used` && q.object === LIFECYCLE_URI);
  return q!.subject;
}

describe('generateAssertionCreatedMetadata', () => {
  const meta: AssertionCreatedMeta = {
    contextGraphId: CONTEXT_GRAPH,
    agentAddress: AGENT_ADDR,
    assertionName: ASSERTION,
    timestamp: new Date('2026-04-15T10:00:00Z'),
  };

  it('RFC ka-metadata-trim: no entity-side type rows, contextGraph or wasGeneratedBy on the URN', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const urnQuads = quads.filter(q => q.subject === LIFECYCLE_URI);
    expect(urnQuads.find(q => q.predicate === RDF_TYPE)).toBeUndefined();
    expect(urnQuads.find(q => q.predicate === `${PROV}wasGeneratedBy`)).toBeUndefined();
    expect(urnQuads.find(q => q.predicate === `${DKG}contextGraph`)).toBeUndefined();
  });

  it('assertion entity uses prov:wasAttributedTo for agent', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const attr = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${PROV}wasAttributedTo`);
    expect(attr!.object).toBe(AGENT_URI);
  });

  it('assertion entity includes state "created" and memoryLayer "WM"', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const stateQuad = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}state`);
    const layerQuad = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}memoryLayer`);
    expect(stateQuad!.object).toBe('"created"');
    expect(layerQuad!.object).toBe(`"${MemoryLayer.WorkingMemory}"`);
  });

  it('assertion entity includes assertionGraph link', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const graphQuad = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}assertionGraph`);
    expect(graphQuad!.object).toBe(ASSERTION_GRAPH);
  });

  it('D1: stamps kaId + reservedUal on the URN when the number is minted at create', () => {
    const ual = `did:dkg:31337/${AGENT_ADDR}/7`;
    const quads = generateAssertionCreatedMetadata({ ...meta, kaNumber: 7, reservedUal: ual });
    const kaId = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}kaId`);
    expect(kaId!.object).toBe('"7"^^<http://www.w3.org/2001/XMLSchema#integer>');
    const ru = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}reservedUal`);
    expect(ru!.object).toBe(`"${ual}"`);
  });

  it('D1: omits kaId/reservedUal when not minted (no-op for callers that have not adopted create-time allocation)', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    expect(quads.find(q => q.predicate === `${DKG}kaId`)).toBeUndefined();
    expect(quads.find(q => q.predicate === `${DKG}reservedUal`)).toBeUndefined();
  });

  it('event entity is dual-typed prov:Activity + dkg:AssertionCreated', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const eventUri = findEventUri(quads);
    const types = quads.filter(q => q.subject === eventUri && q.predicate === RDF_TYPE).map(q => q.object);
    expect(types).toContain(`${PROV}Activity`);
    expect(types).toContain(`${DKG}AssertionCreated`);
  });

  it('event uses prov:startedAtTime; RFC ka-metadata-trim Phase 2 drops prov:wasAssociatedWith (subject wasAttributedTo is the fallback)', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const eventUri = findEventUri(quads);
    const time = quads.find(q => q.subject === eventUri && q.predicate === `${PROV}startedAtTime`);
    expect(time).toBeDefined();
    expect(time!.object).toContain('2026-04-15');
    expect(quads.find(q => q.subject === eventUri && q.predicate === `${PROV}wasAssociatedWith`)).toBeUndefined();
    // The agent stays resolvable from the subject's attribution row.
    expect(quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${PROV}wasAttributedTo`)!.object).toBe(AGENT_URI);
  });

  it('RFC ka-metadata-trim Phase 2: no fromLayer/toLayer rows (derived from the event class by readers)', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const eventUri = findEventUri(quads);
    expect(quads.find(q => q.subject === eventUri && q.predicate === `${DKG}fromLayer`)).toBeUndefined();
    expect(quads.find(q => q.subject === eventUri && q.predicate === `${DKG}toLayer`)).toBeUndefined();
  });

  it('all quads target the _meta graph', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    for (const q of quads) {
      expect(q.graph).toBe(META_GRAPH);
    }
  });

  it('emits dkg:subGraphName on the assertion subject when scoped to a sub-graph', () => {
    const scopedLifecycleUri = assertionLifecycleUri(CONTEXT_GRAPH, AGENT_ADDR, ASSERTION, 'players');
    const quads = generateAssertionCreatedMetadata({ ...meta, subGraphName: 'players' });
    expect(quads).toContainEqual(expect.objectContaining({
      subject: scopedLifecycleUri,
      predicate: `${DKG}subGraphName`,
      object: '"players"',
      graph: META_GRAPH,
    }));
  });

  it('omits dkg:subGraphName when assertion is in the root bucket', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    expect(quads.find(q => q.predicate === `${DKG}subGraphName`)).toBeUndefined();
  });
});

describe('generateAssertionPromotedMetadata', () => {
  const meta: AssertionPromotedMeta = {
    contextGraphId: CONTEXT_GRAPH,
    agentAddress: AGENT_ADDR,
    assertionName: ASSERTION,
    shareOperationId: 'op-123',
    rootEntities: ['urn:test:alice', 'urn:test:bob'],
    timestamp: new Date('2026-04-15T10:05:00Z'),
  };

  it('transitions state created → promoted and layer WM → SWM', () => {
    const { insert, delete: del } = generateAssertionPromotedMetadata(meta);
    expect(insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}state`)!.object).toBe('"promoted"');
    expect(del.find(q => q.predicate === `${DKG}state`)!.object).toBe('"created"');
    expect(insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}memoryLayer`)!.object).toBe(`"${MemoryLayer.SharedWorkingMemory}"`);
    expect(del.find(q => q.predicate === `${DKG}memoryLayer`)!.object).toBe(`"${MemoryLayer.WorkingMemory}"`);
  });

  it('SUBSTRATE-2: re-stamps dkg:assertionGraph from the WM graph to the SWM graph on promote', () => {
    const { insert, delete: del } = generateAssertionPromotedMetadata(meta);
    const wmGraph = contextGraphAssertionUri(CONTEXT_GRAPH, AGENT_ADDR, ASSERTION);
    const swmGraph = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    // the stale WM-layer pointer is deleted
    expect(del).toContainEqual(expect.objectContaining({
      subject: LIFECYCLE_URI, predicate: `${DKG}assertionGraph`, object: wmGraph, graph: META_GRAPH,
    }));
    // the layer-correct SWM pointer is inserted
    expect(insert).toContainEqual(expect.objectContaining({
      subject: LIFECYCLE_URI, predicate: `${DKG}assertionGraph`, object: swmGraph, graph: META_GRAPH,
    }));
    // exactly one assertionGraph value is written (no duplicate/stale pointer)
    expect(insert.filter(q => q.predicate === `${DKG}assertionGraph`)).toHaveLength(1);
  });

  it('SUBSTRATE-2: re-stamps to the sub-graph-scoped SWM graph when scoped', () => {
    const swmScoped = contextGraphSharedMemoryUri(CONTEXT_GRAPH, 'players');
    const { insert } = generateAssertionPromotedMetadata({ ...meta, subGraphName: 'players' });
    expect(insert.find(q => q.predicate === `${DKG}assertionGraph`)!.object).toBe(swmScoped);
  });

  it('SUBSTRATE-1: stamps member-entity membership (single dkg:rootEntity) on the lifecycle URN', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    for (const entity of meta.rootEntities) {
      // the membership row on the stable URN (what the _meta index binds).
      // RFC ka-metadata-trim Phase 2: the §10.1 `dkg:entity` dual-write was
      // collapsed back to the single `dkg:rootEntity` row; readers stay
      // read-both (ENTITY_PRED_ALT) for dual-written replica rows.
      expect(insert).toContainEqual(expect.objectContaining({
        subject: LIFECYCLE_URI, predicate: `${DKG}rootEntity`, object: entity, graph: META_GRAPH,
      }));
      expect(insert.find(q => q.predicate === `${DKG}entity` && q.object === entity)).toBeUndefined();
    }
  });

  it('event is prov:Activity + dkg:AssertionPromoted with prov:used', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    const types = insert.filter(q => q.subject === eventUri && q.predicate === RDF_TYPE).map(q => q.object);
    expect(types).toContain(`${PROV}Activity`);
    expect(types).toContain(`${DKG}AssertionPromoted`);
  });

  it('event uses prov:startedAtTime; RFC ka-metadata-trim Phase 2 drops prov:wasAssociatedWith', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${PROV}startedAtTime`)).toBeDefined();
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${PROV}wasAssociatedWith`)).toBeUndefined();
  });

  it('RFC ka-metadata-trim Phase 2: no fromLayer/toLayer rows (AssertionPromoted ⇒ WM→SWM, derived by readers)', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}fromLayer`)).toBeUndefined();
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}toLayer`)).toBeUndefined();
  });

  it('event includes shareOperationId; member entities live on the stable subject, not the event', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}shareOperationId`)!.object).toBe('"op-123"');
    // RFC ka-metadata-trim Phase 2: the event node no longer duplicates the
    // member list — history/feed readers fall back to the SUBSTRATE-1
    // subject-side stamp (read-both with old-store event rows).
    expect(insert.filter(q => q.subject === eventUri && q.predicate === `${DKG}rootEntity`)).toHaveLength(0);
    const subjectEntities = insert.filter(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}rootEntity`);
    expect(subjectEntities.map(q => q.object)).toContain('urn:test:alice');
    expect(subjectEntities.map(q => q.object)).toContain('urn:test:bob');
  });

  it('emits dkg:subGraphName on the assertion subject when scoped to a sub-graph', () => {
    const scopedLifecycleUri = assertionLifecycleUri(CONTEXT_GRAPH, AGENT_ADDR, ASSERTION, 'players');
    const { insert } = generateAssertionPromotedMetadata({ ...meta, subGraphName: 'players' });
    expect(insert).toContainEqual(expect.objectContaining({
      subject: scopedLifecycleUri,
      predicate: `${DKG}subGraphName`,
      object: '"players"',
      graph: META_GRAPH,
    }));
  });

  it('omits dkg:subGraphName when assertion is in the root bucket', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    expect(insert.find(q => q.predicate === `${DKG}subGraphName`)).toBeUndefined();
  });
});

// RFC ka-metadata-trim Phase 0: `generateAssertionPublishedMetadata` was
// deleted (its only caller was a dead SPARQL gate that never fired; the
// SWM→VM flip is imperative in dkg-agent-publish.ts) — its test block was
// removed with it.

describe('generateAssertionDiscardedMetadata', () => {
  const meta: AssertionDiscardedMeta = {
    contextGraphId: CONTEXT_GRAPH,
    agentAddress: AGENT_ADDR,
    assertionName: ASSERTION,
    timestamp: new Date('2026-04-15T10:15:00Z'),
  };

  it('transitions state created → discarded and removes memoryLayer', () => {
    const { insert, delete: del } = generateAssertionDiscardedMetadata(meta);
    expect(insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}state`)!.object).toBe('"discarded"');
    expect(del.find(q => q.predicate === `${DKG}state`)!.object).toBe('"created"');
    expect(del.find(q => q.predicate === `${DKG}memoryLayer`)!.object).toBe(`"${MemoryLayer.WorkingMemory}"`);
  });

  it('uses prov:wasInvalidatedBy to link assertion to discard event', () => {
    const { insert } = generateAssertionDiscardedMetadata(meta);
    const inv = insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${PROV}wasInvalidatedBy`);
    expect(inv).toBeDefined();
  });

  it('RFC ka-metadata-trim Phase 2: no fromLayer/toLayer rows (AssertionDiscarded ⇒ WM→none, derived by readers)', () => {
    const { insert } = generateAssertionDiscardedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}fromLayer`)).toBeUndefined();
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}toLayer`)).toBeUndefined();
  });

  it('emits dkg:subGraphName on the assertion subject when scoped to a sub-graph', () => {
    const scopedLifecycleUri = assertionLifecycleUri(CONTEXT_GRAPH, AGENT_ADDR, ASSERTION, 'players');
    const { insert } = generateAssertionDiscardedMetadata({ ...meta, subGraphName: 'players' });
    expect(insert).toContainEqual(expect.objectContaining({
      subject: scopedLifecycleUri,
      predicate: `${DKG}subGraphName`,
      object: '"players"',
      graph: META_GRAPH,
    }));
  });

  it('omits dkg:subGraphName when assertion is in the root bucket', () => {
    const { insert } = generateAssertionDiscardedMetadata(meta);
    expect(insert.find(q => q.predicate === `${DKG}subGraphName`)).toBeUndefined();
  });
});

describe('assertionStateQuad', () => {
  it('produces a quad with dkg:state predicate and correct value', () => {
    const q = assertionStateQuad(LIFECYCLE_URI, 'promoted', META_GRAPH);
    expect(q.subject).toBe(LIFECYCLE_URI);
    expect(q.predicate).toBe(`${DKG}state`);
    expect(q.object).toBe('"promoted"');
    expect(q.graph).toBe(META_GRAPH);
  });
});

describe('assertionLayerQuad', () => {
  it('produces a quad with dkg:memoryLayer predicate and correct value', () => {
    const q = assertionLayerQuad(LIFECYCLE_URI, MemoryLayer.SharedWorkingMemory, META_GRAPH);
    expect(q.subject).toBe(LIFECYCLE_URI);
    expect(q.predicate).toBe(`${DKG}memoryLayer`);
    expect(q.object).toBe(`"${MemoryLayer.SharedWorkingMemory}"`);
    expect(q.graph).toBe(META_GRAPH);
  });
});

// ── OT-RFC-43 A2 — per-layer pointers, deriveStatus, update provenance ──────

describe('deriveStatus (OT-RFC-43 §10.5.4)', () => {
  it('returns draft-open when no pointers/state', () => {
    expect(deriveStatus({})).toBe('draft-open');
  });
  it('returns wm-sealed when only WM pointer is set (overall)', () => {
    expect(deriveStatus({ wmCurrentAssertion: 'aa' })).toBe('wm-sealed');
  });
  it('returns swm-shared when SWM pointer set (overall)', () => {
    expect(deriveStatus({ wmCurrentAssertion: 'aa', swmCurrentAssertion: 'aa' })).toBe('swm-shared');
  });
  it('returns vm-confirmed when VM pointer set (overall)', () => {
    expect(deriveStatus({ wmCurrentAssertion: 'aa', swmCurrentAssertion: 'aa', vmCurrentAssertion: 'aa' })).toBe('vm-confirmed');
  });
  it('per-layer status reflects THAT layer (divergence observable)', () => {
    // WM ahead of VM: WM has a newer merkle, VM still on the old one.
    const p = { wmCurrentAssertion: 'bb', swmCurrentAssertion: 'aa', vmCurrentAssertion: 'aa' };
    expect(deriveStatus(p, 'wm')).toBe('wm-sealed');
    expect(deriveStatus(p, 'swm')).toBe('swm-shared');
    expect(deriveStatus(p, 'vm')).toBe('vm-confirmed');
  });
  it('per-layer vm is draft-open when never confirmed', () => {
    expect(deriveStatus({ wmCurrentAssertion: 'aa' }, 'vm')).toBe('draft-open');
  });
  it('honors state when pointers are absent (back-compat)', () => {
    expect(deriveStatus({ state: 'promoted' })).toBe('swm-shared');
    expect(deriveStatus({ state: 'published' })).toBe('vm-confirmed');
  });
});

describe('assertionLayerPointerQuad / stampLayerPointerSparql', () => {
  it('strips a 0x prefix from the merkle hex', () => {
    const q = assertionLayerPointerQuad(LIFECYCLE_URI, WM_CURRENT_ASSERTION_PRED, '0xdeadbeef', META_GRAPH);
    expect(q.subject).toBe(LIFECYCLE_URI);
    expect(q.predicate).toBe(WM_CURRENT_ASSERTION_PRED);
    expect(q.object).toBe('"deadbeef"');
    expect(q.graph).toBe(META_GRAPH);
  });
  it('emits a DELETE/INSERT SPARQL for an idempotent re-stamp', () => {
    const sparql = stampLayerPointerSparql(LIFECYCLE_URI, VM_CURRENT_ASSERTION_PRED, 'cafe', META_GRAPH);
    expect(sparql).toContain('DELETE');
    expect(sparql).toContain('INSERT');
    expect(sparql).toContain(VM_CURRENT_ASSERTION_PRED);
    expect(sparql).toContain('"cafe"');
  });
});

describe('generateAssertionUpdatedMetadata (OT-RFC-43 A2 §4 provenance)', () => {
  const baseMeta = {
    contextGraphId: CONTEXT_GRAPH,
    agentAddress: AGENT_ADDR,
    assertionName: ASSERTION,
    kcUal: 'did:dkg:31337/0xpub/77',
    timestamp: new Date('2026-06-01T00:00:00Z'),
    newMerkleHex: 'bbbb',
    priorMerkleHex: 'aaaa',
  };

  it('re-stamps the VM pointer to the new merkle; no convergent WM copy (RFC ka-metadata-trim Phase 2)', () => {
    const { insert } = generateAssertionUpdatedMetadata(baseMeta);
    const vm = insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === VM_CURRENT_ASSERTION_PRED);
    const wm = insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === WM_CURRENT_ASSERTION_PRED);
    expect(vm?.object).toBe('"bbbb"');
    // WM converges back to VM after the update mint; the wm/swm pointers are
    // only materialised when they DIVERGE from VM. Readers COALESCE a
    // missing wm pointer to the vm value.
    expect(wm).toBeUndefined();
  });
  it('emits prov:wasRevisionOf linking the new lifecycle to the prior version', () => {
    const { insert } = generateAssertionUpdatedMetadata(baseMeta);
    const rev = insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === PROV_WAS_REVISION_OF);
    expect(rev).toBeDefined();
    expect(rev!.object).toContain('aaaa');
    // prior version subject is self-describing (vmCurrentAssertion = prior merkle)
    const priorVm = insert.find(q => q.object === '"aaaa"' && q.predicate === VM_CURRENT_ASSERTION_PRED);
    expect(priorVm).toBeDefined();
  });
  it('deletes the prior VM/WM pointer values so the re-stamp is unambiguous', () => {
    const { delete: del } = generateAssertionUpdatedMetadata(baseMeta);
    expect(del.find(q => q.predicate === VM_CURRENT_ASSERTION_PRED && q.object === '"aaaa"')).toBeDefined();
    expect(del.find(q => q.predicate === WM_CURRENT_ASSERTION_PRED && q.object === '"aaaa"')).toBeDefined();
  });
});

describe('generateAssertionPromotedMetadata pointer stamping', () => {
  it('stamps swmCurrentAssertion when merkleHex supplied at promote', () => {
    const { insert } = generateAssertionPromotedMetadata({
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: AGENT_ADDR,
      assertionName: ASSERTION,
      shareOperationId: 'op-1',
      rootEntities: ['urn:e:1'],
      timestamp: new Date('2026-06-01T00:00:00Z'),
      merkleHex: 'feed',
    });
    expect(insert.find(q => q.predicate === SWM_CURRENT_ASSERTION_PRED && q.object === '"feed"')).toBeDefined();
  });
  it('omits the SWM pointer when merkleHex is absent (back-compat)', () => {
    const { insert } = generateAssertionPromotedMetadata({
      contextGraphId: CONTEXT_GRAPH,
      agentAddress: AGENT_ADDR,
      assertionName: ASSERTION,
      shareOperationId: 'op-2',
      rootEntities: ['urn:e:1'],
      timestamp: new Date('2026-06-01T00:00:00Z'),
    });
    expect(insert.find(q => q.predicate === SWM_CURRENT_ASSERTION_PRED)).toBeUndefined();
  });
});
