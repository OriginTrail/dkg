import { describe, it, expect } from 'vitest';
import { buildVerificationMetadata } from '../src/verification-metadata.js';

describe('buildVerificationMetadata', () => {
  it('produces verification metadata quads', () => {
    const quads = buildVerificationMetadata({
      contextGraphId: 'ml-research',
      verifiedMemoryId: 'team-decisions',
      batchId: 42n,
      txHash: '0xabc123',
      blockNumber: 19876543,
      signers: ['0xAlice', '0xBob', '0xCharlie'],
      verifiedAt: new Date('2026-04-01T12:00:00Z'),
      graph: 'did:dkg:context-graph:ml-research/_verified_memory/team-decisions/_meta',
    });

    // V10 Axiom 3 + 4 corollary contract: VERIFY emits a uniform
    // prov:Activity audit row alongside the dkg:Verification record.
    // Quads breakdown:
    //   2x rdf:type   (dkg:Verification + prov:Activity)
    //   1x prov:startedAtTime
    //   1x dkg:transitionType "VERIFY"
    //   1x prov:wasAssociatedWith (proposer = signers[0])
    //   1x dkg:contextGraphId
    //   1x dkg:verifiedMemoryId
    //   1x dkg:batchId
    //   1x dkg:transactionHash
    //   1x dkg:blockNumber
    //   1x dkg:verifiedAt
    //   1x dkg:signerCount
    //   3x dkg:signedBy
    //   = 15
    expect(quads).toHaveLength(15);

    // Both Verification and prov:Activity types must be present —
    // the Axiom 4 corollary requires uniform audit-trail composability.
    const typeQuads = quads.filter(q => q.predicate.endsWith('#type'));
    expect(typeQuads).toHaveLength(2);
    const typeObjects = typeQuads.map(q => q.object);
    expect(typeObjects).toContain('https://dkg.network/ontology#Verification');
    expect(typeObjects).toContain('http://www.w3.org/ns/prov#Activity');

    const transitionQuad = quads.find(q => q.predicate.endsWith('/transitionType'));
    expect(transitionQuad?.object).toBe('"VERIFY"');

    const associatedQuad = quads.find(q => q.predicate.endsWith('#wasAssociatedWith'));
    expect(associatedQuad?.object).toBe('did:dkg:agent:0xAlice');

    const txQuad = quads.find(q => q.predicate.endsWith('#transactionHash'));
    expect(txQuad?.object).toBe('"0xabc123"');

    const signerQuads = quads.filter(q => q.predicate.endsWith('#signedBy'));
    expect(signerQuads).toHaveLength(3);

    // All quads use the provided graph
    for (const q of quads) {
      expect(q.graph).toBe('did:dkg:context-graph:ml-research/_verified_memory/team-decisions/_meta');
    }
  });

  it('formats agent addresses as DIDs when not already DID format', () => {
    const quads = buildVerificationMetadata({
      contextGraphId: 'test',
      verifiedMemoryId: 'vm1',
      batchId: 1n,
      txHash: '0x1',
      blockNumber: 1,
      signers: ['0xAlice'],
      verifiedAt: new Date(),
      graph: 'test-graph',
    });

    const signerQuad = quads.find(q => q.predicate.endsWith('#signedBy'));
    expect(signerQuad?.object).toBe('did:dkg:agent:0xAlice');
  });

  it('preserves DID format when already provided', () => {
    const quads = buildVerificationMetadata({
      contextGraphId: 'test',
      verifiedMemoryId: 'vm1',
      batchId: 1n,
      txHash: '0x1',
      blockNumber: 1,
      signers: ['did:dkg:agent:0xAlice'],
      verifiedAt: new Date(),
      graph: 'test-graph',
    });

    const signerQuad = quads.find(q => q.predicate.endsWith('#signedBy'));
    expect(signerQuad?.object).toBe('did:dkg:agent:0xAlice');
  });
});
