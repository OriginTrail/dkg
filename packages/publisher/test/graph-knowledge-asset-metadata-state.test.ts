import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  generateGraphKnowledgeAssetMetadata,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  readGraphKnowledgeAssetMetadataState,
  writeMaterializedVersion,
} from '../src/metadata.js';

const DKG = 'http://dkg.io/ontology/';
const CONTEXT_GRAPH = 'metadata-state';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const UAL = 'did:dkg:evm:31337/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const ASSERTION_GRAPH =
  `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/`
  + '0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const ROOT = new Uint8Array(32).fill(0x11);
const TX_HASH = `0x${'22'.repeat(32)}`;

const metadata = {
  ual: UAL,
  contextGraphId: CONTEXT_GRAPH,
  merkleRoot: ROOT,
  publisherPeerId: 'peer-1',
  accessPolicy: 'allowList' as const,
  allowedPeers: ['peer-a', 'peer-b'],
  authorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  assertionVersion: '1',
  publicTripleCount: 2,
  privateTripleCount: 0,
  assertionGraph: ASSERTION_GRAPH,
};

const provenance = {
  txHash: TX_HASH,
  blockNumber: 100,
  blockTimestamp: 1_700_000_000,
  publisherAddress: '0x0000000000000000000000000000000000000001',
  batchId: 7n,
  chainId: 'evm:31337',
};

describe('readGraphKnowledgeAssetMetadataState', () => {
  it('matches the canonical writer envelope and exact recovery provenance', async () => {
    const store = new OxigraphStore();
    await store.insert(generateGraphKnowledgeAssetMetadata(
      { ...metadata, timestamp: new Date('2026-01-01T00:00:00Z') },
      'confirmed',
      provenance,
    ));
    await writeMaterializedVersion(store, META_GRAPH, UAL, { blockNumber: 100, txIndex: 0 });

    await expect(readGraphKnowledgeAssetMetadataState(store, {
      ...metadata,
      batchId: 7n,
      expectedTxHash: TX_HASH,
      materializedVersion: { blockNumber: 100, txIndex: 0 },
    })).resolves.toBe('matching');
    await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
      contextGraphId: CONTEXT_GRAPH,
      ual: UAL,
    })).resolves.toMatchObject({
      state: 'confirmed',
      envelope: {
        assertionVersion: '1',
        publicTripleCount: 2,
        privateTripleCount: 0,
        assertionGraph: ASSERTION_GRAPH,
        transactionHash: TX_HASH,
        batchId: 7n,
      },
    });
  });

  it('reports absent without the graph-scoped discriminator', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: UAL,
      predicate: `${DKG}status`,
      object: '"confirmed"',
      graph: META_GRAPH,
    }]);

    await expect(readGraphKnowledgeAssetMetadataState(store, {
      ...metadata,
      batchId: 7n,
      expectedTxHash: TX_HASH,
    })).resolves.toBe('absent');
    await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
      contextGraphId: CONTEXT_GRAPH,
      ual: UAL,
    })).resolves.toEqual({ state: 'absent' });
  });

  it('matches canonical provenance without requiring an ordering stamp', async () => {
    const store = new OxigraphStore();
    await store.insert(generateGraphKnowledgeAssetMetadata(
      { ...metadata, timestamp: new Date('2026-01-01T00:00:00Z') },
      'confirmed',
      provenance,
    ));

    await expect(readGraphKnowledgeAssetMetadataState(store, {
      ...metadata,
      batchId: 7n,
    })).resolves.toBe('matching');
  });

  it('rejects missing or malformed transaction provenance', async () => {
    for (const txHash of ['', '0x1']) {
      const store = new OxigraphStore();
      await store.insert(generateGraphKnowledgeAssetMetadata(
        { ...metadata, timestamp: new Date('2026-01-01T00:00:00Z') },
        'confirmed',
        { ...provenance, txHash },
      ));

      if (txHash === '') {
        await expect(readGraphKnowledgeAssetMetadataState(store, {
          ...metadata,
          batchId: 7n,
        })).resolves.toBe('different');
      }
      await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
        contextGraphId: CONTEXT_GRAPH,
        ual: UAL,
      })).resolves.toEqual({ state: 'invalid' });
    }
  });

  it('propagates metadata-store read failures instead of classifying them as drift', async () => {
    const store = new OxigraphStore();
    store.query = async () => {
      throw new Error('injected metadata read outage');
    };

    await expect(readGraphKnowledgeAssetMetadataState(store, {
      ...metadata,
      batchId: 7n,
      expectedTxHash: TX_HASH,
    })).rejects.toThrow('injected metadata read outage');
    await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
      contextGraphId: CONTEXT_GRAPH,
      ual: UAL,
    })).rejects.toThrow('injected metadata read outage');

    store.query = async () => ({ type: 'boolean', value: false });
    await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
      contextGraphId: CONTEXT_GRAPH,
      ual: UAL,
    })).rejects.toThrow('expected a bindings result');
  });

  it('rejects a different or duplicated canonical field', async () => {
    const store = new OxigraphStore();
    await store.insert(generateGraphKnowledgeAssetMetadata(
      { ...metadata, timestamp: new Date('2026-01-01T00:00:00Z') },
      'confirmed',
      provenance,
    ));
    await writeMaterializedVersion(store, META_GRAPH, UAL, { blockNumber: 100, txIndex: 0 });
    await store.insert([{
      subject: UAL,
      predicate: `${DKG}accessPolicy`,
      object: '"public"',
      graph: META_GRAPH,
    }]);

    await expect(readGraphKnowledgeAssetMetadataState(store, {
      ...metadata,
      batchId: 7n,
      expectedTxHash: TX_HASH,
    })).resolves.toBe('different');
  });
});
