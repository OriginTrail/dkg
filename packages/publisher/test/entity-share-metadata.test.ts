import { expect, it } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  decodeEntityShareMetadata,
  ENTITY_SHARE_METADATA_SIDECAR_PREDICATES,
} from '../src/entity-share-metadata.js';
import { storeWorkspaceOperationPublicQuads } from '../src/workspace-resolution.js';
import { generateShareMetadata } from '../src/metadata.js';
import { workspacePublicQuadsDigest } from '../src/workspace-snapshot-store.js';
import { workspaceKnowledgeAssetHeadSubject, workspaceOperationPublicSliceSubject, workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';

const cg = 'entity-decoder';
const operationId = 'operation';
const roots = ['urn:entity:1', 'urn:entity:2'];
const dkg = 'http://dkg.io/ontology/';
type SnapshotBacking = 'snapshot-store' | 'snapshot-graph';
async function fixture(subGraphName?: string, backing: SnapshotBacking = 'snapshot-store') {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const graph = graphManager.sharedMemoryMetaUri(cg, subGraphName);
  try {
    await storeWorkspaceOperationPublicQuads({ store, graphManager, contextGraphId: cg, shareOperationId: operationId,
      rootEntities: roots, subGraphName, publisherPeerId: 'peer', timestamp: new Date(0),
      quads: roots.map(subject => ({ subject, predicate: 'urn:name', object: '"entity"', graph: '' })),
      ...(backing === 'snapshot-store' ? {
        publicSnapshotStore: { getSnapshot: async () => null, putSnapshot: async ({ digest }: { digest: string }) => ({ ref: digest, byteLength: 0 }) },
      } : {}),
    });
    const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    if (result.type !== 'quads') throw new Error('Expected fixture metadata');
    return { metadata: result.quads.map(quad => ({ ...quad, graph })), graph,
      operation: workspaceOperationSubject(cg, operationId),
      slice: workspaceOperationPublicSliceSubject(cg, operationId, roots[0]!, subGraphName) };
  } finally { await store.close(); }
}

it.each([
  { subGraphName: undefined, backing: 'snapshot-store' as const },
  { subGraphName: 'research', backing: 'snapshot-store' as const },
  { subGraphName: undefined, backing: 'snapshot-graph' as const },
  { subGraphName: 'research', backing: 'snapshot-graph' as const },
])('decodes $backing publisher output in subgraph $subGraphName', async ({ subGraphName, backing }) => {
  const { metadata, graph } = await fixture(subGraphName, backing);
  const records = decodeEntityShareMetadata(cg, metadata);
  const operation = records.find(record => record.kind === 'operation');
  expect(operation).toMatchObject({ kind: 'operation', graph, subGraphName, rootEntities: expect.arrayContaining(roots) });
  const slices = records.filter(record => record.kind === 'slice');
  expect(slices).toHaveLength(2);
  expect(slices.map(slice => slice.rootEntity).sort()).toEqual(roots);
  expect(slices.every(slice => slice.ref.length > 0 && slice.operationSubject === operation?.subject)).toBe(true);
  for (const slice of slices) {
    expect(slice.metadataRows).toEqual(metadata.filter(row => row.subject === slice.subject));
    expect(slice.metadataRows.some(row => row.predicate === dkg + 'publicSnapshotGraph'))
      .toBe(backing === 'snapshot-graph');
  }
});

it.each([undefined, 'research'])('recovers a valid legacy explicit snapshot reference in subgraph %s', async subGraphName => {
  const f = await fixture(subGraphName);
  const digestRow = f.metadata.find(row => row.subject === f.slice && row.predicate === dkg + 'publicQuadsDigest')!;
  const explicitRef = { ...digestRow, predicate: dkg + 'publicSnapshotRef' };
  const slice = decodeEntityShareMetadata(cg, [...f.metadata, explicitRef]).find(record => record.subject === f.slice);
  expect(slice?.kind).toBe('slice');
  if (slice?.kind !== 'slice') throw new Error('Expected legacy slice');
  expect(slice.ref).toBe(JSON.parse(digestRow.object));
  expect(slice.metadataRows).toEqual([...f.metadata.filter(row => row.subject === f.slice), explicitRef]);
});

it.each([undefined, 'research'])('preserves exact writer RDF terms and round-trips in subgraph %s', async subGraphName => {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const graph = graphManager.sharedMemoryMetaUri(cg, subGraphName);
  const timestamp = new Date('2026-08-01T12:34:56.789Z');
  const publisherPeerId = 'peer "quoted"\\path\nline\rreturn';
  const publisherLiteral = '"peer \\"quoted\\"\\\\path\\nline\\rreturn"';
  const agentAddress = subGraphName ? '0x1111111111111111111111111111111111111111' : undefined;
  const attributedTo = agentAddress ? `did:dkg:agent:${agentAddress}` : publisherLiteral;
  const publishedAt = '"2026-08-01T12:34:56.789Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>';
  const payload = [{ subject: roots[0]!, predicate: 'urn:name', object: '"entity"', graph: '' }];
  const rows = (subject: string, fields: [string, string][]): Quad[] => fields.map(([predicate, object]) => ({ subject, predicate, object, graph }));
  const optionalSubgraph: [string, string][] = subGraphName ? [[dkg + 'subGraphName', '"research"']] : [];
  const operation = rows(workspaceOperationSubject(cg, operationId), [
    ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', dkg + 'WorkspaceOperation'],
    [dkg + 'contextGraphId', '"entity-decoder"'], [dkg + 'shareOperationId', '"operation"'],
    [dkg + 'publisherPeerId', publisherLiteral], ['http://www.w3.org/ns/prov#wasAttributedTo', attributedTo],
    [dkg + 'publishedAt', publishedAt], ...optionalSubgraph, [dkg + 'rootEntity', roots[0]!],
  ]);
  const slice = rows(workspaceOperationPublicSliceSubject(cg, operationId, roots[0]!, subGraphName), [
    [dkg + 'contextGraphId', '"entity-decoder"'], [dkg + 'shareOperationId', '"operation"'],
    [dkg + 'publicSliceRootEntity', roots[0]!], [dkg + 'publicQuadsDigest', `"${workspacePublicQuadsDigest(payload)}"`],
    [dkg + 'publicQuadsCount', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'],
    [dkg + 'publisherPeerId', publisherLiteral], ['http://www.w3.org/ns/prov#wasAttributedTo', attributedTo],
    [dkg + 'publishedAt', publishedAt], ...optionalSubgraph,
  ]);
  const written: Quad[][] = [];
  const insert = store.insert.bind(store);
  store.insert = async quads => { written.push([...quads]); await insert(quads); };
  try {
    expect(generateShareMetadata({ contextGraphId: cg, shareOperationId: operationId, rootEntities: [roots[0]!],
      publisherPeerId, agentAddress, timestamp, subGraphName }, graph)).toEqual(operation);
    await storeWorkspaceOperationPublicQuads({ store, graphManager, contextGraphId: cg, shareOperationId: operationId,
      rootEntities: [roots[0]!], quads: payload, publisherPeerId, agentAddress, timestamp, subGraphName,
      publicSnapshotStore: { getSnapshot: async () => null, putSnapshot: async ({ digest }) => ({ ref: digest, byteLength: 0 }) },
    });
    expect(written).toEqual([operation, slice]);
    expect(decodeEntityShareMetadata(cg, written.flat()).map(record => {
      if (record.kind !== 'operation' && record.kind !== 'slice') throw new Error('Expected complete publisher metadata');
      return record.metadataRows;
    })).toEqual([operation, slice]);
  } finally { await store.close(); }
});

it('round-trips publisher metadata while classifying supported sidecars separately', async () => {
  const f = await fixture();
  const sidecars = [...ENTITY_SHARE_METADATA_SIDECAR_PREDICATES].map(predicate => ({
    subject: f.operation,
    predicate,
    object: '"local cache annotation"',
    graph: f.graph,
  }));
  const operation = decodeEntityShareMetadata(cg, [...f.metadata, ...sidecars])
    .find(record => record.subject === f.operation);

  expect(operation?.kind).toBe('operation');
  if (operation?.kind !== 'operation') throw new Error('Expected operation record');
  expect(operation.metadataRows).toEqual(
    f.metadata.filter(row => row.subject === f.operation),
  );
  expect(operation.metadataRows.every(
    row => !ENTITY_SHARE_METADATA_SIDECAR_PREDICATES.has(row.predicate),
  )).toBe(true);
});

it('rejects otherwise-valid entity rows from a non-canonical metadata graph', async () => {
  const f = await fixture();
  const wrongGraph = `${f.graph}/wrong`;
  const records = decodeEntityShareMetadata(
    cg,
    f.metadata.map(quad => ({ ...quad, graph: wrongGraph })),
  );
  expect(records.every(record => record.kind === 'other')).toBe(true);
});

type SliceChange = { name: string; mutate(rows: Quad[], subject: string, graph: string): Quad[] };
const replace = (rows: Quad[], subject: string, field: string, object: string) => rows.map(quad =>
  quad.subject === subject && quad.predicate === dkg + field ? { ...quad, object } : quad);
const changes: SliceChange[] = [
  { name: 'wrong context graph', mutate: (rows, subject) => replace(rows, subject, 'contextGraphId', '"other"') },
  { name: 'unsafe operation ID', mutate: (rows, subject) => replace(rows, subject, 'shareOperationId', '"unsafe id"') },
  { name: 'non-IRI root', mutate: (rows, subject) => replace(rows, subject, 'publicSliceRootEntity', '"root"') },
  { name: 'negative count', mutate: (rows, subject) => replace(rows, subject, 'publicQuadsCount', '"-1"') },
  { name: 'unsafe count', mutate: (rows, subject) => replace(rows, subject, 'publicQuadsCount', '"9007199254740992"') },
  { name: 'invalid literal', mutate: (rows, subject) => replace(rows, subject, 'publicQuadsDigest', '"bad\\qescape"') },
  { name: 'missing digest', mutate: (rows, subject) => rows.filter(quad => quad.subject !== subject || quad.predicate !== dkg + 'publicQuadsDigest') },
  { name: 'ambiguous root', mutate: (rows, subject, graph) => [...rows, { subject, graph, predicate: dkg + 'publicSliceRootEntity', object: 'urn:other' }] },
  { name: 'unknown commitment', mutate: (rows, subject, graph) => [...rows, { subject, graph, predicate: dkg + 'assertionVersion', object: '"1"' }] },
  { name: 'ambiguous subgraph', mutate: (rows, subject, graph) => [...rows, ...['a', 'b'].map(value => ({ subject, graph, predicate: dkg + 'subGraphName', object: JSON.stringify(value) }))] },
  { name: 'invalid explicit reference', mutate: (rows, subject, graph) => [...rows, { subject, graph, predicate: dkg + 'publicSnapshotRef', object: 'urn:not-a-literal' }] },
];
it.each(changes)('rejects a slice with $name', async ({ mutate }) => {
  const f = await fixture();
  expect(decodeEntityShareMetadata(cg, mutate(f.metadata, f.slice, f.graph)).find(record => record.subject === f.slice)?.kind).toBe('other');
});

it('keeps every valid head claim and ignores identifiers that cannot name an operation', async () => {
  const f = await fixture();
  const head = workspaceKnowledgeAssetHeadSubject('did:dkg:base:84532/0x1111111111111111111111111111111111111111/1');
  const claims = [operationId, 'another', '', 'unsafe id'].map(value => ({ subject: head, graph: f.graph,
    predicate: dkg + 'shareOperationId', object: JSON.stringify(value) }));
  const record = decodeEntityShareMetadata(cg, [...f.metadata, ...claims]).find(record => record.kind === 'head');
  expect(record?.operationSubjects).toEqual([f.operation, workspaceOperationSubject(cg, 'another')]);
});
