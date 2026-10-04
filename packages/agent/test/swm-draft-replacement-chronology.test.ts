import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { persistWorkspaceOperationEvidence } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { persistLocalSwmOperation } from './_helpers/local-swm-operation.js';
import { ethers } from 'ethers';
import { encodeRootlessWorkspaceRequest } from '../../publisher/test/_helpers/rootless-workspace.js';
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore, readSwmMaterializationWitness, type Quad } from '@origintrail-official/dkg-storage';
import { workspaceKnowledgeAssetOperationSnapshotGraph, TypedEventBus, computeGossipSigningPayload, encodeGossipEnvelope, GOSSIP_ENVELOPE_VERSION, GOSSIP_TYPE_WORKSPACE_PUBLISH, type OperationContext } from '@origintrail-official/dkg-core';
import { resolveKnowledgeAssetWorkspaceHead, SharedMemoryHandler, TripleStoreAsyncLiftPublisher, resolveKnowledgeAssetOperationPublicQuads, withKeyedLocks, swmKaWriteLockKey, storageAckLedgerEntryQuads, workspaceOperationSubject } from '@origintrail-official/dkg-publisher';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { recoverContextGraphSwm } from '../src/sync/requester/swm-recovery.js';
import { commitRecoveredSwmAsset } from '../src/sync/requester/swm-recovery-commit.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';

const CG = 'draft-chronology';
const UAL = 'did:dkg:hardhat:31337/0xcccccccccccccccccccccccccccccccccccccccc/3';
const DKG = 'http://dkg.io/ontology/';
const ctx: OperationContext = { operationId: 'chronology', operationName: 'sync' } as never;
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); });

function share(version: number, id: string, timestamp: number, subGraph?: string, graphLocator = false, privateOnly = false) {
  const fixture = swmFixtures(CG).share({ version, operationId: id, marker: id, ual: UAL, ...(privateOnly ? { payloadCount: 0, privateTripleCount: 1, privateMerkleRoot: new Uint8Array(32).fill(0xab) } : {}) });
  const scoped = (graph: string) => subGraph ? graph.replace(`${CG}/`, `${CG}/${subGraph}/`) : graph;
  const meta = fixture.meta.map(quad => ({
    ...quad,
    graph: scoped(quad.graph),
    object: quad.predicate === `${DKG}publishedAt` ? `"${new Date(timestamp).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`
      : quad.predicate === `${DKG}assertionGraph` ? scoped(quad.object) : quad.object,
  }));
  if (subGraph) meta.push({ subject: fixture.operationSubject, predicate: `${DKG}subGraphName`, object: JSON.stringify(subGraph), graph: meta[0]!.graph });
  if (graphLocator) {
    const locator = workspaceKnowledgeAssetOperationSnapshotGraph(CG, id, subGraph);
    const ref = meta.find(quad => quad.predicate === `${DKG}publicSnapshotRef`)!;
    ref.predicate = `${DKG}publicSnapshotGraph`; ref.object = locator;
  }
  return { ...fixture, meta, assertionGraph: scoped(fixture.assertionGraph) };
}
type Share = ReturnType<typeof share>;
const inGraph = (fixture: Share) => fixture.payload.map(quad => ({ ...quad, graph: fixture.assertionGraph }));
const page = (quads: readonly Quad[]): SyncPageResult => ({ quads: [...quads], bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed: true });

function harness(store: OxigraphStore, served: Share, readConfirmed = async (): Promise<bigint | null> => 0n) {
  const writeLocks = new Map<string, Promise<void>>();
  const invalidateListContextGraphsCache = vi.fn();
  const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks, invalidateListContextGraphsCache, readConfirmedKnowledgeAssetVersion: readConfirmed });
  const snapshots = new Map([[served.digest, served.payload]]);
  const publicSnapshotStore = {
    putSnapshot: async (input: { digest: string; quads: readonly Quad[] }) => { snapshots.set(input.digest, [...input.quads]); return { ref: input.digest, byteLength: 0 }; },
    getSnapshot: async (ref: string) => snapshots.get(ref) ?? null,
  };
  const fetchSyncPages = async (_ctx: OperationContext, _peer: string, _cg: string, _swm: boolean, phase: string) => page(phase === 'meta' ? served.meta : phase === 'data' ? [...inGraph(served), ...served.payload.map(quad => ({ ...quad, graph: served.meta.find(row => row.predicate === `${DKG}publicSnapshotGraph`)?.object ?? served.assertionGraph }))] : served.payload);
  const processSharedMemoryBatch = async (data: Quad[], meta: Quad[]) => ({ verifiedData: [], verifiedMeta: meta, totalFetchedDataQuads: data.length, totalFetchedMetaQuads: meta.length, droppedDataTriples: 0, emptyResponses: 0, entityCreators: [] });
  const companion = vi.fn(() => ({ graphUri: 'urn:test:boundary', subject: 'urn:test:boundary:head', quads: [{ subject: 'urn:test:boundary:head', predicate: 'urn:test:operation', object: JSON.stringify(served.operationId), graph: 'urn:test:boundary' }] }));
  const common = { ctx, remotePeerId: 'peer-source', fetchSyncPages, processSharedMemoryBatch, ensureContextGraph: async () => {}, publicSnapshotStore, snapshotMaterializer: materializer, setCheckpoint: () => {}, deleteCheckpoint: () => {}, ensureOwnedMap: () => new Map<string, string>(), getRegisteredSubGraphNames: async () => ['team'], logInfo: () => {}, logWarn: () => {}, logDebug: () => {} };
  const publicRun = () => runSharedMemorySync({ ...common, mode: { kind: 'ordinary' }, contextGraphIds: [CG], createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER, storeInsert: quads => store.insert(quads), resolveRootSnapshotAtomicCompanion: companion });
  const privateRun = () => recoverContextGraphSwm({ ...common, contextGraphId: CG, deadline: Number.MAX_SAFE_INTEGER, store, writeLocks, replaceMetaForRoots: async () => {}, resolveRootAtomicCompanion: companion });
  return { publicRun, privateRun, companion, materializer, writeLocks, invalidateListContextGraphsCache };
}

