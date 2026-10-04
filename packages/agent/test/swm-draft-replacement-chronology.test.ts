// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { workspaceKnowledgeAssetOperationSnapshotGraph, type OperationContext } from '@origintrail-official/dkg-core';
import { resolveKnowledgeAssetWorkspaceHead, withKeyedLocks, swmKaWriteLockKey, storageAckLedgerEntryQuads, workspaceOperationSubject } from '@origintrail-official/dkg-publisher';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { recoverContextGraphSwm } from '../src/sync/requester/swm-recovery.js';
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
  const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks, invalidateListContextGraphsCache: () => {}, readConfirmedKnowledgeAssetVersion: readConfirmed });
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
  const privateRun = () => recoverContextGraphSwm({ ...common, contextGraphId: CG, deadline: Number.MAX_SAFE_INTEGER, store, writeLocks, replaceMetaForRoots: async () => {}, replaceMetaForGraphAssets: assets => materializer.replaceMetaForGraphAssets(assets), resolveRootAtomicCompanion: companion });
  return { publicRun, privateRun, companion, materializer, writeLocks };
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
  it.each(staleCases)('$lane keeps newer v$currentVersion over abandoned v$oldVersion ($scope, graph locator=$graphLocator)', async ({ lane, oldVersion, currentVersion, subGraph, graphLocator }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(oldVersion, 'abandoned', 1000, subGraph, graphLocator);
    const current = share(currentVersion, 'replacement', 2000, subGraph, graphLocator);
    await store.insert([...inGraph(current), ...current.meta]);
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
    await store.insert([...inGraph(old), ...old.meta]);
    const h = harness(store, current, async () => currentVersion === 1 ? 0n : 1n);
    await h[lane]();
    await expectHead(store, current);
    expect(h.companion).toHaveBeenCalled();
  });

  it.each((['publicRun', 'privateRun'] as const).flatMap(lane => [null, 2n, 4n].map(confirmed => ({ lane, confirmed }))))('$lane refuses later reuse with confirmed proof $confirmed', async ({ lane, confirmed }) => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(4, 'abandoned', 1000);
    const incoming = share(2, 'replacement', 2000);
    await store.insert([...inGraph(old), ...old.meta]);
    const h = harness(store, incoming, async () => confirmed);
    await h[lane]();
    await expectHead(store, old);
    expect(h.companion).not.toHaveBeenCalled();
  });

  it.each(['publicRun', 'privateRun'] as const)('%s keeps publisher chronology across ACK alias recovery and restart', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(1, 'abandoned', 1000);
    const current = share(1, 'publisher-replacement', 2000);
    const ack = share(1, 'storage-ack-replacement', 50000);
    // The ACK copy has exactly the publisher's assertion bytes, not its clock.
    ack.meta = ack.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` ? { ...row, object: JSON.stringify(current.digest) } : row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(current.digest) } : row);
    const served = { ...current, meta: [...current.meta, ...ack.meta.filter(row => row.subject === ack.operationSubject || row.predicate === `${DKG}shareOperationId`)] };
    await store.insert([...inGraph(old), ...old.meta]);
    await harness(store, served)[lane]();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(['publisher-replacement', 'storage-ack-replacement']);
    await harness(store, old)[lane]();
    await expectHead(store, { ...current, operationId: ack.operationId });
    // Retaining the publisher proof must also permit a later replacement;
    // merely rejecting every draft after an ACK would pass the stale control.
    const next = share(1, 'next-publisher-replacement', 3000);
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
    await harness(store, publisher)[lane]();
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(['publisher-existing-copy', 'storage-ack-existing-copy']);
    await harness(store, share(1, 'abandoned-publisher', 1000))[lane]();
    await expectHead(store, ack);
    const next = share(1, 'later-publisher', 3000);
    await harness(store, next)[lane]();
    await expectHead(store, next);
  });


  it.each(['publicRun', 'privateRun'] as const)('%s retains the latest equivalent publisher operation clock across restart', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const old = share(1, 'first-publisher-copy', 1000);
    const current = share(1, 'latest-equivalent-publisher-copy', 3000);
    current.digest = old.digest; current.payload = old.payload;
    current.meta = current.meta.map(row => row.predicate === `${DKG}publicQuadsDigest` || row.predicate === `${DKG}publicSnapshotRef` ? { ...row, object: JSON.stringify(old.digest) } : row);
    await store.insert([...inGraph(old), ...old.meta]);
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
    await store.insert([...inGraph(old), ...old.meta]);
    const ledger = { namespace: CG, metaGraph: old.meta[0]!.graph, contextGraphId: '42', kaUal: UAL, assertionVersion: '1', operation: 'publish' as const, operationSubject: workspaceOperationSubject(CG, old.operationId) };
    await store.insert(storageAckLedgerEntryQuads({ ...ledger, signedAt: new Date() }));
    await harness(store, current)[lane]();
    await expectHead(store, old);
    await store.dropGraph('urn:dkg:node:storage-ack-ledger');
    await store.insert(storageAckLedgerEntryQuads({ ...ledger, signedAt: new Date(Date.now() - 300_001) }));
    await harness(store, current)[lane]();
    await expectHead(store, current);
  });

  it.each(['publicRun', 'privateRun'] as const)('%s refuses different content when only receiver-clock chronology survives', async lane => {
    const store = new OxigraphStore(); stores.push(store);
    const current = share(2, 'storage-ack-only-copy', 50000);
    const incoming = share(4, 'abandoned-publisher', 1000);
    await store.insert([...inGraph(current), ...current.meta]);
    await harness(store, incoming, async () => 1n)[lane]();
    await expectHead(store, current);
  });
});
