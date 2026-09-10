import { afterEach, describe, expect, it } from 'vitest';
import { createOperationContext, contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { generateOwnershipQuads, generateShareMetadata, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { storeWorkspaceOperationPublicQuads } from '../../publisher/src/workspace-resolution.js';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { admitSharedMemoryMetadata } from '../src/sync/shared-memory-metadata-admission.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';

const CG = 'admission-cg';
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
    expect(admitSharedMemoryMetadata(rows, CG, subGraphName ? [subGraphName] : [])).toEqual(rows);
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
    expect(admitSharedMemoryMetadata([...valid, ...extra], CG)).toEqual(valid);
  });

  it('binds operation subjects and identity fields to the same context graph and subgraph', () => {
    const valid = legacy('code');
    expect(admitSharedMemoryMetadata(valid, CG, ['code'])).toEqual(valid);
    expect(admitSharedMemoryMetadata(valid, CG, [])).toEqual([]);
    expect(admitSharedMemoryMetadata(valid.map((row) => ({ ...row, subject: 'urn:arbitrary:operation' })), CG, ['code'])).toEqual([]);
    expect(admitSharedMemoryMetadata(valid.map((row) => row.predicate === `${DKG}contextGraphId`
      ? { ...row, object: '"another-cg"' } : row), CG, ['code'])).toEqual([]);
    expect(admitSharedMemoryMetadata(valid.map((row) => ({ ...row, graph: META })), CG, ['code'])).toEqual([]);
    expect(admitSharedMemoryMetadata(valid)).toEqual(valid);
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
    expect(admitSharedMemoryMetadata(valid, CG)).toEqual(valid);
    const extras = [q(subject, `${DKG}workspaceOwner`, '"attacker"'), ...valid.filter((row) => row.subject === subject)
      .map((row) => ({ ...row, subject: 'urn:dkg:public-stage:arbitrary' }))];
    expect(admitSharedMemoryMetadata([...valid, ...extras], CG)).toEqual(valid);
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
    expect(admitSharedMemoryMetadata(input, CG)).toEqual(share.meta);
    const [descriptor] = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: input });
    expect(descriptor.metadataQuads).toHaveLength(share.meta.length);
    expect(descriptor.metadataQuads).not.toEqual(expect.arrayContaining([extra[0]]));
    for (const row of extra) expect(descriptor.metadataQuads).not.toContainEqual(row);
  });

  it('does not grant legacy ownership controls to reserved protocol subjects', () => {
    const share = swmFixtures(CG).share({ ual: UAL, version: 1, operationId: 'modern-op', marker: 'modern' });
    const extra = [
      q(OP, `${DKG}rootEntity`, share.headSubject),
      q(share.headSubject, `${DKG}workspaceOwner`, '"attacker"'),
    ];
    const valid = [...legacy(), ...share.meta];
    expect(admitSharedMemoryMetadata([...valid, ...extra], CG)).toEqual(valid);
  });

  it('rejects unknown scope versions and incomplete operation identity rather than treating them as legacy', () => {
    const original = legacy();
    expect(admitSharedMemoryMetadata([...original, q(OP, `${DKG}contentScopeVersion`, '"3"')], CG)).toEqual([]);
    expect(admitSharedMemoryMetadata([...original, q(OP, `${DKG}kaUal`, UAL)], CG)).toEqual([]);
    expect(admitSharedMemoryMetadata(original.filter((row) => row.predicate !== `${DKG}shareOperationId`), CG)).toEqual([]);
    expect(admitSharedMemoryMetadata([...original, q(OP, `${DKG}shareOperationId`, '"conflicting"')], CG)).toEqual([]);
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