async function expectHead(store: OxigraphStore, expected: Share, subGraph?: string) {
  const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL, subGraphName: subGraph });
  expect(head?.shareOperationId).toBe(expected.operationId);
  expect(head?.assertionVersion).toBe(String(expected.version));
  const graph = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${expected.assertionGraph}> { ?s ?p ?o } }`);
  expect(graph.type).toBe('quads');
  if (graph.type === 'quads') expect(graph.quads.map(quad => quad.subject).sort()).toEqual(expected.payload.map(quad => quad.subject).sort());
}

const staleCases = (['publicRun', 'privateRun'] as const).flatMap(lane =>
  ([[1, 1], [4, 2]] as const).flatMap(([oldVersion, currentVersion]) =>
    [undefined, 'team'].flatMap(subGraph => [false, true].map(graphLocator => ({ lane, oldVersion, currentVersion, subGraph, scope: subGraph ?? 'root', graphLocator })))));

describe('legacy catch-up respects publisher draft chronology', () => {
  it.each(['publicRun', 'privateRun'] as const)('%s delegates replacement effects to the canonical materializer', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const current = share(1, 'older-effects', 1000, 'team');
    const incoming = share(1, 'newer-effects', 2000, 'team');
    for (const f of [current, incoming]) await persistLocalSwmOperation(store, CG, f);
    await store.insert([...current.meta.filter(row => row.subject === current.headSubject), ...inGraph(current)]);
    const h = harness(store, incoming);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: current.meta, registeredSubGraphNames: ['team'] })[0]!;
    expect(await h.materializer.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await readSwmMaterializationWitness(store, current.assertionGraph, current.digest)).toBe(true);
    const replaceGraph = vi.spyOn(h.materializer, 'replaceGraph');
    const replaceMetadata = vi.spyOn(h.materializer, 'replaceHeadMetadata');

    await h[lane]();

    expect(replaceGraph).toHaveBeenCalledOnce();
    expect(replaceMetadata).toHaveBeenCalledOnce();
    expect(h.invalidateListContextGraphsCache).toHaveBeenCalled();
    expect(await readSwmMaterializationWitness(store, current.assertionGraph, current.digest)).toBe(false);
    expect(await h.materializer.isGraphAssetMaterialized(descriptor)).toBe(false);
    await expectHead(store, incoming, 'team');
  });

  it.each([undefined, 'team'].flatMap(subGraph => ['allowList-lexical', 'legacy-default'].map(mode => ({ subGraph, mode }))))('recognizes decoded $mode empty alias semantics in $subGraph', async ({ subGraph, mode }) => {
    const store = new OxigraphStore(); stores.push(store);
    const make = (id: string, provider = false) => {
      const f = share(1, id, 1000, subGraph, false, true);
      const meta = f.meta.filter(row => row.predicate !== `${DKG}accessPolicy`);
      if (mode === 'allowList-lexical') {
        meta.push({ subject: f.operationSubject, predicate: `${DKG}accessPolicy`, object: '"allowList"', graph: meta[0]!.graph });
        for (const peer of provider ? ['"peer-b"', '"peer-a"', '"peer-\\u0061"'] : ['"peer-a"', '"peer-b"']) {
          meta.push({ subject: f.operationSubject, predicate: `${DKG}allowedPeer`, object: peer, graph: meta[0]!.graph });
        }
      } else if (!provider) {
        meta.push({ subject: f.operationSubject, predicate: `${DKG}accessPolicy`, object: '"ownerOnly"', graph: meta[0]!.graph });
      }
      return { ...f, meta };
    };
    const first = make('empty-first'); const alias = make('storage-ack-empty'); const incoming = make('empty-provider', true);
    for (const f of [first, alias]) await persistLocalSwmOperation(store, CG, f);
    const head = first.meta.filter(row => row.subject === first.headSubject);
    await store.insert([...head, { ...head.find(row => row.predicate === `${DKG}shareOperationId`)!, object: JSON.stringify(alias.operationId) }]);
    const h = harness(store, incoming);
    const parse = (meta: Quad[]) => parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: meta, registeredSubGraphNames: ['team'] })[0]!;
    const descriptor = parse(incoming.meta);
    expect(await h.materializer.readStoredHead(descriptor)).toMatchObject({ status: 'resolved' });
    expect(await h.materializer.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await h.materializer.readExactMaterializedGraph(descriptor)).toEqual([]);
    const differentVersion = incoming.meta.map(row => row.predicate === `${DKG}assertionVersion` ? { ...row, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' } : row);
    expect(await h.materializer.isGraphAssetMaterialized(parse(differentVersion))).toBe(false);
    const differentPrivateRoot = incoming.meta.map(row => row.predicate === `${DKG}privateMerkleRoot` ? { ...row, object: JSON.stringify(`0x${'cd'.repeat(32)}`) } : row);
    expect(await h.materializer.isGraphAssetMaterialized(parse(differentPrivateRoot))).toBe(false);
  });

  it.each(['publicRun', 'privateRun', 'preserveSkipped'] as const)('%s extends healthy equivalent aliases without stranding a queued ACK snapshot', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const make = (id: string, clock: number) => swmFixtures(CG).share({ version: 2, operationId: id, marker: 'same-queued-content', ual: UAL, timestamp: new Date(clock) });
    const original = make('a-publisher', 1000); const ack = make('storage-ack-B', 2000); const newer = make('publisher-C', 3000);
    const ackLocator = ack.meta.find(row => row.subject === ack.operationSubject && row.predicate === `${DKG}publicSnapshotRef`)!;
    ackLocator.predicate = `${DKG}publicSnapshotGraph`; ackLocator.object = workspaceKnowledgeAssetOperationSnapshotGraph(CG, ack.operationId);
    const headRows = original.meta.filter(row => row.subject === original.headSubject);
    for (const f of [original, ack]) await persistLocalSwmOperation(store, CG, f);
    await store.insert([...headRows, { ...headRows.find(row => row.predicate === `${DKG}shareOperationId`)!, object: JSON.stringify(ack.operationId) }, ...inGraph(original)]);
    const queue = new TripleStoreAsyncLiftPublisher(store);
    await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, kaUal: UAL, assertionVersion: '2', shareOperationId: ack.operationId }));
    await persistLocalSwmOperation(store, CG, newer);
    const readSnapshot = () => resolveKnowledgeAssetOperationPublicQuads({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL, assertionVersion: '2', shareOperationId: ack.operationId });
    const before = await readSnapshot(); expect(before.quads).toHaveLength(ack.payload.length);
    const query = vi.spyOn(store, 'query');
    const h = harness(store, newer);
    if (lane === 'preserveSkipped') expect(await h.materializer.preserveStoredIdentityForSkippedAsset(CG, parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: newer.meta })[0]!)).toMatchObject({ outcome: 'preserved' });
    else await h[lane]();
    expect(query.mock.calls.filter(([, options]) => options?.source === 'agent.swmRecovery.localPublisherEvidence')).toHaveLength(1);
    expect(query.mock.calls.some(([, options]) => ['agent.swmRecovery.storedHead', 'agent.sharedMemorySync.snapshotMaterializer.loadCandidates', 'agent.sharedMemorySync.snapshotMaterializer.selectRepairIdentity'].includes(options?.source ?? ''))).toBe(false);
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual([original.operationId, ack.operationId, newer.operationId].sort());
    expect(await readSnapshot()).toEqual(before);
    expect(await queue.list()).toHaveLength(1);
  });
  it.each([undefined, 'team'])('repairs corrupt %s head rows using decoded equivalent identities and authenticated publisher chronology', async subGraph => {
    const store = new OxigraphStore(); stores.push(store);
    const make = (id: string, timestamp: number) => {
      const f = share(2, id, timestamp, subGraph);
      const same = swmFixtures(CG).share({ version: 2, operationId: id, marker: 'same-repair-content', ual: UAL, timestamp: new Date(timestamp) });
      return { ...f, payload: same.payload, digest: same.digest, meta: f.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` || row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(same.digest) } : row) };
    };
    const old = make('a-local-publisher', 1000); const ack = make('storage-ack-unowned-clock', 9000); const incoming = make('publisher-C', 3000);
    for (const op of [old, ack, incoming]) await persistLocalSwmOperation(store, CG, op);
    const headRows = old.meta.filter(row => row.subject === old.headSubject);
    await store.insert([...headRows, { ...headRows.find(row => row.predicate === `${DKG}shareOperationId`)!, object: JSON.stringify(ack.operationId) }, ...inGraph(old)]);
    await store.deleteByPattern({ graph: old.meta[0]!.graph, subject: old.headSubject, predicate: `${DKG}assertionVersion` });
    await store.insert([{ graph: old.meta[0]!.graph, subject: old.headSubject, predicate: `${DKG}assertionVersion`, object: '"malformed"' }]);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: incoming.meta, registeredSubGraphNames: ['team'] })[0]!;
    const h = harness(store, incoming); expect((await h.materializer.prepareRecoveredDescriptor(descriptor)).storedHead.status).toBe('corrupt');
    await h.publicRun();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL, subGraphName: subGraph });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual([old.operationId, incoming.operationId].sort());
    expect(head?.operationAliases.find(alias => alias.shareOperationId === incoming.operationId)).toMatchObject({ publishedAt: '3000', publisherChronologyAuthenticated: true });
  });
  it('does not pair a cached subject with another authenticated operation identity', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const incoming = share(2, 'provider-identity', 3000);
    const cached = incoming.meta.filter(row => row.subject === incoming.operationSubject)
      .map(row => row.predicate === `${DKG}shareOperationId` ? { ...row, object: '"other-identity"' } : row);
    await store.insert(cached); await persistWorkspaceOperationEvidence(store, cached);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: incoming.meta })[0]!;
    const prepared = await harness(store, incoming).materializer.prepareRecoveredDescriptor(descriptor);
    expect(prepared.authenticatedPublisherOperation).toBeUndefined();
    expect(prepared.operationCandidates[0]).toMatchObject({ shareOperationId: incoming.operationId,
      provenance: { publisherChronologyAuthenticated: false } });
  });
  it.each([false, true])('retains decoded authenticated publisher ordering and excludes ACK clocks with tie=%s', async tie => {
    const store = new OxigraphStore(); stores.push(store);
    const make = (id: string, clock: number) => swmFixtures(CG).share({ version: 2, operationId: id, marker: 'same-payload', ual: UAL, timestamp: new Date(clock) });
    const older = make('publisher-B', tie ? 2000 : 1000);
    const newer = make('publisher-C', 2000);
    const ack = make('storage-ack-latest-local-clock', 9000);
    for (const fixture of [older, newer, ack]) await persistLocalSwmOperation(store, CG, fixture);
    const rows = [...older.meta, ...[newer, ack].flatMap(fixture => fixture.meta.filter(row => row.subject === fixture.operationSubject || row.predicate === `${DKG}shareOperationId`))];
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: rows })[0]!;
    const prepared = await harness(store, older).materializer.prepareRecoveredDescriptor(descriptor);
    expect(prepared.operationCandidates).toHaveLength(3);
    expect(prepared.authenticatedPublisherOperation).toMatchObject({ shareOperationId: newer.operationId,
      provenance: { publishedAtMs: 2000, publisherChronologyAuthenticated: true } });
  });
  it.each(['02', '0002'])('keeps canonical integer version %s while preparing decoded store/wire candidates', async lexical => {
    const store = new OxigraphStore(); stores.push(store);
    const incoming = share(2, 'canonical-version-2', 3000);
    await persistLocalSwmOperation(store, CG, incoming);
    const wire = incoming.meta.map(row => row.predicate === `${DKG}assertionVersion`
      ? { ...row, object: `"${lexical}"^^<http://www.w3.org/2001/XMLSchema#integer>` } : row);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: wire })[0]!;
    const prepared = await harness(store, incoming).materializer.prepareRecoveredDescriptor(descriptor);
    expect(prepared.authenticatedPublisherOperation?.shareOperationId).toBe(incoming.operationId);
    expect(prepared.operationCandidates[0]?.semantics.recoveryIdentity.assertionVersion).toBe('2');
  });
  it.each(['publicRun', 'privateRun'] as const)('%s keeps cached unsigned candidate rows separate from authenticated chronology', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const current = share(4, 'trusted-current-4', 2000);
    const incoming = share(2, 'cached-provider-2', 3000);
    await persistLocalSwmOperation(store, CG, current); await store.insert([...current.meta, ...inGraph(current)]);
    await store.insert(incoming.meta.filter(row => row.subject === incoming.operationSubject));
    const h = harness(store, incoming, async () => 1n);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: incoming.meta })[0]!;
    const prepared = await h.materializer.prepareRecoveredDescriptor(descriptor);
    expect(prepared.authenticatedPublisherOperation).toBeUndefined();
    expect(prepared.operationCandidates).toHaveLength(1);
    expect(prepared.operationCandidates[0]).toMatchObject({ shareOperationId: incoming.operationId,
      semantics: { publisherIdentity: 'peer-source', recoveryIdentity: { kaUal: UAL, assertionVersion: '2' } },
      provenance: { shareOperationId: incoming.operationId, publishedAtMs: 3000, publisherChronologyAuthenticated: false } });
    expect(prepared.operationCandidates[0]!.identityKey).not.toBeNull();
    expect(prepared.operationCandidates[0]!.operationRows.some(row => row.predicate === `${DKG}recoveredOperationChronology`)).toBe(true);
    expect(prepared.storedOperationCandidates?.map(candidate => candidate.shareOperationId)).toEqual([current.operationId]);
    await h[lane](); await expectHead(store, current); expect(h.companion).not.toHaveBeenCalled();
  });
  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => ['cold', 'pre-upgrade'].map(mode => ({ lane, mode }))))('$lane authenticates an exact signed replay after $mode recovery without certifying a provider clock', async ({ lane, mode }) => {
    const store = new OxigraphStore(); stores.push(store);
    const wallet = ethers.Wallet.createRandom();
    const ka = `did:dkg:31337/${wallet.address.toLowerCase()}/3`;
    const make = (id: string, marker: string, timestamp: number) => swmFixtures(CG).share({ version: 1, operationId: id, marker, ual: ka, timestamp: new Date(timestamp) });
    const b = make('recovered-B', 'B', Date.parse('2099-01-01T00:00:00Z'));
    const ack = make('storage-ack-equivalent-B', 'B', 50_000);
    const served = { ...b, meta: [...b.meta, ...ack.meta.filter(row => row.subject === ack.operationSubject || row.predicate === `${DKG}shareOperationId`)] };
    if (mode === 'pre-upgrade') await store.insert([...served.meta, ...inGraph(b)]);
    else await harness(store, served)[lane]();
    const readHead = () => resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: ka });
    expect((await readHead())?.operationAliases.every(alias => alias.publisherChronologyAuthenticated === false)).toBe(true);
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), { readConfirmedKnowledgeAssetVersion: async () => 0n });
    const signed = async (fixture: ReturnType<typeof make>, timestampMs: number) => {
      const payload = encodeRootlessWorkspaceRequest({ contextGraphId: CG, shareOperationId: fixture.operationId,
        publisherPeerId: 'peer-source', kaUal: ka, agentAddress: wallet.address, kaNumber: '3', assertionVersion: '1', timestampMs,
        nquads: new TextEncoder().encode(fixture.payload.map(row => `<${row.subject}> <${row.predicate}> ${row.object} <did:dkg:context-graph:${CG}> .`).join('\n')) });
      const timestamp = new Date().toISOString();
      const signature = await wallet.signMessage(computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, CG, timestamp, payload));
      const envelope = encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION, type: GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId: CG,
        agentAddress: wallet.address, timestamp, signature: ethers.getBytes(signature), payload });
      expect(await handler.verifyHostModeEnvelopeAuthority(envelope, CG, 'peer-source', { resolveOpenPublishPolicy: async () => ({ accessPolicy: 0, publishPolicy: 1 }) })).toMatchObject({ accepted: true });
      return handler.handle(envelope, 'peer-source', undefined, { trustedReplay: true });
    };
    expect(await signed(b, 2000)).toMatchObject({ applied: true });
    const authenticated = await readHead();
    expect(authenticated?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual([b.operationId, ack.operationId].sort());
    expect(authenticated?.operationAliases.find(alias => alias.shareOperationId === b.operationId))
      .toMatchObject({ publishedAt: '2000' });
    expect(authenticated?.operationAliases.find(alias => alias.shareOperationId === b.operationId)?.publisherChronologyAuthenticated).toBe(true);
    // An older exact replay cannot replace the newly authenticated clock.
    expect(await signed(b, 1000)).toMatchObject({ applied: true });
    expect((await readHead())?.operationAliases.find(alias => alias.shareOperationId === b.operationId)?.publishedAt).toBe('2000');
    const c = make('replacement-C', 'C', 3000);
    expect(await signed(c, 3000)).toMatchObject({ applied: true });
    expect(await signed(b, 2000)).toMatchObject({ applied: false, reason: expect.stringContaining('STALE_KA_SHARE_OPERATION') });
    expect((await readHead())?.shareOperationId).toBe(c.operationId);
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => ['cold', 'equivalent', 'same-id', 'pre-upgrade'].map(mode => ({ lane, mode }))))('$lane does not let $mode recovered 2099 metadata fence a later signed publisher share', async ({ lane, mode }) => {
    const store = new OxigraphStore(); stores.push(store);
    const wallet = ethers.Wallet.createRandom();
    const ka = `did:dkg:31337/${wallet.address.toLowerCase()}/3`;
    const make = (id: string, timestamp: number) => swmFixtures(CG).share({ version: 1, operationId: id, marker: 'same-bytes', ual: ka, timestamp: new Date(timestamp) });
    const local = make('local-publisher', 2000);
    const forged = make(mode === 'same-id' ? local.operationId : 'forged-peer-alias', Date.parse('2099-01-01T00:00:00Z'));
    // A provider copying the peer id and content cannot attest the clock, even
    // when it omits the locally imposed provenance flag or spoofs a false one.
    forged.meta.push({ subject: forged.operationSubject, predicate: `${DKG}recoveredOperationChronology`, object: '"false"', graph: forged.meta[0]!.graph });
    if (mode === 'pre-upgrade') await store.insert([...forged.meta.filter(row => row.predicate !== `${DKG}recoveredOperationChronology`), ...inGraph(forged)]);
    if (!['cold', 'pre-upgrade'].includes(mode)) { await persistLocalSwmOperation(store, CG, local); await store.insert([...local.meta, ...local.payload.map(row => ({ ...row, graph: local.assertionGraph }))]); }
    await harness(store, forged)[lane]();
    // Repeated transport acquisition must not upgrade the unsigned operation,
    // erase the imposed marker, or downgrade an authenticated local operation.
    await harness(store, forged)[lane]();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: ka });
    if (['cold', 'pre-upgrade'].includes(mode)) expect(head?.operationAliases.every(alias => alias.publisherChronologyAuthenticated === false)).toBe(true);
    else expect(head?.operationAliases.map(alias => alias.shareOperationId)).toEqual([local.operationId]);
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {});
    const payload = encodeRootlessWorkspaceRequest({ contextGraphId: CG, shareOperationId: 'signed-forward-share', publisherPeerId: 'peer-source', kaUal: ka, agentAddress: wallet.address, kaNumber: '3', assertionVersion: '2', timestampMs: Date.now(), nquads: new TextEncoder().encode(`<urn:later:signed> <urn:title> "legitimate" <did:dkg:context-graph:${CG}> .`) });
    const timestamp = new Date().toISOString();
    const signature = await wallet.signMessage(computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, CG, timestamp, payload));
    const envelope = encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION, type: GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId: CG, agentAddress: wallet.address, timestamp, signature: ethers.getBytes(signature), payload });
    expect(await handler.verifyHostModeEnvelopeAuthority(envelope, CG, 'peer-source', { resolveOpenPublishPolicy: async () => ({ accessPolicy: 0, publishPolicy: 1 }) })).toMatchObject({ accepted: true });
    expect(await handler.handle(envelope, 'peer-source', undefined, { trustedReplay: true })).toMatchObject({ applied: true });
    expect((await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: ka }))?.assertionVersion).toBe('2');
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => ['clock-and-marker', 'partial-orphan'].map(mode => ({ lane, mode }))))('$lane preserves trusted chronology against $mode provider metadata outside its selected alias', async ({ lane, mode }) => {
    const store = new OxigraphStore(); stores.push(store);
    const local = share(1, 'trusted-B', 2000);
    await persistLocalSwmOperation(store, CG, local);
    await store.insert([...local.meta, ...inGraph(local)]);
    const provider = share(1, 'unsigned-P', Date.parse('2099-01-01T00:00:00Z'));
    const ack = share(1, 'storage-ack-Q', Date.parse('2100-01-01T00:00:00Z'));
    for (const candidate of [provider, ack]) { candidate.payload = local.payload; candidate.digest = local.digest; candidate.meta = candidate.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` || row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(local.digest) } : row); }
    const forged = local.meta.filter(row => row.subject === local.operationSubject).map(row => row.predicate === `${DKG}publishedAt` ? { ...row, object: `"2099-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>` } : row);
    forged.push({ subject: local.operationSubject, predicate: `${DKG}recoveredOperationChronology`, object: '"false"', graph: local.meta[0]!.graph });
    const served = { ...provider, meta: [...provider.meta, ...ack.meta.filter(row => row.subject === ack.operationSubject || row.predicate === `${DKG}shareOperationId`), ...forged.filter(row => mode !== 'partial-orphan' || row.predicate === `${DKG}publishedAt`)] };
    if (mode === 'clock-and-marker') served.meta.push({ subject: local.headSubject, predicate: `${DKG}shareOperationId`, object: JSON.stringify(local.operationId), graph: local.meta[0]!.graph });
    for (let round = 0; round < 2; round++) await harness(store, served)[lane]();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId)).toEqual([local.operationId]);
    expect(head?.operationAliases[0].publisherChronologyAuthenticated).not.toBe(false);
    expect(head?.operationAliases[0].publishedAt).toBe('2000');
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => [false, true].flatMap(trusted => ['private', 'access', 'version'].map(change => ({ lane, trusted, change })))))('$lane refuses same-ID $change mutation (local authenticated=$trusted)', async ({ lane, trusted, change }) => {
    const store = new OxigraphStore(); stores.push(store);
    const make = (version: number, privateByte: number) => swmFixtures(CG).share({ version, operationId: 'same-immutable-id', marker: 'same-public', ual: UAL, privateTripleCount: 1, privateMerkleRoot: new Uint8Array(32).fill(privateByte) });
    const local = make(2, 0xbb);
    if (trusted) await persistLocalSwmOperation(store, CG, local);
    else local.meta.push({ subject: local.operationSubject, predicate: `${DKG}recoveredOperationChronology`, object: '"true"', graph: local.meta[0]!.graph });
    await store.insert([...local.meta, ...inGraph(local)]);
    const remote = make(change === 'version' ? 1 : 2, change === 'private' ? 0xaa : 0xbb);
    if (change === 'access') remote.meta = [...remote.meta.filter(row => row.predicate !== `${DKG}accessPolicy`), { subject: remote.operationSubject, predicate: `${DKG}accessPolicy`, object: '"allowList"', graph: remote.meta[0]!.graph }, { subject: remote.operationSubject, predicate: `${DKG}allowedPeer`, object: '"foreign-peer"', graph: remote.meta[0]!.graph }];
    const h = harness(store, remote);
    await h.materializer.isGraphAssetMaterialized(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: remote.meta })[0]!);
    const before = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    try { await h[lane](); } catch (error) { expect(error).toMatchObject({ code: 'RECOVERED_OPERATION_EVIDENCE_CONFLICT' }); }
    expect(await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }')).toEqual(before);
    expect(h.companion).not.toHaveBeenCalled();
    expect((await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL }))?.assertionVersion).toBe('2');
  });

  it.each(staleCases)('$lane keeps newer v$currentVersion over abandoned v$oldVersion ($scope, graph locator=$graphLocator)', async ({ lane, oldVersion, currentVersion, subGraph, graphLocator }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(oldVersion, 'abandoned', 1000, subGraph, graphLocator);
    const current = share(currentVersion, 'replacement', 2000, subGraph, graphLocator);
    await persistLocalSwmOperation(store, CG, current);
    await store.insert([...inGraph(current), ...current.meta]);
    await persistLocalSwmOperation(store, CG, old);
    const h = harness(store, old, async () => currentVersion === 1 ? 0n : 1n);
    const replace = vi.spyOn(store, 'replaceGraph');
    await h[lane]();
    await expectHead(store, current, subGraph);
    expect(replace).not.toHaveBeenCalled();
    expect(h.companion).not.toHaveBeenCalled();
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => ([[1, 1], [4, 2]] as const).map(([oldVersion, currentVersion]) => ({ lane, oldVersion, currentVersion }))))('$lane adopts later v$currentVersion over unpublished v$oldVersion', async ({ lane, oldVersion, currentVersion }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(oldVersion, 'abandoned', 1000);
    const current = share(currentVersion, 'replacement', 2000);
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    await persistLocalSwmOperation(store, CG, current);
    const h = harness(store, current, async () => currentVersion === 1 ? 0n : 1n);
    await h[lane]();
    await expectHead(store, current);
    expect(h.companion).toHaveBeenCalled();
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => ([[1, 1], [4, 2]] as const).map(([oldVersion, nextVersion]) => ({ lane, oldVersion, nextVersion }))))('$lane refuses unsigned later v$nextVersion over established v$oldVersion', async ({ lane, oldVersion, nextVersion }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(oldVersion, 'local-draft', 1000);
    const unsigned = share(nextVersion, 'unsigned-provider-draft', 2000);
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    const h = harness(store, unsigned, async () => 0n);
    await h[lane]();
    await expectHead(store, old);
    expect(h.companion).not.toHaveBeenCalled();
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => [null, 2n, 4n].map(confirmed => ({ lane, confirmed }))))('$lane refuses later reuse with confirmed proof $confirmed', async ({ lane, confirmed }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(4, 'abandoned', 1000);
    const incoming = share(2, 'replacement', 2000);
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    await persistLocalSwmOperation(store, CG, incoming);
    const readConfirmed = vi.fn(async () => confirmed);
    const h = harness(store, incoming, readConfirmed);
    await h[lane]();
    expect(readConfirmed).toHaveBeenCalledWith(UAL);
    await expectHead(store, old);
    expect(h.companion).not.toHaveBeenCalled();
    const positive = harness(store, incoming, async () => 1n);
    await positive[lane]();
    await expectHead(store, incoming);
    expect(positive.companion).toHaveBeenCalled();
  });

  it.each(['publicRun', 'privateRun'] as const)('%s keeps publisher chronology across ACK alias recovery and restart', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(1, 'abandoned', 1000);
    const current = share(1, 'publisher-replacement', 2000);
    const ack = share(1, 'storage-ack-replacement', 50000);
    // The ACK copy has exactly the publisher's assertion bytes, not its clock.
    ack.meta = ack.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` ? { ...row, object: JSON.stringify(current.digest) } : row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(current.digest) } : row);
    const served = { ...current, meta: [...current.meta, ...ack.meta.filter(row => row.subject === ack.operationSubject || row.predicate === `${DKG}shareOperationId`)] };
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    await persistLocalSwmOperation(store, CG, current);
    await harness(store, served)[lane]();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(['publisher-replacement', 'storage-ack-replacement']);
    await harness(store, old)[lane]();
    await expectHead(store, { ...current, operationId: ack.operationId });
    // Retaining the publisher proof must also permit a later replacement;
    // merely rejecting every draft after an ACK would pass the stale control.
    const next = share(1, 'next-publisher-replacement', 3000);
    await persistLocalSwmOperation(store, CG, next);
    await harness(store, next)[lane]();
    await expectHead(store, next);
  });


  it.each(['publicRun', 'privateRun'] as const)('%s backfills publisher chronology while retaining an equivalent ACK identity', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const ack = share(1, 'storage-ack-existing-copy', 50000);
    const publisher = share(1, 'publisher-existing-copy', 2000);
    // One validated alias class: bytes and publisher identity are identical.
    publisher.digest = ack.digest; publisher.payload = ack.payload;
    publisher.meta = publisher.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` || row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(ack.digest) } : row);
    await store.insert([...inGraph(ack), ...ack.meta]);
    await persistLocalSwmOperation(store, CG, publisher);
    await harness(store, publisher)[lane]();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(['publisher-existing-copy', 'storage-ack-existing-copy']);
    await harness(store, share(1, 'abandoned-publisher', 1000))[lane]();
    await expectHead(store, ack);
    const next = share(1, 'later-publisher', 3000);
    await persistLocalSwmOperation(store, CG, next);
    await harness(store, next)[lane]();
    await expectHead(store, next);
  });


  it.each(['publicRun', 'privateRun'] as const)('%s retains the latest equivalent publisher operation clock across restart', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(1, 'first-publisher-copy', 1000);
    const current = share(1, 'latest-equivalent-publisher-copy', 3000);
    current.digest = old.digest; current.payload = old.payload;
    current.meta = current.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` || row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(old.digest) } : row);
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    await persistLocalSwmOperation(store, CG, current);
    await harness(store, current)[lane]();
    await expectHead(store, current);
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(['first-publisher-copy', 'latest-equivalent-publisher-copy']);
    // An older equivalent peer must not discard the retained latest clock.
    await harness(store, old)[lane]();
    await expectHead(store, current);
    await harness(store, share(1, 'intermediate-abandoned-publisher', 2000))[lane]();
    await expectHead(store, current);
  });

  it.each(['publicRun', 'privateRun'] as const)('%s recognizes a recovered private-only ACK and publisher alias class as materialized', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const publisher = share(1, 'private-only-publisher', 2000, undefined, false, true);
    const ack = share(1, 'storage-ack-private-only', 50000, undefined, false, true);
    const served = { ...publisher, meta: [...publisher.meta, ...ack.meta.filter(row => row.subject === ack.operationSubject || row.predicate === `${DKG}shareOperationId`)] };
    const h = harness(store, served);
    await h[lane]();
    const recoveredMeta = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${served.meta[0]!.graph}> { ?s ?p ?o } }`);
    expect(recoveredMeta.type).toBe('quads');
    if (recoveredMeta.type !== 'quads') throw new Error('missing recovered metadata');
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: recoveredMeta.quads.map(row => ({ ...row, graph: served.meta[0]!.graph })) })[0]!;
    expect(descriptor).toBeDefined();
    expect(await h.materializer.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await h.materializer.readStoredHead(descriptor)).toMatchObject({ status: 'resolved' });
    const repair = vi.spyOn(h.materializer, 'repairHeadPreservingIdentity');
    await h[lane]();
    expect(repair).not.toHaveBeenCalled();
    const restarted = harness(store, served).materializer;
    expect(await restarted.readStoredHead(descriptor)).toMatchObject({ status: 'resolved' });
    expect(await restarted.isGraphAssetMaterialized(descriptor)).toBe(true);
    await expectHead(store, { ...publisher, operationId: ack.operationId });
  });

  it.each(['publicRun', 'privateRun'] as const)('%s never bulk-replays a committed head after live gossip advances it', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(1, 'older-catchup', 1000);
    const current = share(1, 'live-replacement', 2000);
    const h = harness(store, old);
    const original = h.materializer.withKaWriteLock.bind(h.materializer);
    let advanced = false;
    h.materializer.withKaWriteLock = async (cg, subGraph, kaUal, fn) => {
      const result = await original(cg, subGraph, kaUal, fn);
      if (!advanced) {
        advanced = true;
        await withKeyedLocks(h.writeLocks, [swmKaWriteLockKey(cg, subGraph, kaUal)], async () => {
          await store.replaceGraph(current.assertionGraph, inGraph(current));
          await store.dropGraph(current.meta[0]!.graph);
          await store.insert(current.meta);
        });
      }
      return result;
    };
    await h[lane]();
    expect(advanced).toBe(true);
    await expectHead(store, current);
  });

  it.each(['publicRun', 'privateRun'] as const)('%s re-reads chronology after waiting behind the live KA lock', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(4, 'queued-abandoned', 1000);
    const current = share(2, 'live-replacement', 2000);
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    const h = harness(store, old, async () => 1n);
    let unlock!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const held = withKeyedLocks(h.writeLocks, [swmKaWriteLockKey(CG, undefined, UAL)], () => release);
    let lockRequested!: () => void;
    const requested = new Promise<void>(resolve => { lockRequested = resolve; });
    const original = h.materializer.withKaWriteLock.bind(h.materializer);
    h.materializer.withKaWriteLock = (cg, subGraph, kaUal, fn) => { lockRequested(); return original(cg, subGraph, kaUal, fn); };
    const running = h[lane]();
    await requested;
    // These real writes own the lock the queued catch-up is waiting for.
    await store.replaceGraph(current.assertionGraph, inGraph(current));
    await store.dropGraph(current.meta[0]!.graph);
    await store.insert(current.meta);
    unlock(); await held; await running;
    await expectHead(store, current);
    expect(h.companion).not.toHaveBeenCalled();
  });

  it.each(['publicRun', 'privateRun'] as const)('%s keeps a signed ACK copy until coherent unpublished expiry proof', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(1, 'owed-copy', 1000);
    const current = share(1, 'later-publisher', 2000);
    await persistLocalSwmOperation(store, CG, old);
    await store.insert([...inGraph(old), ...old.meta]);
    const ledger = { namespace: CG, metaGraph: old.meta[0]!.graph, contextGraphId: '42', kaUal: UAL, assertionVersion: '1', operation: 'publish' as const, operationSubject: workspaceOperationSubject(CG, old.operationId) };
    await store.insert(storageAckLedgerEntryQuads({ ...ledger, signedAt: new Date() }));
    await persistLocalSwmOperation(store, CG, current);
    await harness(store, current)[lane]();
    await expectHead(store, old);
    await store.dropGraph('urn:dkg:node:storage-ack-ledger');
    await store.insert(storageAckLedgerEntryQuads({ ...ledger, signedAt: new Date(Date.now() - 300_001) }));
    await persistLocalSwmOperation(store, CG, current);
    await harness(store, current)[lane]();
    await expectHead(store, current);
  });

  it.each(['publicRun', 'privateRun'] as const)('%s refuses different content when only receiver-clock chronology survives', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const current = share(2, 'storage-ack-only-copy', 50000);
    const incoming = share(4, 'abandoned-publisher', 1000);
    await persistLocalSwmOperation(store, CG, current);
    await store.insert([...inGraph(current), ...current.meta]);
    await harness(store, incoming, async () => 1n)[lane]();
    await expectHead(store, current);
  });
});


