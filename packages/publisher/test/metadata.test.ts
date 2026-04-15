import { describe, it, expect } from 'vitest';
import {
  generateKCMetadata,
  generateTentativeMetadata,
  getTentativeStatusQuad,
  getConfirmedStatusQuad,
  generateConfirmedMetadata,
  generateConfirmedFullMetadata,
  generateShareMetadata,
  generateAuthorshipProof,
  generateShareTransitionMetadata,
  generateAssertionCreatedMetadata,
  generateAssertionPromotedMetadata,
  generateAssertionPublishedMetadata,
  generateAssertionDiscardedMetadata,
  assertionStateQuad,
  assertionLayerQuad,
  type KCMetadata,
  type KAMetadata,
  type OnChainProvenance,
  type ShareMetadata,
  type AuthorshipProof,
  type ShareTransitionMetadata,
  type AssertionCreatedMeta,
  type AssertionPromotedMeta,
  type AssertionPublishedMeta,
  type AssertionDiscardedMeta,
} from '../src/metadata.js';
import { assertionLifecycleUri, contextGraphAssertionUri, MemoryLayer } from '@origintrail-official/dkg-core';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

const PARANET = 'agent-registry';
const META_GRAPH = `did:dkg:context-graph:${PARANET}/_meta`;
const UAL = 'did:dkg:kc:test-kc-001';

