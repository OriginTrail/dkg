// SPDX-License-Identifier: Apache-2.0
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { persistWorkspaceOperationEvidence } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { storeKnowledgeAssetOperationPublicQuads } from '@origintrail-official/dkg-publisher';

/** Persist trusted local writer evidence without moving its current head. */
export async function persistLocalSwmOperation(store: TripleStore, contextGraphId: string, fixture: {
  meta: readonly Quad[]; operationSubject: string; payload: readonly Quad[];
}): Promise<void> {
  const rows = fixture.meta.filter(row => row.subject === fixture.operationSubject);
  const value = (name: string) => { const object = rows.find(row => row.predicate === `http://dkg.io/ontology/${name}`)?.object ?? ''; return /^"([^"]*)"/.exec(object)?.[1] ?? object; };
  const privateMerkleRoot = value('privateMerkleRoot');
  await storeKnowledgeAssetOperationPublicQuads({
    store, graphManager: new GraphManager(store), contextGraphId,
    shareOperationId: value('shareOperationId'), kaUal: value('kaUal'), assertionVersion: value('assertionVersion'),
    quads: [...fixture.payload], publisherPeerId: value('publisherPeerId'), timestamp: new Date(value('publishedAt')),
    ...(value('subGraphName') ? { subGraphName: value('subGraphName') } : {}),
    privateTripleCount: Number(value('privateTripleCount')),
    ...(privateMerkleRoot ? { privateMerkleRoot: new Uint8Array(Buffer.from(privateMerkleRoot.replace(/^0x/, ''), 'hex')) } : {}),
    accessPolicy: value('accessPolicy') as 'public' | 'ownerOnly' | 'allowList',
    allowedPeers: rows.filter(row => row.predicate === 'http://dkg.io/ontology/allowedPeer').map(row => /^"([^"]*)"/.exec(row.object)?.[1] ?? row.object),
  });
  // Preserve the legacy fixture's snapshot locator serialization after the
  // admitted production writer has established its complete operation.
  await store.deleteByPattern({ graph: rows[0]!.graph, subject: fixture.operationSubject });
  await store.insert(rows);
  await persistWorkspaceOperationEvidence(store, rows);
}
