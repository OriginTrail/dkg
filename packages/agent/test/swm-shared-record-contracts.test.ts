// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { decodeEntityShareMetadata, ENTITY_SHARE_METADATA_SIDECAR_PREDICATES, generateShareMetadata } from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from '../../publisher/dist/workspace-resolution.js';
import { admitSharedMemoryMetadata } from '../src/sync/shared-memory-metadata-admission.js';

const cg = 'shared-contract';
const root = 'urn:entity:shared-contract';
const dkg = 'http://dkg.io/ontology/';
async function producer(subGraphName?: string, backing: 'store' | 'graph' = 'store') {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const graph = contextGraphSharedMemoryMetaUri(cg, subGraphName);
  try {
    await storeWorkspaceOperationPublicQuads({ store, graphManager, contextGraphId: cg,
      shareOperationId: 'share', rootEntities: [root], subGraphName, publisherPeerId: 'peer',
      timestamp: new Date(0), quads: [{ subject: root, predicate: 'urn:name', object: '"value"', graph: '' }],
      ...(backing === 'store' ? { publicSnapshotStore: {
        getSnapshot: async () => null,
        putSnapshot: async ({ digest }: { digest: string }) => ({ ref: digest, byteLength: 0 }),
      } } : {}),
    });
    const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Expected publisher metadata');
    return result.quads.map(row => ({ ...row, graph }));
  } finally { await store.close(); }
}
function admission(rows: readonly Quad[]) {
  return admitSharedMemoryMetadata(rows, { kind: 'context', contextGraphId: cg,
    registeredSubGraphNames: new Set(['research']) });
}

it.each([
  { subGraphName: undefined, backing: 'store' as const },
  { subGraphName: 'research', backing: 'store' as const },
  { subGraphName: undefined, backing: 'graph' as const },
  { subGraphName: 'research', backing: 'graph' as const },
])('current $backing producer is admitted and snapshot-readable in $subGraphName', async ({ subGraphName, backing }) => {
  const rows = await producer(subGraphName, backing);
  const admitted = admission(rows);
  expect(admitted.rejections).toEqual([]);
  const operation = admitted.records.find(record => record.role === 'legacyOperation');
  const slice = admitted.records.find(record => record.role === 'publicSlice');
  expect(operation).toBeDefined();
  expect(slice).toBeDefined();
  const decoded = decodeEntityShareMetadata(cg, rows);
  expect(decoded.find(record => record.subject === operation!.subject)?.kind).toBe('operation');
  expect(decoded.find(record => record.subject === slice!.subject)?.kind).toBe('slice');
  expect(decoded.every(record => record.kind !== 'other')).toBe(true);
});

it('keeps identity-free entity-alias operations admissible without claiming snapshot readiness', () => {
  const graph = contextGraphSharedMemoryMetaUri(cg);
  const rows = generateShareMetadata({ contextGraphId: cg, shareOperationId: 'share',
    rootEntities: [root], publisherPeerId: 'peer', timestamp: new Date(0) }, graph)
    .filter(row => row.predicate !== dkg + 'contextGraphId' && row.predicate !== dkg + 'shareOperationId')
    .map(row => row.predicate === dkg + 'rootEntity' ? { ...row, predicate: dkg + 'entity' } : row);
  const admitted = admission(rows);
  expect(admitted.rejections).toEqual([]);
  expect(admitted.records[0]).toMatchObject({ role: 'legacyOperation', roots: new Set([root]) });
  expect(decodeEntityShareMetadata(cg, rows)[0]?.kind).toBe('other');
});

it('retains historical inline slices in admission while readiness requires a stored snapshot', async () => {
  const rows = await producer();
  const slice = admission(rows).records.find(record => record.role === 'publicSlice')!;
  const inline = { ...slice.rows[0]!, predicate: dkg + 'publicStagedQuads', object: '"[]"' };
  const historical = [...rows, inline];
  expect(admission(historical).records.find(record => record.subject === slice.subject)?.rows).toContainEqual(inline);
  expect(decodeEntityShareMetadata(cg, historical).find(record => record.subject === slice.subject)?.kind).toBe('other');
});

it('excludes local sidecars from protocol rows in both readers', async () => {
  const rows = await producer();
  const sidecars = [...ENTITY_SHARE_METADATA_SIDECAR_PREDICATES].map(predicate => ({ ...rows[0]!, predicate, object: '"local annotation"' }));
  const withSidecars = [...rows, ...sidecars];
  expect(admission(withSidecars).records.flatMap(record => record.rows)).toEqual(admission(rows).records.flatMap(record => record.rows));
  expect(decodeEntityShareMetadata(cg, withSidecars)).toEqual(decodeEntityShareMetadata(cg, rows));
});

it('rejects mismatched identities and preserves the stricter RDF-term readiness policy', async () => {
  const rows = await producer();
  const claim = rows.find(row => row.predicate === dkg + 'contextGraphId')!;
  const mismatch = rows.map(row => row.subject === claim.subject && row.predicate === claim.predicate
    ? { ...row, object: '"foreign-cg"' } : row);
  expect(admission(mismatch).rejections).toContainEqual(expect.objectContaining({ reason: 'identityMismatch' }));
  expect(decodeEntityShareMetadata(cg, mismatch).find(record => record.subject === claim.subject)?.kind).toBe('other');
  const duplicateTerm = { ...claim, object: `"${cg}"^^<http://www.w3.org/2001/XMLSchema#string>` };
  const historical = [...rows, duplicateTerm];
  expect(admission(historical).rejections).toEqual([]);
  expect(decodeEntityShareMetadata(cg, historical).find(record => record.subject === claim.subject)?.kind).toBe('other');
});