function makeMeta(overrides?: Partial<KCMetadata>): KCMetadata {
  return {
    ual: UAL,
    contextGraphId: PARANET,
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

describe('generateShareMetadata', () => {
  const wsMeta: ShareMetadata = {
    shareOperationId: 'op-123',
    contextGraphId: PARANET,
    rootEntities: ['did:dkg:entity:alice', 'did:dkg:entity:bob'],
    publisherPeerId: '12D3KooWTestPeer',
    timestamp: new Date('2026-03-01T00:00:00Z'),
  };
  const wsGraph = `did:dkg:context-graph:${PARANET}/_shared_memory_meta`;

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
});

describe('generateAuthorshipProof', () => {
  const proof: AuthorshipProof = {
    kcUal: UAL,
    contextGraphId: PARANET,
    agentAddress: '0x1234567890abcdef1234567890abcdef12345678',
    signature: '0xdeadbeef01234567',
    signedHash: '0xabcdef1234567890',
  };

  it('generates authoredBy link from KC to blank node', () => {
    const quads = generateAuthorshipProof(proof);
    const authoredBy = quads.find(q => q.subject === UAL && q.predicate === `${DKG}authoredBy`);
    expect(authoredBy).toBeDefined();
    expect(authoredBy!.object).toMatch(/^_:/);
  });

  it('blank node has AuthorshipProof type', () => {
    const quads = generateAuthorshipProof(proof);
    const authoredBy = quads.find(q => q.subject === UAL && q.predicate === `${DKG}authoredBy`)!;
    const blankNode = authoredBy.object;
    const typeQuad = quads.find(q => q.subject === blankNode && q.predicate === RDF_TYPE);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${DKG}AuthorshipProof`);
  });

  it('includes agent DID, signature, and signedHash', () => {
    const quads = generateAuthorshipProof(proof);
    const authoredBy = quads.find(q => q.subject === UAL && q.predicate === `${DKG}authoredBy`)!;
    const blankNode = authoredBy.object;
    const bnQuads = quads.filter(q => q.subject === blankNode);
    const preds = bnQuads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}agent`);
    expect(preds).toContain(`${DKG}signature`);
    expect(preds).toContain(`${DKG}signedHash`);
  });

  it('agent value is a did:dkg:agent URI', () => {
    const quads = generateAuthorshipProof(proof);
    const agentQuad = quads.find(q => q.predicate === `${DKG}agent`);
    expect(agentQuad).toBeDefined();
    expect(agentQuad!.object).toBe(`did:dkg:agent:${proof.agentAddress}`);
  });

  it('all quads target the correct meta graph', () => {
    const quads = generateAuthorshipProof(proof);
    for (const q of quads) {
      expect(q.graph).toBe(META_GRAPH);
    }
  });

  it('returns exactly 5 quads', () => {
    const quads = generateAuthorshipProof(proof);
    expect(quads).toHaveLength(5);
  });
});

describe('generateShareTransitionMetadata', () => {
  const shareMeta: ShareTransitionMetadata = {
    contextGraphId: PARANET,
    operationId: 'op-share-001',
    agentAddress: '0x1234567890abcdef1234567890abcdef12345678',
    assertionName: 'my-assertion',
    entities: ['urn:test:entity:alice', 'urn:test:entity:bob'],
    timestamp: new Date('2026-04-01T00:00:00Z'),
  };
  const SWM_META_GRAPH = `did:dkg:context-graph:${PARANET}/_shared_memory_meta`;

  it('generates ShareTransition with correct type', () => {
    const quads = generateShareTransitionMetadata(shareMeta);
    const typeQuad = quads.find(q => q.predicate === RDF_TYPE);
    expect(typeQuad).toBeDefined();
    expect(typeQuad!.object).toBe(`${DKG}ShareTransition`);
  });

  it('subject is urn:dkg:share:{operationId}', () => {
    const quads = generateShareTransitionMetadata(shareMeta);
    const subject = quads[0].subject;
    expect(subject).toBe('urn:dkg:share:op-share-001');
  });

  it('includes source, agent, timestamp, and entities', () => {
    const quads = generateShareTransitionMetadata(shareMeta);
    const preds = quads.map(q => q.predicate);
    expect(preds).toContain(`${DKG}source`);
    expect(preds).toContain(`${DKG}agent`);
    expect(preds).toContain(`${DKG}timestamp`);
    expect(preds).toContain(`${DKG}entities`);
  });

  it('source includes assertion path with agent and name', () => {
    const quads = generateShareTransitionMetadata(shareMeta);
    const sourceQuad = quads.find(q => q.predicate === `${DKG}source`);
    expect(sourceQuad!.object).toContain('assertion/');
    expect(sourceQuad!.object).toContain(shareMeta.agentAddress);
    expect(sourceQuad!.object).toContain(shareMeta.assertionName);
  });

  it('generates one entity quad per entity', () => {
    const quads = generateShareTransitionMetadata(shareMeta);
    const entityQuads = quads.filter(q => q.predicate === `${DKG}entities`);
    expect(entityQuads).toHaveLength(2);
    const entities = entityQuads.map(q => q.object);
    expect(entities).toContain('urn:test:entity:alice');
    expect(entities).toContain('urn:test:entity:bob');
  });

  it('all quads target the _shared_memory_meta graph', () => {
    const quads = generateShareTransitionMetadata(shareMeta);
    for (const q of quads) {
      expect(q.graph).toBe(SWM_META_GRAPH);
    }
  });
});

// ── Assertion Lifecycle Metadata (Event-Sourced, PROV-O) ────────────────

const AGENT_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const AGENT_URI = `did:dkg:agent:${AGENT_ADDR}`;
const ASSERTION = 'game-turn-42';
const LIFECYCLE_URI = assertionLifecycleUri(PARANET, AGENT_ADDR, ASSERTION);
const ASSERTION_GRAPH = contextGraphAssertionUri(PARANET, AGENT_ADDR, ASSERTION);

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
    contextGraphId: PARANET,
    agentAddress: AGENT_ADDR,
    assertionName: ASSERTION,
    timestamp: new Date('2026-04-15T10:00:00Z'),
  };

  it('assertion entity is dual-typed prov:Entity + dkg:Assertion', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const types = quads.filter(q => q.subject === LIFECYCLE_URI && q.predicate === RDF_TYPE).map(q => q.object);
    expect(types).toContain(`${PROV}Entity`);
    expect(types).toContain(`${DKG}Assertion`);
  });

  it('assertion entity uses prov:wasAttributedTo for agent', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const attr = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${PROV}wasAttributedTo`);
    expect(attr!.object).toBe(AGENT_URI);
  });

  it('assertion entity uses prov:wasGeneratedBy to link to creation event', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const genBy = quads.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${PROV}wasGeneratedBy`);
    expect(genBy).toBeDefined();
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

  it('event entity is dual-typed prov:Activity + dkg:AssertionCreated', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const eventUri = findEventUri(quads);
    const types = quads.filter(q => q.subject === eventUri && q.predicate === RDF_TYPE).map(q => q.object);
    expect(types).toContain(`${PROV}Activity`);
    expect(types).toContain(`${DKG}AssertionCreated`);
  });

  it('event uses prov:startedAtTime and prov:wasAssociatedWith', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const eventUri = findEventUri(quads);
    const time = quads.find(q => q.subject === eventUri && q.predicate === `${PROV}startedAtTime`);
    expect(time).toBeDefined();
    expect(time!.object).toContain('2026-04-15');
    const assoc = quads.find(q => q.subject === eventUri && q.predicate === `${PROV}wasAssociatedWith`);
    expect(assoc!.object).toBe(AGENT_URI);
  });

  it('event includes DKG layer transition (fromLayer/toLayer)', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    const eventUri = findEventUri(quads);
    const from = quads.find(q => q.subject === eventUri && q.predicate === `${DKG}fromLayer`);
    const to = quads.find(q => q.subject === eventUri && q.predicate === `${DKG}toLayer`);
    expect(from!.object).toBe('"none"');
    expect(to!.object).toBe(`"${MemoryLayer.WorkingMemory}"`);
  });

  it('all quads target the _meta graph', () => {
    const quads = generateAssertionCreatedMetadata(meta);
    for (const q of quads) {
      expect(q.graph).toBe(META_GRAPH);
    }
  });
});

