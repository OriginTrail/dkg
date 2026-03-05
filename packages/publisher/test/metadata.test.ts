import { describe, it, expect } from 'vitest';
import {
  generateKCMetadata,
  generateTentativeMetadata,
  getTentativeStatusQuad,
  getConfirmedStatusQuad,
  generateConfirmedMetadata,
  generateConfirmedFullMetadata,
  generateWorkspaceMetadata,
  type KCMetadata,
  type KAMetadata,
  type OnChainProvenance,
  type WorkspaceMetadata,
} from '../src/metadata.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'http://dkg.io/ontology/';

const PARANET = 'agent-registry';
const META_GRAPH = `did:dkg:paranet:${PARANET}/_meta`;
const UAL = 'did:dkg:kc:test-kc-001';

function makeMeta(overrides?: Partial<KCMetadata>): KCMetadata {
  return {
    ual: UAL,
    paranetId: PARANET,
    merkleRoot: new Uint8Array([0xab, 0xcd, 0xef]),
    kaCount: 2,
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

describe('generateKCMetadata', () => {
  it('returns quads with correct rdf:type for KC', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    const typeQuad = quads.find(q => q.subject === UAL && q.predicate === RDF_TYPE);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${DKG}KnowledgeCollection`);
  });

  it('includes merkleRoot, kaCount, and paranet', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    const predicates = quads.filter(q => q.subject === UAL).map(q => q.predicate);
    expect(predicates).toContain(`${DKG}merkleRoot`);
    expect(predicates).toContain(`${DKG}kaCount`);
    expect(predicates).toContain(`${DKG}paranet`);
  });

  it('all quads use the correct meta graph', () => {
    const quads = generateKCMetadata(makeMeta(), [makeKA()]);
    for (const q of quads) {
      expect(q.graph).toBe(META_GRAPH);
    }
  });

  it('generates KA quads with tokenId, rootEntity, and partOf', () => {
    const ka = makeKA({ tokenId: 7n });
    const quads = generateKCMetadata(makeMeta(), [ka]);
    const kaUri = `${UAL}/7`;
    const kaQuads = quads.filter(q => q.subject === kaUri);
    const predicates = kaQuads.map(q => q.predicate);

    expect(predicates).toContain(RDF_TYPE);
    expect(predicates).toContain(`${DKG}rootEntity`);
    expect(predicates).toContain(`${DKG}partOf`);
    expect(predicates).toContain(`${DKG}tokenId`);
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

  it('handles multiple KA entries', () => {
    const kas = [makeKA({ tokenId: 1n }), makeKA({ tokenId: 2n, rootEntity: 'did:dkg:entity:bob' })];
    const quads = generateKCMetadata(makeMeta({ kaCount: 2 }), kas);
    const kaSubjects = new Set(quads.filter(q => q.predicate === RDF_TYPE && q.object === `${DKG}KnowledgeAsset`).map(q => q.subject));
    expect(kaSubjects.size).toBe(2);
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
    const q = getTentativeStatusQuad(UAL, PARANET);
    expect(q.subject).toBe(UAL);
    expect(q.predicate).toBe(`${DKG}status`);
    expect(q.object).toBe('"tentative"');
    expect(q.graph).toBe(META_GRAPH);
  });
});

describe('getConfirmedStatusQuad', () => {
  it('returns a single quad with confirmed status', () => {
    const q = getConfirmedStatusQuad(UAL, PARANET);
    expect(q.subject).toBe(UAL);
    expect(q.predicate).toBe(`${DKG}status`);
    expect(q.object).toBe('"confirmed"');
    expect(q.graph).toBe(META_GRAPH);
  });
});

describe('generateConfirmedMetadata', () => {
  it('includes txHash, blockNumber, publisherAddress, chainId, batchId', () => {
    const quads = generateConfirmedMetadata(UAL, PARANET, PROVENANCE);
    const preds = quads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}status`);
    expect(preds).toContain(`${DKG}transactionHash`);
    expect(preds).toContain(`${DKG}blockNumber`);
    expect(preds).toContain(`${DKG}publisherAddress`);
    expect(preds).toContain(`${DKG}chainId`);
    expect(preds).toContain(`${DKG}batchId`);
  });

  it('all quads target the correct subject and meta graph', () => {
    const quads = generateConfirmedMetadata(UAL, PARANET, PROVENANCE);
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

    const kcType = quads.find(q => q.subject === UAL && q.predicate === RDF_TYPE);
    expect(kcType).toBeDefined();

    const txQuad = quads.find(q => q.predicate === `${DKG}transactionHash`);
    expect(txQuad).toBeDefined();
  });
});

describe('generateWorkspaceMetadata', () => {
  const wsMeta: WorkspaceMetadata = {
    workspaceOperationId: 'op-123',
    paranetId: PARANET,
    rootEntities: ['did:dkg:entity:alice', 'did:dkg:entity:bob'],
    publisherPeerId: '12D3KooWTestPeer',
    timestamp: new Date('2026-03-01T00:00:00Z'),
  };
  const wsGraph = `did:dkg:paranet:${PARANET}/_workspace_meta`;

  it('generates correct workspace operation quads', () => {
    const quads = generateWorkspaceMetadata(wsMeta, wsGraph);
    const typeQuad = quads.find(q => q.predicate === RDF_TYPE);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${DKG}WorkspaceOperation`);
    expect(typeQuad!.graph).toBe(wsGraph);
  });

  it('includes a rootEntity quad for each entity', () => {
    const quads = generateWorkspaceMetadata(wsMeta, wsGraph);
    const rootQuads = quads.filter(q => q.predicate === `${DKG}rootEntity`);
    expect(rootQuads).toHaveLength(2);
    const objects = rootQuads.map(q => q.object);
    expect(objects).toContain('did:dkg:entity:alice');
    expect(objects).toContain('did:dkg:entity:bob');
  });

  it('includes publishedAt and attribution', () => {
    const quads = generateWorkspaceMetadata(wsMeta, wsGraph);
    const preds = quads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}publishedAt`);
    expect(preds).toContain('http://www.w3.org/ns/prov#wasAttributedTo');
  });
});
