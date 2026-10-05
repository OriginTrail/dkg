// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { DKG_RDF_LITERAL_SAFE_MUTF8_BYTES } from '@origintrail-official/dkg-core';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { persistLocalSwmOperation } from './_helpers/local-swm-operation.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { healthyRecoveredAliasRows } from '../src/internal/swm-recovery/swm-draft-order.js';

const CG = 'metadata-commit';
const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
const DKG = 'http://dkg.io/ontology/';
const cases = (['swm-sync', 'swm-recovery'] as const).flatMap(ingest =>
  (['healthy', 'corrupt', 'replacement'] as const).map(state => ({ ingest, state })));

describe('materializer metadata commit owner', () => {
  it.each(cases)('$ingest owns $state metadata, ingestion attribution, filtering and nominal accounting', async ({ ingest, state }) => {
    const store = new OxigraphStore();
    const make = (operationId: string, timestamp: number) => swmFixtures(CG).share({ version: 1, operationId, marker: 'same', ual: UAL, timestamp: new Date(timestamp) });
    const local = make('A', 1000), incoming = make('B', 2000);
    const drops = vi.fn(), dirty = vi.fn(), invalidate = vi.fn();
    try {
      if (state !== 'replacement') {
        await persistLocalSwmOperation(store, CG, local);
        await store.insert(local.meta.filter(row => row.subject === local.headSubject));
        await store.insert(local.payload.map(row => ({ ...row, graph: local.assertionGraph })));
        if (state === 'corrupt') await store.insert([{ graph: local.meta[0]!.graph, subject: local.headSubject, predicate: `${DKG}assertionVersion`, object: '"99"^^<http://www.w3.org/2001/XMLSchema#integer>' }]);
      }
      await persistLocalSwmOperation(store, CG, incoming);
      const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: incoming.meta })[0]!;
      const poison = { graph: descriptor.metaGraph, subject: descriptor.operationSubject, predicate: 'urn:extra', object: JSON.stringify('x'.repeat(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES + 1)) };
      const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map(), invalidateListContextGraphsCache: invalidate,
        metadataIngestObserver: { recordDrops: drops, markMetaProjectionDirty: dirty } });
      const insert = vi.spyOn(store, 'insert');
      let originalHealthyAccounting: number | undefined;
      const result = await materializer.withKaWriteLock(CG, undefined, UAL, async () => {
        const prepared = await materializer.prepareRecoveredDescriptor(descriptor);
        expect(prepared.storedHead.status).toBe(state === 'replacement' ? 'missing' : state === 'corrupt' ? 'corrupt' : 'resolved');
        const metadata = { ...prepared, metadataQuads: [...prepared.metadataQuads, poison], providerMetadataQuads: [...prepared.providerMetadataQuads, poison] };
        if (state === 'healthy') {
          // Characterize the original provider-row accounting; authenticated
          // substitutions can have different literal spelling from the provider.
          originalHealthyAccounting = healthyRecoveredAliasRows(CG, metadata)!.filter(row =>
            metadata.providerMetadataQuads.some(provider => provider.subject === row.subject
              && provider.predicate === row.predicate && provider.object === row.object && provider.graph === row.graph)).length;
        }
        return materializer.commitRecoveredMetadata(CG, metadata, ingest,
          ingest === 'swm-recovery' ? { source: 'agent.test.metadataOwner' } : undefined);
      });
      expect(result.withholdRows).toEqual([...descriptor.metadataQuads, poison]);
      expect(await store.query(`ASK { GRAPH <${descriptor.metaGraph}> { <${poison.subject}> <${poison.predicate}> ?o } }`)).toEqual({ type: 'boolean', value: false });
      if (state !== 'replacement') expect(await store.query(`ASK { GRAPH <${descriptor.metaGraph}> { <${local.operationSubject}> ?p ?o } }`)).toEqual({ type: 'boolean', value: true });
      const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
      expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(state === 'replacement' ? ['B'] : ['A', 'B']);
      if (state === 'healthy') expect(result.insertedMetaQuads).toBe(originalHealthyAccounting);
      else expect(result.insertedMetaQuads).toBeGreaterThan(dirty.mock.calls.flatMap(([rows]) => rows).length);
      expect(drops).toHaveBeenCalledWith([expect.objectContaining({ quad: poison, kind: 'oversize' })], ingest);
      expect(dirty).toHaveBeenCalledOnce();
      expect(dirty.mock.calls[0]![0]).not.toContainEqual(poison);
      expect(insert.mock.calls.some(([, options]) => options?.priority === 'background'
        && options.source === (ingest === 'swm-sync' ? 'agent.sharedMemorySync.storeInsert' : 'agent.swmRecovery.insert'))).toBe(true);
      if (ingest === 'swm-recovery') expect(invalidate).toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