describe('generateAssertionPromotedMetadata', () => {
  const meta: AssertionPromotedMeta = {
    contextGraphId: PARANET,
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

  it('event is prov:Activity + dkg:AssertionPromoted with prov:used', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    const types = insert.filter(q => q.subject === eventUri && q.predicate === RDF_TYPE).map(q => q.object);
    expect(types).toContain(`${PROV}Activity`);
    expect(types).toContain(`${DKG}AssertionPromoted`);
  });

  it('event uses prov:startedAtTime and prov:wasAssociatedWith', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${PROV}startedAtTime`)).toBeDefined();
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${PROV}wasAssociatedWith`)!.object).toBe(AGENT_URI);
  });

  it('event includes DKG layer transition WM → SWM', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}fromLayer`)!.object).toBe(`"${MemoryLayer.WorkingMemory}"`);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}toLayer`)!.object).toBe(`"${MemoryLayer.SharedWorkingMemory}"`);
  });

  it('event includes shareOperationId and rootEntities', () => {
    const { insert } = generateAssertionPromotedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}shareOperationId`)!.object).toBe('"op-123"');
    const entities = insert.filter(q => q.subject === eventUri && q.predicate === `${DKG}rootEntity`);
    expect(entities).toHaveLength(2);
    expect(entities.map(q => q.object)).toContain('urn:test:alice');
    expect(entities.map(q => q.object)).toContain('urn:test:bob');
  });
});

describe('generateAssertionPublishedMetadata', () => {
  const meta: AssertionPublishedMeta = {
    contextGraphId: PARANET,
    agentAddress: AGENT_ADDR,
    assertionName: ASSERTION,
    kcUal: 'did:dkg:kc:test-kc-001',
    timestamp: new Date('2026-04-15T10:10:00Z'),
  };

  it('transitions state promoted → published and layer SWM → VM', () => {
    const { insert, delete: del } = generateAssertionPublishedMetadata(meta);
    expect(insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}state`)!.object).toBe('"published"');
    expect(del.find(q => q.predicate === `${DKG}state`)!.object).toBe('"promoted"');
    expect(insert.find(q => q.subject === LIFECYCLE_URI && q.predicate === `${DKG}memoryLayer`)!.object).toBe(`"${MemoryLayer.VerifiedMemory}"`);
    expect(del.find(q => q.predicate === `${DKG}memoryLayer`)!.object).toBe(`"${MemoryLayer.SharedWorkingMemory}"`);
  });

  it('event is prov:Activity with kcUal', () => {
    const { insert } = generateAssertionPublishedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}kcUal`)!.object).toBe('did:dkg:kc:test-kc-001');
  });
});

describe('generateAssertionDiscardedMetadata', () => {
  const meta: AssertionDiscardedMeta = {
    contextGraphId: PARANET,
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

  it('event has fromLayer WM and toLayer none', () => {
    const { insert } = generateAssertionDiscardedMetadata(meta);
    const eventUri = findEventUriFromInsert(insert);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}fromLayer`)!.object).toBe(`"${MemoryLayer.WorkingMemory}"`);
    expect(insert.find(q => q.subject === eventUri && q.predicate === `${DKG}toLayer`)!.object).toBe('"none"');
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
