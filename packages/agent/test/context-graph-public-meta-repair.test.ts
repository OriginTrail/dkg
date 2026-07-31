import { describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildAuthoritativePublicMetaAskQuery } from '../src/context-graph-public-meta-proof.js';
import { repairLocallyCreatedPublicMetaProjections } from '../src/context-graph-public-meta-repair.js';

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

async function hasPublicProof(store: OxigraphStore, contextGraphId: string): Promise<boolean> {
  const result = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId));
  expect(result.type).toBe('boolean');
  return result.type === 'boolean' && result.value;
}

describe('durably local-created public metadata repair', () => {
  it('repairs only ids supplied by trusted local-creation provenance', async () => {
    const store = new OxigraphStore();
    const trustedId = 'trusted-local-legacy-public';
    const spoofedId = 'network-spoofed-local-creator';
    const localPeerId = '12D3KooWLocalCreatorClaim111111111111111111111111111';
    try {
      await store.insert([
        ...publicOntologyDefinition(trustedId, localPeerId),
        ...publicOntologyDefinition(spoofedId, localPeerId),
      ]);

      const repaired = await repairLocallyCreatedPublicMetaProjections(store, [trustedId]);

      expect(repaired).toEqual({
        candidates: 1,
        repairedGraphs: 1,
        insertedTriples: 2,
        conflictingGraphs: [],
      });
      expect(await hasPublicProof(store, trustedId)).toBe(true);
      expect(await hasPublicProof(store, spoofedId)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('uses the canonical inspection model for partial, idempotent repair', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'trusted-local-partial-public';
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, '12D3KooWTrustedPartial'),
        {
          subject: contextGraphDataGraphUri(contextGraphId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '" PuBlIc "',
          graph: contextGraphMetaGraphUri(contextGraphId),
        },
      ]);

      const first = await repairLocallyCreatedPublicMetaProjections(store, [contextGraphId]);
      const second = await repairLocallyCreatedPublicMetaProjections(store, [contextGraphId]);

      expect(first.repairedGraphs).toBe(1);
      expect(first.insertedTriples).toBe(1);
      expect(second.repairedGraphs).toBe(0);
      expect(second.insertedTriples).toBe(0);
      expect(await hasPublicProof(store, contextGraphId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('fails closed on conflicting root policy even with trusted provenance', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'trusted-local-conflicting-policy';
    try {
      await store.insert([
        ...publicOntologyDefinition(contextGraphId, '12D3KooWTrustedConflict'),
        {
          subject: contextGraphDataGraphUri(contextGraphId),
          predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
          object: '"private"',
          graph: contextGraphMetaGraphUri(contextGraphId),
        },
      ]);

      const repaired = await repairLocallyCreatedPublicMetaProjections(store, [contextGraphId]);

      expect(repaired.repairedGraphs).toBe(0);
      expect(repaired.insertedTriples).toBe(0);
      expect(repaired.conflictingGraphs).toEqual([contextGraphId]);
      expect(await hasPublicProof(store, contextGraphId)).toBe(false);
    } finally {
      await store.close();
    }
  });
});
