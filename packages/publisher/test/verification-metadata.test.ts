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

    // Should have: type, contextGraphId, verifiedMemoryId, batchId, txHash, blockNumber, verifiedAt, signerCount, + 3 signedBy
    expect(quads).toHaveLength(11);

    const typeQuad = quads.find(q => q.predicate.endsWith('#type'));
    expect(typeQuad?.object).toBe('https://dkg.network/ontology#Verification');

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
