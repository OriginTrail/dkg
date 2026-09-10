import { afterEach, describe, expect, it } from 'vitest';
import { createOperationContext, contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { generateOwnershipQuads, generateShareMetadata, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from '../../publisher/src/workspace-resolution.js';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { admitSharedMemoryMetadata, type SharedMemoryAdmissionScope } from '../src/sync/shared-memory-metadata-admission.js';
import { projectLegacySwmHydration, projectSwmPersistence, projectStrictSwmRecovery } from '../src/sync/shared-memory-metadata-projections.js';
import { swmRecordKey } from '../src/sync/shared-memory-metadata-records.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { legacySwm20260507 } from './fixtures/legacy-swm-20260507.js';

const CG = 'admission-cg';
const contextScope = (contextGraphId: string, names: readonly string[] = []) => ({
  kind: 'context' as const, contextGraphId, registeredSubGraphNames: new Set(names),
});
const DKG = 'http://dkg.io/ontology/';
const META = contextGraphSharedMemoryMetaUri(CG);
const ROOT = 'urn:data:allowed';
const OP = `urn:dkg:share:${CG}:legacy-op`;
const UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/1';
const q = (subject: string, predicate: string, object: string, graph = META): Quad => ({ subject, predicate, object, graph });
function legacy(subGraphName?: string): Quad[] {
  return generateShareMetadata({
    contextGraphId: CG, shareOperationId: 'legacy-op', rootEntities: [ROOT],
    publisherPeerId: 'peer-source', timestamp: new Date(0), subGraphName,
  }, contextGraphSharedMemoryMetaUri(CG, subGraphName));
}

function projectMetadata(quads: readonly Quad[], scope: SharedMemoryAdmissionScope) {
  const model = admitSharedMemoryMetadata(quads, scope);
  return {
    metadata: projectSwmPersistence(model),
    ...projectLegacySwmHydration(model),
    heads: model.records.filter(record => record.role === 'head'),
    graphOperations: new Map(model.records.filter(record => record.role === 'graphOperation')
      .map(record => [swmRecordKey(record.metaGraph, record.subject), record])),
    legacyOperations: new Map(model.records.filter(record => record.role === 'legacyOperation')
      .map(record => [swmRecordKey(record.metaGraph, record.subject), record])),
    rejectedHeads: model.rejections.filter(rejection => rejection.recordRole === 'head')
      .map(({ subject, metaGraph }) => ({ subject, metaGraph })),
  };
}

describe('shared-memory metadata protocol admission', () => {
  const workers: SyncVerifyWorker[] = [];
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    for (const store of stores.splice(0)) await store.close();
  });

  async function readGraph(store: OxigraphStore, graph: string): Promise<Quad[]> {
    const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    if (result.type !== 'bindings') throw new Error('Expected graph rows');
    return result.bindings.map((row) => q(row.s, row.p, row.o, graph));
  }

  it.each([
    'urn:dkg:share:customer:42',
    `urn:dkg:share:${CG}:user-entity`,
    'urn:dkg:public-stage:customer:_:42:urn%3Aroot',
    'urn:user:entity#dkg-swm-head',
    `${UAL}#dkg-swm-head`,
    OP,
  ])('synchronizes a locally accepted root named %s', async rootEntity => {
    const store = new OxigraphStore(); stores.push(store);
    const graphManager = new GraphManager(store);
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const data = [q(rootEntity, 'urn:data:name', '"accepted locally"', contextGraphSharedMemoryUri(CG))];
    await storeWorkspaceOperationPublicQuads({
      store, graphManager, contextGraphId: CG, shareOperationId: 'legacy-op',
      rootEntities: [rootEntity], quads: data, publisherPeerId: 'peer-source', timestamp: new Date(0),
    });
    await store.insert(generateOwnershipQuads([{ rootEntity, creatorPeerId: 'peer-source' }], META));
    const metadata = await readGraph(store, META);
    const result = await worker.processSharedMemoryBatch(data, metadata, CG);
    expect(result.verifiedData).toEqual(data);
    expect(result.entityCreators).toEqual([{ dataGraph: data[0].graph, entity: rootEntity, creator: 'peer-source' }]);
    expect(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: result.verifiedMeta })).toEqual([]);
  });

  it.each([true, false])('hydrates worker ownership with dedicated creator present = %s', async dedicated => {
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const metadata = legacy()
      .filter(row => dedicated || row.predicate !== `${DKG}publisherPeerId`)
      .map(row => row.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo'
        ? { ...row, object: '"fallback-peer"' } : row);
    const data = [q(ROOT, 'urn:data:name', '"accepted"', contextGraphSharedMemoryUri(CG))];
    const result = await worker.processSharedMemoryBatch(data, metadata, CG);
    expect(result.verifiedData).toEqual(data);
    expect(result.entityCreators).toEqual([{
      dataGraph: data[0].graph, entity: ROOT, creator: dedicated ? 'peer-source' : 'fallback-peer',
    }]);
  });

  it.each([undefined, 'code'])('retains historical identity-free producer records in the real worker for subgraph %s', async subGraphName => {
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const fixture = legacySwm20260507(CG, subGraphName);
    const result = await worker.processSharedMemoryBatch(fixture.data, fixture.metadata, CG, subGraphName ? [subGraphName] : []);
    expect(result.verifiedMeta).toEqual(fixture.metadata);
    expect(result.verifiedData).toEqual(fixture.data);
    expect(result.entityCreators).toEqual([{ dataGraph: fixture.data[0].graph, entity: fixture.root, creator: 'historical-peer' }]);
  });

  it('removes unknown predicates before comparing graph-scoped operation candidates', () => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'first', marker: 'same' });
    const secondSubject = `urn:dkg:share:${CG}:second`;
    const second = share.meta.filter(row => row.subject === share.operationSubject).map(row => ({
      ...row, subject: secondSubject,
      ...(row.predicate === `${DKG}shareOperationId` ? { object: '"second"' } : {}),
    }));
    const extra = q(secondSubject, 'urn:extension:unrecognized', '"must not affect candidates"');
    const descriptors = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: [
      ...share.meta, ...second, extra, q(share.headSubject, `${DKG}shareOperationId`, '"second"'),
    ] });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].metadataQuads).not.toContainEqual(extra);
  });

  it('applies admission through the standalone worker endpoint', async () => {
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'standalone', marker: 'modern' });
    const data = [q(ROOT, 'urn:data:name', '"must not hydrate"', contextGraphSharedMemoryUri(CG))];
    const result = await worker.processSharedMemory(data, [
      ...share.meta, q(share.operationSubject, `${DKG}rootEntity`, ROOT),
      q(ROOT, `${DKG}workspaceOwner`, '"attacker"'),
    ]);
    expect(result).toEqual({ validQuads: [], dropped: 1, entityCreators: [] });
  });

  it.each([undefined, 'code'])('retains real legacy and graph-scoped producer output for subgraph %s after a store round trip', async (subGraphName) => {
    const store = new OxigraphStore(); stores.push(store);
    const graphManager = new GraphManager(store);
    const common = {
      store, graphManager, contextGraphId: CG, subGraphName,
      publisherPeerId: 'peer-source', timestamp: new Date(0),
      quads: [q(ROOT, 'urn:data:name', '"published"', '')],
    };
    await storeWorkspaceOperationPublicQuads({ ...common, shareOperationId: 'legacy-op', rootEntities: [ROOT] });
    await storeKnowledgeAssetOperationPublicQuads({ ...common, shareOperationId: 'modern-op', kaUal: UAL, assertionVersion: 1 });
    await storeKnowledgeAssetWorkspaceHead({ ...common, shareOperationId: 'modern-op', kaUal: UAL, assertionVersion: 1 });
    const rows = await readGraph(store, contextGraphSharedMemoryMetaUri(CG, subGraphName));
    expect(rows.length).toBeGreaterThan(20);
    expect(projectMetadata(rows, contextScope(CG, subGraphName ? [subGraphName] : [])).metadata).toEqual(rows);
  });

  it('preserves producer metadata and drops unknown predicates, subjects, and misplaced protocol fields', () => {
    const valid = [...legacy(), ...generateOwnershipQuads([{ rootEntity: ROOT, creatorPeerId: 'peer-source' }], META)];
    const extra = [
      q(OP, 'urn:extension:run', '"command"'),
      q('urn:dkg:swm-gc:work-item', `${DKG}publishedAt`, '"0"'),
      q(ROOT, `${DKG}rootEntity`, 'urn:data:injected'),
      q('urn:data:unrelated', `${DKG}workspaceOwner`, '"attacker"'),
      q(OP, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:extension:ControlRecord'),
    ];
    expect(projectMetadata([...valid, ...extra], contextScope(CG)).metadata).toEqual(valid);
  });

  it('binds operation subjects and identity fields to the same context graph and subgraph', () => {
    const valid = legacy('code');
    expect(projectMetadata(valid, contextScope(CG, ['code'])).metadata).toEqual(valid);
    expect(projectMetadata(valid, contextScope(CG, [])).metadata).toEqual([]);
    expect(projectMetadata(valid.map((row) => ({ ...row, subject: 'urn:arbitrary:operation' })), contextScope(CG, ['code'])).metadata).toEqual([]);
    expect(projectMetadata(valid.map((row) => row.predicate === `${DKG}contextGraphId`
      ? { ...row, object: '"another-cg"' } : row), contextScope(CG, ['code'])).metadata).toEqual([]);
    expect(projectMetadata(valid.map((row) => ({ ...row, graph: META })), contextScope(CG, ['code'])).metadata).toEqual([]);
    expect(projectMetadata(valid, { kind: 'allGraphs' }).metadata).toEqual(valid);
  });

  it('retains defined legacy snapshot-reference and member aliases on canonical subjects', () => {
    const subject = `urn:dkg:public-stage:${[CG, '_', 'legacy-op', ROOT].map(encodeURIComponent).join(':')}`;
    const valid = [
      ...legacy(), q(OP, `${DKG}entity`, ROOT),
      q(subject, `${DKG}contextGraphId`, `"${CG}"`),
      q(subject, `${DKG}shareOperationId`, '"legacy-op"'),
      q(subject, `${DKG}publicSliceRootEntity`, ROOT),
      q(subject, `${DKG}publicQuadsDigest`, '"sha256:legacy"'),
      q(subject, `${DKG}publicQuadsCount`, '"1"'),
      q(subject, `${DKG}publicSnapshotRef`, '"old-store-ref"'),
      q(ROOT, 'http://www.w3.org/ns/prov#wasAttributedTo', 'did:dkg:agent:0x1234'),
    ];
    expect(projectMetadata(valid, contextScope(CG)).metadata).toEqual(valid);
    const extras = [q(subject, `${DKG}workspaceOwner`, '"attacker"'), ...valid.filter((row) => row.subject === subject)
      .map((row) => ({ ...row, subject: 'urn:dkg:public-stage:arbitrary' }))];
    expect(projectMetadata([...valid, ...extras], contextScope(CG)).metadata).toEqual(valid);
  });

  it('preserves historical partial slices without treating ownership-only user roots as slices', () => {
    const subject = `urn:dkg:public-stage:${CG}:_:legacy-op:urn%3Adata%3Aallowed`;
    const attribution = q(subject, 'http://www.w3.org/ns/prov#wasAttributedTo', '"historical-peer"');
    const partial = [...legacy(), attribution];
    expect(projectMetadata(partial, contextScope(CG)).metadata).toEqual(partial);
    const rootMember = q(OP, `${DKG}rootEntity`, subject);
    const owner = q(subject, `${DKG}workspaceOwner`, '"peer-source"');
    const userRoot = [...partial, rootMember, owner];
    expect(projectMetadata(userRoot, contextScope(CG)).metadata).toEqual(userRoot);
  });

  it('keeps graph-scoped operations rootless and filters direct descriptor metadata too', () => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'modern-op', marker: 'modern' });
    const extra = [
      q(share.operationSubject, `${DKG}rootEntity`, ROOT),
      q(share.operationSubject, 'urn:extension:run', '"command"'),
      q(share.headSubject, `${DKG}workspaceOwner`, '"attacker"'),
      q(share.headSubject, `${DKG}publicSnapshotRef`, '"injected"'),
      q(ROOT, `${DKG}workspaceOwner`, '"attacker"'),
    ];
    const input = [...share.meta, ...extra];
    expect(projectMetadata(input, contextScope(CG)).metadata).toEqual(share.meta);
    const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: input });
    expect(descriptor.metadataQuads).toHaveLength(share.meta.length);
    expect(descriptor.metadataQuads).not.toEqual(expect.arrayContaining([extra[0]]));
    for (const row of extra) expect(descriptor.metadataQuads).not.toContainEqual(row);
  });

  it.each(['head', 'public-slice'])('hydrates a legacy root that is also an actual %s record without trusting injected ownership', async role => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'modern-op', marker: 'modern' });
    const sliceSubject = `urn:dkg:public-stage:${CG}:_:legacy-op:urn%3Adata%3Aallowed`;
    const slice = [
      q(sliceSubject, `${DKG}contextGraphId`, `"${CG}"`),
      q(sliceSubject, `${DKG}shareOperationId`, '"legacy-op"'),
      q(sliceSubject, `${DKG}publicSliceRootEntity`, ROOT),
      q(sliceSubject, `${DKG}publicQuadsDigest`, '"sha256:legacy"'),
      q(sliceSubject, `${DKG}publicQuadsCount`, '"1"'),
    ];
    const root = role === 'head' ? share.headSubject : sliceSubject;
    const member = q(OP, `${DKG}rootEntity`, root);
    const attacker = q(root, `${DKG}workspaceOwner`, '"attacker"');
    const valid = [...legacy(), ...(role === 'head' ? share.meta : slice), member];
    const input = [...valid, attacker];
    const model = projectMetadata(input, contextScope(CG));
    expect(model.metadata).toEqual(valid);
    expect(model.legacyRoots.get(contextGraphSharedMemoryUri(CG))?.has(root)).toBe(true);
    const data = [q(root, 'urn:data:name', '"record subject is user data too"', contextGraphSharedMemoryUri(CG))];
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const result = await worker.processSharedMemoryBatch(data, input, CG);
    expect(result.verifiedData).toEqual(data);
    expect(result.verifiedMeta).toEqual(valid);
    expect(result.entityCreators).toEqual([ROOT, root].map(entity => ({
      dataGraph: data[0].graph, entity, creator: 'peer-source',
    })));
  });

  it('retains a rejected-head diagnostic so descriptor parsing fails closed', () => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'head', marker: 'head' });
    const invalidHead = 'urn:not-a-ka#dkg-swm-head';
    const rows = share.meta.map(row => row.subject === share.headSubject ? { ...row, subject: invalidHead } : row);
    const model = projectMetadata(rows, contextScope(CG));
    expect(model.heads).toEqual([]);
    expect(model.rejectedHeads).toEqual([{ subject: invalidHead, metaGraph: META }]);
    expect(model.metadata.every(row => row.subject !== invalidHead)).toBe(true);
    expect(() => parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: rows }))
      .toThrow('non-canonical or mismatched kaUal');
    const operationShapedHead = `urn:dkg:share:${CG}:malformed#dkg-swm-head`;
    const conflictingRows = rows.map(row => row.subject === invalidHead ? { ...row, subject: operationShapedHead } : row);
    conflictingRows.push(q(operationShapedHead, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${DKG}WorkspaceOperation`));
    expect(() => parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: conflictingRows }))
      .toThrow('non-canonical or mismatched kaUal');
  });

  it('rejects modern downgrade envelopes and mismatched explicit identity', () => {
    const original = legacy();
    expect(projectMetadata([...original, q(OP, `${DKG}contentScopeVersion`, '"3"')], contextScope(CG)).metadata).toEqual([]);
    expect(projectMetadata([...original, q(OP, `${DKG}kaUal`, UAL)], contextScope(CG)).metadata).toEqual([]);
    const withoutId = original.filter((row) => row.predicate !== `${DKG}shareOperationId`);
    expect(projectMetadata(withoutId, contextScope(CG)).metadata).toEqual(withoutId);
    expect(projectMetadata([...original, q(OP, `${DKG}shareOperationId`, '"conflicting"')], contextScope(CG)).metadata).toEqual([]);
    const modern = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'modern', marker: 'modern' });
    const missingIdentity = modern.meta.filter(row => row.predicate !== `${DKG}contextGraphId` && row.predicate !== `${DKG}shareOperationId`);
    expect(projectMetadata(missingIdentity, contextScope(CG)).graphOperations.size).toBe(0);
  });

  it('preserves metadata order and duplicates while deriving graph-local roots and ownership once', () => {
    const root = legacySwm20260507(CG);
    const child = legacySwm20260507(CG, 'code');
    const childRows = child.metadata.map(row => row.predicate === 'http://www.w3.org/ns/prov#wasAttributedTo'
      ? { ...row, object: '"child-peer"' } : row);
    const alias = { ...root.metadata[3], predicate: `${DKG}entity` };
    const rows = [...root.metadata, childRows[0], alias, ...childRows.slice(1), root.metadata[3], { ...root.metadata[3] }];
    const model = projectMetadata(rows, contextScope(CG, ['code']));
    expect(model.metadata).toEqual(rows);
    expect(model.legacyOperations.size).toBe(2);
    expect([...model.legacyRoots.keys()]).toEqual([root.data[0].graph, child.data[0].graph]);
    expect(model.ownership).toEqual([
      { dataGraph: root.data[0].graph, entity: root.root, creator: 'historical-peer' },
      { dataGraph: child.data[0].graph, entity: child.root, creator: 'child-peer' },
    ]);
  });

  it('projects source positions after role rows have been cloned, preserving interleaved ownership precedence', () => {
    const first = legacy();
    const second = first.map(row => ({ ...row, subject: row.subject.replace('legacy-op', 'second-op'),
      ...(row.predicate === `${DKG}shareOperationId` ? { object: '"second-op"' } : {}),
      ...(row.predicate === `${DKG}publisherPeerId` ? { object: '"second-peer"' } : {}),
    }));
    const member = first.find(row => row.predicate === `${DKG}rootEntity`)!;
    // First operation is indexed first, but the second operation's root occurs first.
    const rows = [...first.filter(row => row !== member), ...second, member, member, { ...member }];
    const model = admitSharedMemoryMetadata(rows, contextScope(CG));
    const cloned = { ...model, records: model.records.map(record => ({
      ...record, rows: record.rows.map(row => ({ ...row, quad: { ...row.quad } })),
    })) };
    expect(projectSwmPersistence(cloned)).toEqual(rows);
    expect(projectSwmPersistence(cloned).filter(row => row === member)).toHaveLength(2);
    expect(projectLegacySwmHydration(cloned).ownership).toEqual([
      { dataGraph: contextGraphSharedMemoryUri(CG), entity: ROOT, creator: 'second-peer' },
    ]);
  });

  it('keeps head role and descriptor validation when another RDF type is injected', () => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'typed-head', marker: 'head' });
    const injected = q(share.headSubject, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${DKG}WorkspaceOperation`);
    const rows = [...share.meta, injected];
    expect(projectMetadata(rows, contextScope(CG)).metadata).toEqual(share.meta);
    expect(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: rows })).toHaveLength(1);
  });

  it('retains explicit out-of-scope diagnostics for strict recovery while persistence drops the lane', () => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'unregistered', marker: 'head' });
    const graph = contextGraphSharedMemoryMetaUri(CG, 'private');
    const rows = share.meta.map(row => ({ ...row, graph }));
    const model = admitSharedMemoryMetadata(rows, contextScope(CG));
    expect(projectSwmPersistence(model)).toEqual([]);
    expect(model.rejections).toEqual([{
      role: 'rejected', recordRole: 'head', reason: 'outOfScope', subject: share.headSubject, metaGraph: graph,
    }]);
    expect(() => projectStrictSwmRecovery(model)).toThrow(`unregistered metadata graph ${graph}`);
    expect(() => parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: rows,
      registeredSubGraphNames: ['private'], excludedSubGraphNames: ['private'],
    })).toThrow(`unregistered metadata graph ${graph}`);
  });

  it('admits historical slices only when their encoded identity names a same-lane legacy root', () => {
    const fixture = legacySwm20260507(CG, 'code');
    const mutations = [
      (row: Quad) => ({ ...row, subject: row.subject.replace('historical-operation', 'other-operation') }),
      (row: Quad) => ({ ...row, subject: row.subject.replace(':code:', ':unknown:') }),
      (row: Quad) => ({ ...row, subject: row.subject.replace('urn%3Ahistorical%3Aroot', 'urn%3Aunrelated%3Aroot') }),
      (row: Quad) => ({ ...row, subject: row.subject.replace('urn%3Ahistorical%3Aroot', '%ZZ') }),
    ];
    const operationRows = fixture.metadata.filter(row => row.subject === fixture.operation);
    const slices = fixture.metadata.filter(row => row.subject === fixture.slice);
    for (const mutate of mutations) {
      expect(projectMetadata([...operationRows, ...slices.map(mutate)], contextScope(CG, ['code'])).metadata)
        .toEqual(operationRows);
    }
  });

  it('applies admission before the real worker derives data selection and ownership', async () => {
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'modern-op', marker: 'modern' });
    const data = [q(ROOT, 'urn:data:name', '"must not hydrate"', contextGraphSharedMemoryUri(CG))];
    const forged = [
      ...share.meta, q(share.operationSubject, `${DKG}rootEntity`, ROOT),
      q(ROOT, `${DKG}workspaceOwner`, '"attacker"'),
      q('urn:dkg:swm-gc:work-item', `${DKG}publishedAt`, '"0"'),
    ];
    const result = await worker.processSharedMemoryBatch(data, forged, CG);
    expect(result.verifiedMeta).toEqual(share.meta);
    expect(result.verifiedData).toEqual([]);
    expect(result.entityCreators).toEqual([]);
    expect(result).toMatchObject({ droppedDataTriples: 1, totalFetchedMetaQuads: forged.length, emptyResponses: 0 });
    const accepted = await worker.processSharedMemoryBatch(data, legacy(), CG);
    expect(accepted.verifiedData).toEqual(data);
    expect(accepted.entityCreators).toEqual([{ dataGraph: contextGraphSharedMemoryUri(CG), entity: ROOT, creator: 'peer-source' }]);
  });

  it.each([
    ['publishedAt', `${DKG}publishedAt`],
    ['WorkspaceOperation type', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'],
  ])('does not authorize a legacy root without its mandatory %s row', async (_name, predicate) => {
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const metadata = legacy().filter(row => row.predicate !== predicate);
    const data = [q(ROOT, 'urn:data:name', '"must remain unauthorized"', contextGraphSharedMemoryUri(CG))];
    const result = await worker.processSharedMemoryBatch(data, metadata, CG);
    expect(result.verifiedData).toEqual([]);
    expect(result.entityCreators).toEqual([]);
    const hydration = projectLegacySwmHydration(admitSharedMemoryMetadata(metadata, contextScope(CG)));
    expect([...hydration.legacyRoots]).toEqual([]);
    expect(hydration.ownership).toEqual([]);
  });

  it('persists only admitted metadata through real worker, requester, and Oxigraph storage', async () => {
    const worker = new SyncVerifyWorker(); workers.push(worker);
    const store = new OxigraphStore(); stores.push(store);
    const data = [q(ROOT, 'urn:data:name', '"allowed"', contextGraphSharedMemoryUri(CG))];
    const valid = legacy();
    const metadata = [
      ...valid,
      q(OP, 'urn:extension:run', '"command"'),
      q('urn:dkg:swm-gc:work-item', `${DKG}publishedAt`, '"0"'),
      q('urn:data:unrelated', `${DKG}workspaceOwner`, '"attacker"'),
    ];
    const owned = new Map<string, string>();
    const result = await runSharedMemorySync({
      mode: { kind: 'ordinary' }, ctx: createOperationContext('sync'), remotePeerId: 'peer-source', contextGraphIds: [CG],
      createContextGraphSyncDeadline: () => Date.now() + 30_000,
      fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => {
        const quads = phase === 'data' ? data : metadata;
        return { quads, bytesReceived: 1, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: phase, completed: true, timedOut: false };
      },
      processSharedMemoryBatch: (...args) => worker.processSharedMemoryBatch(...args),
      ensureContextGraph: async () => {}, storeInsert: (quads) => store.insert(quads),
      deleteCheckpoint: () => {}, setCheckpoint: () => {}, ensureOwnedMap: () => owned,
      logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
    });
    expect(result).toMatchObject({ failedPeers: 0, insertedDataTriples: 1, insertedMetaTriples: valid.length });
    const persisted = await readGraph(store, META);
    expect(persisted).toHaveLength(valid.length);
    expect(persisted).not.toEqual(expect.arrayContaining([metadata[valid.length]]));
    expect(owned.get(ROOT)).toBe('peer-source');
    expect(owned.has('urn:data:unrelated')).toBe(false);
  });
});
