import { describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildAuthoritativePublicMetaAskQuery } from
  '../src/context-graph-public-meta-proof.js';
import {
  repairChainAttestedPublicMetaProjection,
  repairCreatorPublicMetaProjections,
} from '../src/context-graph-public-meta-repair.js';

const CREATOR_PEER = '12D3KooWCreatorPublicMetaRepair111111111111111111111111';
const FOREIGN_PEER = '12D3KooWForeignPublicMetaRepair111111111111111111111111';

function publicOntologyDefinition(contextGraphId: string, creatorPeerId: string): Quad[] {
  const subject = contextGraphDataGraphUri(contextGraphId);
  const graph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  return [
    {
      subject,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_CREATOR,
      object: `did:dkg:agent:${creatorPeerId}`,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"public"',
      graph,
    },
  ];
}

async function hasPublicProof(
  store: OxigraphStore,
  contextGraphId: string,
): Promise<boolean> {
  const result = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));
  expect(result.type).toBe('boolean');
  return result.type === 'boolean' && result.value;
}

describe('creator-owned public metadata projection repair', () => {
  it('backfills the complete root proof for a creator-owned legacy public graph', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-missing-meta-proof';
    try {
      await store.insert(publicOntologyDefinition(contextGraphId, CREATOR_PEER));

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired).toEqual({
        candidates: 1,
        repairedGraphs: 1,
        insertedTriples: 2,
        conflictingGraphs: [],
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('repairs only the missing fact and is idempotent', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-partial-meta-proof';
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, CREATOR_PEER),
        {
          subject: contextGraphDataGraphUri(contextGraphId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '" PuBlIc "',
          graph: contextGraphMetaGraphUri(contextGraphId),
        },
      ]);

      const first = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);
      const second = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(first.repairedGraphs).toBe(1);
      expect(first.insertedTriples).toBe(1);
      expect(second.repairedGraphs).toBe(0);
      expect(second.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('does not make a foreign network-discovered graph authoritative locally', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'foreign-public-missing-meta-proof';
    try {
      await store.insert(publicOntologyDefinition(contextGraphId, FOREIGN_PEER));

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired.candidates).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('fails closed when creator-owned root metadata has a conflicting policy', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-conflicting-meta-policy';
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, CREATOR_PEER),
        {
          subject: contextGraphDataGraphUri(contextGraphId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: contextGraphMetaGraphUri(contextGraphId),
        },
      ]);

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired.repairedGraphs).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(repaired.conflictingGraphs).toEqual([contextGraphId]);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('fails closed when the ontology has conflicting creator or policy claims', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'legacy-public-conflicting-ontology';
    const subject = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, CREATOR_PEER),
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_CREATOR,
          object: `did:dkg:agent:${FOREIGN_PEER}`,
          graph: ontologyGraph,
        },
        {
          subject,
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: ontologyGraph,
        },
      ]);

      const repaired = await repairCreatorPublicMetaProjections(store, CREATOR_PEER);

      expect(repaired.candidates).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe('chain-attested public metadata projection repair', () => {
  it('backfills creatorless legacy metadata after exact active-public chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '0x1234567890123456789012345678901234567890/legacy-public';
    try {
      const first = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );
      const second = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );

      expect(first).toEqual({
        outcome: 'projection-complete',
        chainProof: { state: 'public' },
      });
      expect(second).toEqual({
        outcome: 'already-complete',
        chainProof: { state: 'not-requested' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('does not materialize metadata without current-chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'unattested-public-looking-graph';
    try {
      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'not-public', reason: 'unregistered' }),
      );

      expect(repaired).toEqual({
        outcome: 'not-chain-attested',
        chainProof: { state: 'not-public', reason: 'unregistered' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('never overwrites conflicting private root policy', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'chain-public-root-private-conflict';
    try {
      await store.insert([{
        subject: contextGraphDataGraphUri(contextGraphId),
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: contextGraphMetaGraphUri(contextGraphId),
      }]);

      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => ({ state: 'public' }),
      );

      expect(repaired).toEqual({
        outcome: 'conflicting-policy',
        chainProof: { state: 'public' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('does not insert stale public facts when private policy arrives during chain proof', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'chain-public-concurrent-private-conflict';
    try {
      const repaired = await repairChainAttestedPublicMetaProjection(
        store,
        contextGraphId,
        async () => {
          await store.insert([{
            subject: contextGraphDataGraphUri(contextGraphId),
            predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
            object: '"private"',
            graph: contextGraphMetaGraphUri(contextGraphId),
          }]);
          return { state: 'public' } as const;
        },
      );

      expect(repaired).toEqual({
        outcome: 'conflicting-policy',
        chainProof: { state: 'public' },
      });
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
      const typeResult = await store.query(`ASK WHERE {
        GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> {
          <${contextGraphDataGraphUri(contextGraphId)}> <${DKG_ONTOLOGY.RDF_TYPE}>
            <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        }
      }`);
      expect(typeResult).toEqual({ type: 'boolean', value: false });
    } finally {
      await store.close();
    }
  });
});