describe('prepared recovery rechecks unpublished evidence after snapshot loading', () => {
  it.each(([false, true] as const).flatMap(advance => [undefined, 'team'].map(subGraph => ({ advance, subGraph, scope: subGraph ?? 'root' }))))('withholds every $scope effect when confirmation advances=$advance during the gated load', async ({ advance, subGraph }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(4, 'stored-draft-4', 2000, subGraph);
    const incoming = share(2, 'authenticated-draft-2', 3000, subGraph);
    await persistLocalSwmOperation(store, CG, old); await persistLocalSwmOperation(store, CG, incoming);
    await store.insert([...old.meta, ...inGraph(old)]);
    let confirmed = 1n;
    const readConfirmed = vi.fn(async () => confirmed);
    const h = harness(store, incoming, readConfirmed);
    const descriptor = parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: CG, metaQuads: incoming.meta, registeredSubGraphNames: ['team'] })[0]!;
    const initial = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${old.meta[0]!.graph}> { ?s ?p ?o } }`);
    const replaceGraph = vi.spyOn(store, 'replaceGraph');
    const insert = vi.spyOn(store, 'insert');
    const deleteRows = vi.spyOn(store, 'deleteByPattern');
    const prepareCompanion = vi.fn(() => ({ graphUri: 'urn:test:boundary', subject: 'urn:test:boundary:head', quads: [{ subject: 'urn:test:boundary:head', predicate: 'urn:test:operation', object: '"loaded"', graph: 'urn:test:boundary' }] }));
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loadVerifiedQuads = vi.fn(async () => { entered(); await gate; return inGraph(incoming); });
    const running = commitRecoveredSwmAsset({ contextGraphId: CG, asset: { kind: 'replace', descriptor, loadVerifiedQuads },
      materializer: h.materializer, insertMetadata: rows => store.insert([...rows]), resolveRootAtomicCompanion: prepareCompanion });
    await ready;
    expect(readConfirmed).toHaveBeenCalledTimes(1); expect(loadVerifiedQuads).toHaveBeenCalledOnce();
    if (advance) confirmed = 2n;
    release();
    const result = await running;
    if (advance) {
      expect(result).toEqual({ kind: 'superseded', insertedGraphQuads: 0, insertedMetaQuads: 0, withholdRows: descriptor.metadataQuads });
      expect(replaceGraph).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(deleteRows).not.toHaveBeenCalled();
      expect(prepareCompanion).not.toHaveBeenCalled();
      await expectHead(store, old, subGraph);
      expect(await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${old.meta[0]!.graph}> { ?s ?p ?o } }`)).toEqual(initial);
    } else {
      expect(result.kind).toBe('committed'); await expectHead(store, incoming, subGraph);
      expect(prepareCompanion).toHaveBeenCalledTimes(subGraph === undefined ? 1 : 0);
    }
    expect(readConfirmed).toHaveBeenCalledTimes(2);
  });
});
