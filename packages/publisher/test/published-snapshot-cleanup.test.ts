import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, Logger, TypedEventBus, createGraphKnowledgeAssetScope, createOperationContext,
  generateEd25519Keypair, assertionLifecycleUri, contextGraphMetaUri, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { computePrivateRootV10 } from '../src/index.js';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';
import { snapshotReferenceCheck } from '../src/workspace-snapshot-lifecycle.js';
import { PublishedSnapshotRetirement } from '../src/published-snapshot-retirement.js';
import { generateKnowledgeAssetShareMetadata } from '../src/metadata.js';
import { storageAckOperationId } from '../src/storage-ack-ledger.js';
import { swmKaWriteLockKey, withKeyedLocks } from '../src/keyed-lock.js';
import { storeKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';
import { makeQuads, snapshotPath } from './_helpers/workspace-snapshot-store.js';

const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CG = 'snapshot-cleanup';
const META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const DKG = 'http://dkg.io/ontology/';
const quads = makeQuads(2, 'published');
const digest = workspacePublicQuadsDigest(quads);
const cleanups: (() => Promise<void>)[] = [];
const version = (value: number | bigint) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(finalizedCleanupEnabled = true, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-published-snapshot-'));
  const store = new OxigraphStore();
  let now = 100_000;
  let free = 100 * 1024 ** 3;
  const opened: FileWorkspacePublicSnapshotStore[] = [];
  /** Another process over the same directory and RDF store, as after a daemon restart. */
  const open = () => {
    const opening = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: { enabled, finalizedCleanupEnabled, finalizedRetentionMs: 1_000 }, now: () => now,
      getAvailableBytes: async () => free,
      isSnapshotReferenced: snapshotReferenceCheck(store),
    });
    opening.stopGarbageCollection();
    opened.push(opening);
    return opening;
  };
  const snapshots = open();
  cleanups.push(async () => {
    for (const each of opened) each.stopGarbageCollection();
    await rm(directory, { recursive: true, force: true });
  });
  const publisher = new DKGPublisher({ store, publicSnapshotStore: snapshots,
    chain: new NoChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  const seed = async (number: number, payload = { quads, digest }, assertionVersion: number | bigint = 1) => {
    const { quads, digest } = payload;
    const ual = `did:dkg:base:8453/${AUTHOR}/${number}`;
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    const head = `${ual}#dkg-swm-head`;
    const operationId = `share-${number}`;
    const operation = `urn:dkg:share:${CG}:${operationId}`;
    const swm = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
    const vm = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
    await snapshots.putSnapshot({ digest, quads });
    await store.insert([
      ...quads.map(q => ({ ...q, graph: swm })), ...quads.map(q => ({ ...q, graph: vm })),
      { graph: META, subject: head, predicate: `${DKG}shareOperationId`, object: JSON.stringify(operationId) },
      { graph: META, subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
      { graph: META, subject: operation, predicate: `${DKG}shareOperationId`, object: JSON.stringify(operationId) },
      { graph: META, subject: operation, predicate: `${DKG}kaUal`, object: ual },
      { graph: META, subject: operation, predicate: `${DKG}assertionVersion`, object: version(assertionVersion) },
      { graph: META, subject: operation, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(digest) },
    ]);
    return { swm, vm, ual, digest, clear: () => publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      undefined, createOperationContext('test'), ual) };
  };
  /** One operation row set, in the shape the share/ACK writers persist it. */
  const operationRows = (subject: string, shareId: string, ual: string, assertionVersion: number | bigint, digest: string) => [
    { graph: META, subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
    { graph: META, subject, predicate: `${DKG}shareOperationId`, object: JSON.stringify(shareId) },
    { graph: META, subject, predicate: `${DKG}kaUal`, object: ual },
    { graph: META, subject, predicate: `${DKG}assertionVersion`, object: version(assertionVersion) },
    { graph: META, subject, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(digest) },
  ];
  return {
    store, snapshots, publisher, seed, operationRows, directory, open, path: snapshotPath(directory, digest), advance: () => { now += 1_001; },
    setFree: (bytes: number) => { free = bytes; },
  };
}

describe('published snapshot cleanup integration', () => {
  it.each([[false, true], [true, false]])('avoids discovery with feature=%s and master=%s', async (feature, master) => {
    const f = await fixture(feature, master);
    const asset = await f.seed(41);
    const query = vi.spyOn(f.store, 'query');
    await asset.clear();
    expect(query.mock.calls.some(([sparql]) => sparql.includes('SELECT DISTINCT ?ref'))).toBe(false);
    f.advance();
    expect((await f.snapshots.collectGarbage()).deletedSnapshots).toBe(0);
  });

  it('clears the SWM lifecycle, then removes only its unreferenced file after grace; VM stays intact', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await asset.clear();
    expect(await f.store.countQuads(asset.swm)).toBe(0);
    expect((await f.snapshots.collectGarbage()).deletedSnapshots).toBe(0);
    f.advance();
    expect((await f.snapshots.collectGarbage()).finalizedSnapshots).toBe(1);
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
  });

  it('does not remove a shared digest until the second operation finishes and gets its own grace', async () => {
    const f = await fixture();
    const first = await f.seed(41);
    const second = await f.seed(42);
    await first.clear();
    f.advance();
    expect((await f.snapshots.collectGarbage()).referencedSnapshots).toBe(1);
    await second.clear();
    expect((await f.snapshots.collectGarbage()).deletedSnapshots).toBe(0);
    f.advance();
    expect((await f.snapshots.collectGarbage()).finalizedSnapshots).toBe(1);
    expect(await f.store.countQuads(first.vm)).toBe(quads.length);
    expect(await f.store.countQuads(second.vm)).toBe(quads.length);
  });

  it('retains a crash/retry candidate while SWM cleanup still has references', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    vi.spyOn(f.store, 'dropGraph').mockRejectedValueOnce(new Error('store offline'));
    await expect(asset.clear()).rejects.toThrow('store offline');
    f.advance();
    expect((await f.snapshots.collectGarbage()).referencedSnapshots).toBe(1);
    await expect(stat(f.path)).resolves.toBeDefined();
    await asset.clear();
    f.advance();
    expect((await f.snapshots.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('does not turn a durable publish cleanup into an error when the retirement record cannot be saved', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    vi.spyOn(f.snapshots.lifecycle, 'markPublished').mockRejectedValueOnce(new Error('disk error'));
    await expect(asset.clear()).resolves.toBeUndefined();
    expect(await f.store.countQuads(asset.swm)).toBe(0);
    expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
    f.advance();
    expect((await f.snapshots.collectGarbage()).deletedSnapshots).toBe(0);
  });
});

describe('published snapshot cleanup: the publisher refuses a lifecycle that breaks the contract', () => {
  it('fails at construction for a cleanup-enabled lifecycle without operationLease, and not for the file store\'s own', async () => {
    const f = await fixture();
    const base = { store: f.store, chain: new NoChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() };
    const custom = (lifecycle: unknown): WorkspacePublicSnapshotStore => ({
      putSnapshot: async input => ({ ref: input.digest, byteLength: 1 }), getSnapshot: async () => null, lifecycle,
    } as WorkspacePublicSnapshotStore);
    const markPublished = async () => {};
    expect(() => new DKGPublisher({ ...base, publicSnapshotStore: custom({ finalizedCleanupEnabled: true, snapshotExists: async () => true, markPublished }) }))
      .toThrow(/^Invalid snapshot lifecycle\. It reports finalizedCleanupEnabled but offers no operationLease\(ref\)/);
    expect(() => new DKGPublisher({ ...base, publicSnapshotStore: custom({ finalizedCleanupEnabled: false, acquireExisting: async () => () => {}, markPublished }) }))
      .toThrow('It offers no snapshotExists(ref).');
    expect(() => new DKGPublisher({ ...base, publicSnapshotStore: f.snapshots })).not.toThrow();
    expect(() => new DKGPublisher({ ...base, publicSnapshotStore: custom(undefined) })).not.toThrow();
  });
});

describe('published snapshot cleanup: store queries', () => {
  it('reads the retirement candidates without handing the store an abort signal', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const query = vi.spyOn(f.store, 'query');
    await asset.clear();
    const lookup = query.mock.calls.find(([sparql]) => sparql.includes('SELECT DISTINCT ?ref'));
    expect(lookup).toBeDefined();
    // A caller-owned short signal can make a managed store restart itself.
    expect(lookup![1]).toBeUndefined();
  });

  it('bounds a stuck retirement lookup on the client side and still completes the cleanup', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const query = f.store.query.bind(f.store);
    vi.spyOn(f.store, 'query').mockImplementation((sparql, options) =>
      sparql.includes('SELECT DISTINCT ?ref') ? new Promise(() => {}) : query(sparql, options));
    vi.useFakeTimers();
    try {
      const clearing = asset.clear();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(clearing).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
    expect(await f.store.countQuads(asset.swm)).toBe(0);
    expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
    f.advance();
    expect((await f.snapshots.collectGarbage()).deletedSnapshots).toBe(0); // nothing was recorded
  });

  it('reports a lookup that fails or times out through the warning channel only', async () => {
    const f = await fixture();
    const warn = vi.fn();
    const stuck = { query: () => new Promise<never>(() => {}) } as unknown as OxigraphStore;
    const retirement = new PublishedSnapshotRetirement(stuck, f.snapshots.lifecycle);
    vi.useFakeTimers();
    try {
      const scheduling = retirement.schedule(META, ['urn:dkg:share:snapshot-cleanup:share-1'], warn);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await scheduling;
    } finally { vi.useRealTimers(); }
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not schedule finalized snapshot cleanup: Snapshot retirement lookup timed out');
  });
});

describe('published snapshot cleanup: pressure and restarts', () => {
  const twoAssets = (first: number, second: number) => [
    { number: first, payload: { quads: makeQuads(2, `asset-${first}`), digest: '' } },
    { number: second, payload: { quads: makeQuads(2, `asset-${second}`), digest: '' } },
  ].map(entry => ({ ...entry, payload: { ...entry.payload, digest: workspacePublicQuadsDigest(entry.payload.quads) } }));

  it('under hard pressure reclaims a just-retired file only when nothing references it', async () => {
    const f = await fixture();
    const [free, held] = twoAssets(51, 52);
    const freed = await f.seed(free.number, free.payload);
    const kept = await f.seed(held.number, held.payload);
    await f.store.insert([{ graph: 'urn:other-context:metadata', subject: 'urn:pending-operation',
      predicate: 'http://dkg.io/ontology/publicSnapshotRef', object: JSON.stringify(held.payload.digest) }]);
    await freed.clear();
    await kept.clear();
    f.setFree(1024 ** 3); // below the hard reserve, with the grace period still running
    expect(await f.snapshots.collectGarbage()).toMatchObject({
      triggered: true, finalizedSnapshots: 1, referencedSnapshots: 1, deletedSnapshots: 1,
    });
    await expect(stat(snapshotPath(f.directory, free.payload.digest))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(snapshotPath(f.directory, held.payload.digest))).resolves.toBeDefined();
    expect(await f.store.countQuads(freed.vm)).toBe(free.payload.quads.length);
    expect(await f.store.countQuads(kept.vm)).toBe(held.payload.quads.length);
  });

  it('carries a large backlog across a restart without re-scanning the candidates it kept', async () => {
    const f = await fixture();
    const assets = Array.from({ length: 33 }, (_, i) => {
      const payloadQuads = makeQuads(1, `backlog-${i}`);
      return { number: 100 + i, payload: { quads: payloadQuads, digest: workspacePublicQuadsDigest(payloadQuads) } };
    }).sort((a, b) => (a.payload.digest < b.payload.digest ? -1 : 1));
    for (const asset of assets) await (await f.seed(asset.number, asset.payload)).clear();
    // The 32 lowest digests stay referenced by another context graph; the last one is free.
    await f.store.insert(assets.slice(0, 32).map((asset, i) => ({ graph: 'urn:other-context:metadata',
      subject: `urn:pending-operation:${i}`, predicate: 'http://dkg.io/ontology/publicSnapshotRef',
      object: JSON.stringify(asset.payload.digest) })));
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 32, finalizedSnapshots: 0 });
    // A new process resumes after the last candidate it examined instead of starting over.
    const restarted = f.open();
    expect(await restarted.collectGarbage()).toMatchObject({ finalizedSnapshots: 1 });
    await expect(stat(snapshotPath(f.directory, assets[32]!.payload.digest))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(snapshotPath(f.directory, assets[0]!.payload.digest))).resolves.toBeDefined();
  });
});

describe('published snapshot cleanup: storage ACK copies of the published asset', () => {
  const ackSubject = (id: string) => `urn:dkg:share:${CG}:storage-ack-${id}`;
  /** The StorageACK cleanup is the one store update that names a copy's id prefix. */
  const isAckUpdate = (sparql: string) => sparql.includes('storage-ack-');
  const rowsOf = async (f: Awaited<ReturnType<typeof fixture>>, subject: string) => {
    const result = await f.store.query(`SELECT ?p WHERE { GRAPH <${META}> { <${subject}> ?p ?o } }`);
    return result.type === 'bindings' ? result.bindings.length : 0;
  };

  it('does not let the ACK copy of the same asset keep the file after the cleanup', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    await asset.clear();
    expect(await rowsOf(f, ackSubject('own'))).toBe(0);
    expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 0, finalizedSnapshots: 1 });
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('clears an ACK copy written by the real metadata generator, as the ACK persistence records it', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const copy = generateKnowledgeAssetShareMetadata({
      shareOperationId: storageAckOperationId(asset.ual, 1, new Uint8Array(32).fill(7)), contextGraphId: CG,
      kaUal: asset.ual, assertionVersion: 1, publicTripleCount: quads.length, privateTripleCount: 0,
      publisherPeerId: 'peer-publisher', timestamp: new Date(0),
    }, META);
    copy.push({ subject: copy[0]!.subject, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(digest), graph: META });
    await f.store.insert(copy);
    expect(await rowsOf(f, copy[0]!.subject)).toBeGreaterThan(5);
    await asset.clear();
    expect(await rowsOf(f, copy[0]!.subject)).toBe(0);
    f.advance();
    expect((await f.snapshots.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it.each([
    ['a later version of the same asset', (f: Awaited<ReturnType<typeof fixture>>, ual: string) =>
      f.operationRows(ackSubject('later'), 'storage-ack-later', ual, 2, digest)],
    ['an ACK copy of another asset', (f: Awaited<ReturnType<typeof fixture>>) =>
      f.operationRows(ackSubject('other'), 'storage-ack-other', `did:dkg:base:8453/${AUTHOR}/99`, 1, digest)],
    ['an operation that is not an ACK copy', (f: Awaited<ReturnType<typeof fixture>>, ual: string) =>
      f.operationRows(ackSubject('plain'), 'share-plain', ual, 1, digest)],
  ])('keeps counting %s as a reference', async (_label, rows) => {
    const f = await fixture();
    const asset = await f.seed(41);
    const kept = rows(f, asset.ual);
    await f.store.insert(kept);
    await asset.clear();
    expect(await rowsOf(f, kept[0]!.subject)).toBe(kept.length);
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 1, deletedSnapshots: 0 });
    await expect(stat(f.path)).resolves.toBeDefined();
  });

  it('leaves the ACK copy alone, and issues no ACK update, when finalized cleanup is off', async () => {
    const f = await fixture(false);
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const update = vi.spyOn(f.store, 'update');
    await asset.clear();
    expect(await rowsOf(f, ackSubject('own'))).toBe(5);
    expect(update.mock.calls.some(([sparql]) => isAckUpdate(sparql))).toBe(false);
  });

  it('reports a failed update once through the warning channel and leaves every copy in place', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const warn = vi.fn();
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    for (const id of ['one', 'two']) await f.store.insert(f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest));
    vi.spyOn(f.store, 'update').mockRejectedValueOnce(new Error('disk full'));
    await expect(retirement.clearStorageAckCopies(META, asset.ual, ['urn:dkg:share:snapshot-cleanup:share-41'], warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not clear storage ACK copy metadata after publication: disk full');
    // The mutation failed as a whole: no prefix of the copies was applied.
    expect(await rowsOf(f, ackSubject('one'))).toBe(5);
    expect(await rowsOf(f, ackSubject('two'))).toBe(5);
  });

  it('removes the discharged set with one store mutation', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const ids = ['a', 'b', 'c'];
    for (const id of ids) await f.store.insert(f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest));
    const touchesAck = (arg: unknown) => JSON.stringify(arg).includes('storage-ack-');
    const update = vi.spyOn(f.store, 'update');
    const deleteByPattern = vi.spyOn(f.store, 'deleteByPattern');
    const deleteWithoutCount = vi.spyOn(f.store, 'deleteByPatternWithoutCount');
    const remove = vi.spyOn(f.store, 'delete');
    await asset.clear();
    const ackUpdates = update.mock.calls.filter(([sparql]) => touchesAck(sparql));
    expect(ackUpdates).toHaveLength(1);
    expect(ackUpdates[0]![1]).toMatchObject({ touchedGraphs: [META] });
    // No per-subject mutation for any copy.
    expect([...deleteByPattern.mock.calls, ...deleteWithoutCount.mock.calls, ...remove.mock.calls]
      .filter(([arg]) => touchesAck(arg))).toEqual([]);
    for (const id of ids) expect(await rowsOf(f, ackSubject(id))).toBe(0);
  });

  it('keeps the cleaned operations themselves even when their share id carries the copy prefix', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const warn = vi.fn();
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    await f.store.insert([
      ...f.operationRows(ackSubject('cleaned'), 'storage-ack-cleaned', asset.ual, 2, digest),
      ...f.operationRows(ackSubject('sibling'), 'storage-ack-sibling', asset.ual, 1, digest),
      ...f.operationRows(ackSubject('later'), 'storage-ack-later', asset.ual, 3, digest),
    ]);
    await retirement.clearStorageAckCopies(META, asset.ual, [ackSubject('cleaned')], warn);
    expect(await rowsOf(f, ackSubject('cleaned'))).toBe(5);
    expect(await rowsOf(f, ackSubject('sibling'))).toBe(0);
    expect(await rowsOf(f, ackSubject('later'))).toBe(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the copies and the file, and finishes the rest of the cleanup, when the update fails', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    for (const id of ['a', 'b']) await f.store.insert(f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest));
    const update = f.store.update!.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation((sparql, options) =>
      isAckUpdate(sparql) ? Promise.reject(new Error('store offline')) : update(sparql, options));
    await expect(asset.clear()).resolves.toBeUndefined();
    expect(await f.store.countQuads(asset.swm)).toBe(0);
    expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
    for (const id of ['a', 'b']) expect(await rowsOf(f, ackSubject(id))).toBe(5);
    f.advance();
    expect((await f.snapshots.collectGarbage()).referencedSnapshots).toBe(1);
    await expect(stat(f.path)).resolves.toBeDefined();
  });

  it('applies nothing when one cleaned operation cannot be written into the update', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('one'), 'storage-ack-one', asset.ual, 1, digest));
    const warn = vi.fn();
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    const update = vi.spyOn(f.store, 'update');
    await retirement.clearStorageAckCopies(META, asset.ual, ['urn:dkg:share:snapshot-cleanup:share-41', 'not an iri'], warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(await rowsOf(f, ackSubject('one'))).toBe(5);
  });

  it('keeps the copies and reports it when the store cannot run an update', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('one'), 'storage-ack-one', asset.ual, 1, digest));
    const warn = vi.fn();
    const withoutUpdate = { query: f.store.query.bind(f.store) } as unknown as OxigraphStore;
    const retirement = new PublishedSnapshotRetirement(withoutUpdate, f.snapshots.lifecycle);
    await retirement.clearStorageAckCopies(META, asset.ual, ['urn:dkg:share:snapshot-cleanup:share-41'], warn);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Could not clear storage ACK copy metadata after publication: the triple store cannot run an update for the StorageACK copy cleanup');
    expect(await rowsOf(f, ackSubject('one'))).toBe(5);
  });

  it('removes nothing without a cleaned operation to take the version from, and warns about nothing', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    const warn = vi.fn();
    const update = vi.spyOn(f.store, 'update');
    await retirement.clearStorageAckCopies(META, asset.ual, [], warn);
    expect(update).not.toHaveBeenCalled();
    // An operation id that is not in the graph gives no version either.
    await retirement.clearStorageAckCopies(META, asset.ual, ['urn:dkg:share:unknown'], warn);
    expect(await rowsOf(f, ackSubject('own'))).toBe(5);
    expect(warn).not.toHaveBeenCalled();
  });

  describe('with more copies than any one lookup would return', () => {
    it.each([130, 700])('removes every discharged copy of %s and only those', async COPIES => {
      const f = await fixture();
      const asset = await f.seed(41);
      const ids = Array.from({ length: COPIES }, (_, i) => `copy-${String(i).padStart(3, '0')}`);
      await f.store.insert(ids.flatMap(id => f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest)));
      const kept = [
        f.operationRows(ackSubject('later'), 'storage-ack-later', asset.ual, 2, digest),
        f.operationRows(ackSubject('other'), 'storage-ack-other', `did:dkg:base:8453/${AUTHOR}/99`, 1, digest),
        f.operationRows(ackSubject('plain'), 'share-plain', asset.ual, 1, digest),
      ];
      await f.store.insert(kept.flat());
      const update = vi.spyOn(f.store, 'update');
      await asset.clear();
      expect(update.mock.calls.filter(([sparql]) => isAckUpdate(sparql))).toHaveLength(1);
      for (const id of ids) expect(await rowsOf(f, ackSubject(id)), id).toBe(0);
      for (const rows of kept) expect(await rowsOf(f, rows[0]!.subject)).toBe(rows.length);
      expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
      // The three rows that stay still reference the file.
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 1, deletedSnapshots: 0 });
    });

    it('lets the file go once nothing else references it', async () => {
      const f = await fixture();
      const asset = await f.seed(41);
      const ids = Array.from({ length: 130 }, (_, i) => `copy-${String(i).padStart(3, '0')}`);
      await f.store.insert(ids.flatMap(id => f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest)));
      await asset.clear();
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 0, finalizedSnapshots: 1 });
      await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('with an assertion version beyond a double\'s exact integers', () => {
    const TWO_53 = 9007199254740992n;
    const copiesAt = (f: Awaited<ReturnType<typeof fixture>>, ual: string, versions: bigint[]) =>
      f.store.insert(versions.flatMap((v, i) => f.operationRows(ackSubject(`v${i}`), `storage-ack-v${i}`, ual, v, digest)));

    it('removes the lower-version copies of an asset at version 2^53 + 1 and keeps the later one', async () => {
      const f = await fixture();
      const asset = await f.seed(41, undefined, TWO_53 + 1n);
      await copiesAt(f, asset.ual, [1n, TWO_53, TWO_53 + 1n, TWO_53 + 2n]);
      await asset.clear();
      expect(await Promise.all([0, 1, 2, 3].map(i => rowsOf(f, ackSubject(`v${i}`))))).toEqual([0, 0, 0, 5]);
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 1, deletedSnapshots: 0 });
    });

    it('keeps the copy one above a 2^53 boundary, which a double cannot tell apart', async () => {
      const f = await fixture();
      const asset = await f.seed(41, undefined, TWO_53);
      await copiesAt(f, asset.ual, [1n, TWO_53, TWO_53 + 1n]);
      await asset.clear();
      expect(await Promise.all([0, 1, 2].map(i => rowsOf(f, ackSubject(`v${i}`))))).toEqual([0, 0, 5]);
    });

    it('lets the file go when every copy is at or below the version being cleaned up', async () => {
      const f = await fixture();
      const asset = await f.seed(41, undefined, TWO_53 + 1n);
      await copiesAt(f, asset.ual, [1n, TWO_53 - 1n, TWO_53, TWO_53 + 1n]);
      await asset.clear();
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 0, finalizedSnapshots: 1 });
    });
  });

  it('bounds a stuck ACK copy update on the client side, without a signal, and warns once', async () => {
    const f = await fixture();
    const warn = vi.fn();
    const update = vi.fn(() => new Promise<never>(() => {}));
    const stuck = { query: f.store.query.bind(f.store), update } as unknown as OxigraphStore;
    const retirement = new PublishedSnapshotRetirement(stuck, f.snapshots.lifecycle);
    vi.useFakeTimers();
    try {
      let settled = false;
      const clearing = retirement.clearStorageAckCopies(META, 'did:dkg:base:8453/0xabc/1', ['urn:dkg:share:x'], warn).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await clearing;
    } finally { vi.useRealTimers(); }
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Could not clear storage ACK copy metadata after publication: Storage ACK copy cleanup timed out');
    // The bound is applied by the caller: the store is handed no abort signal.
    expect(update).toHaveBeenCalledOnce();
    expect((update.mock.calls[0] as unknown[])[1]).not.toHaveProperty('signal');
  });

  describe('an ACK update that outlives its client-side bound', () => {
    const OWN_OPERATION = 'urn:dkg:share:snapshot-cleanup:share-41';
    /**
     * Holds the StorageACK update at the real store: the test's wrapper receives it, reports that it was
     * issued, and forwards it to the real `update` only when the test releases it. Every other update runs at once.
     */
    const holdAckUpdate = (store: OxigraphStore) => {
      const real = store.update!.bind(store);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let issue!: () => void;
      const issued = new Promise<void>(resolve => { issue = resolve; });
      let forwarded: Promise<void> | undefined;
      vi.spyOn(store, 'update').mockImplementation((sparql, options) => {
        if (!isAckUpdate(sparql)) return real(sparql, options);
        issue();
        forwarded = gate.then(() => real(sparql, options));
        return forwarded;
      });
      return { issued, release, finished: () => forwarded! };
    };
    const seedCopies = async (f: Awaited<ReturnType<typeof fixture>>, ual: string, ids: string[]) => {
      for (const id of ids) await f.store.insert(f.operationRows(ackSubject(id), `storage-ack-${id}`, ual, 1, digest));
    };

    it('removes nothing when it finally runs after the cleanup deleted the asset\'s rows, and the copies keep the file referenced', async () => {
      // What this pins: the client-side bound cannot cancel the update (no abort signal reaches the store), so
      // it may still run after clear() has moved on. By then the cleaned operations' rows, which are where the
      // update reads its version boundary, are deleted, so it finds no boundary and removes nothing, by
      // construction. The cost is the documented safe direction: the copies stay in the meta graph and keep
      // the file referenced until the SWM TTL, instead of a late update deleting rows it has no authority over.
      const f = await fixture();
      const asset = await f.seed(41);
      const copies = ['a', 'b'];
      await seedCopies(f, asset.ual, copies);
      await f.store.insert(f.operationRows(ackSubject('later'), 'storage-ack-later', asset.ual, 2, digest));
      const held = holdAckUpdate(f.store);
      const records: { level: string; message: string }[] = [];
      Logger.setSink(record => { records.push({ level: record.level, message: record.message }); });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const clearing = asset.clear();
        await held.issued;
        await vi.advanceTimersByTimeAsync(10_000);
        await clearing;
      } finally { vi.useRealTimers(); Logger.setSink(null); }
      // The cleanup went on without the update: one warning, the SWM graph dropped, the asset's own rows gone.
      const warnings = records.filter(record => record.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain('Could not clear storage ACK copy metadata after publication: Storage ACK copy cleanup timed out');
      expect(await f.store.countQuads(asset.swm)).toBe(0);
      expect(await rowsOf(f, OWN_OPERATION)).toBe(0);
      expect(await rowsOf(f, `${asset.ual}#dkg-swm-head`)).toBe(0);
      for (const id of copies) expect(await rowsOf(f, ackSubject(id)), id).toBe(5);
      // The store now runs the update it was handed before the bound passed.
      held.release();
      await held.finished();
      for (const id of [...copies, 'later']) expect(await rowsOf(f, ackSubject(id)), id).toBe(5);
      expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 1, deletedSnapshots: 0 });
      await expect(stat(f.path)).resolves.toBeDefined();
    });

    it('removes the copies when the same update is released before the asset\'s rows are deleted', async () => {
      const f = await fixture();
      const asset = await f.seed(41);
      const copies = ['a', 'b'];
      await seedCopies(f, asset.ual, copies);
      const held = holdAckUpdate(f.store);
      const clearing = asset.clear();
      await held.issued;
      // Issued, not yet run: the asset's own rows (the boundary) and every copy are still there.
      expect(await rowsOf(f, OWN_OPERATION)).toBeGreaterThan(0);
      for (const id of copies) expect(await rowsOf(f, ackSubject(id)), id).toBe(5);
      held.release();
      await clearing;
      for (const id of copies) expect(await rowsOf(f, ackSubject(id)), id).toBe(0);
      expect(await rowsOf(f, OWN_OPERATION)).toBe(0);
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 0, finalizedSnapshots: 1 });
      await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('removes the copies after the SWM graph is dropped and before the asset\'s own rows, which give the boundary', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const order: string[] = [];
    const dropGraph = f.store.dropGraph.bind(f.store);
    vi.spyOn(f.store, 'dropGraph').mockImplementation(async graph => { order.push('drop'); return dropGraph(graph); });
    const update = f.store.update!.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation(async (sparql, options) => {
      if (isAckUpdate(sparql)) {
        order.push('ack');
        // The publisher's own operation row is still there for the update to read.
        expect(await rowsOf(f, 'urn:dkg:share:snapshot-cleanup:share-41')).toBeGreaterThan(0);
      }
      return update(sparql, options);
    });
    const deleteWithoutCount = f.store.deleteByPatternWithoutCount.bind(f.store);
    vi.spyOn(f.store, 'deleteByPatternWithoutCount').mockImplementation(async pattern => {
      order.push('delete-own');
      return deleteWithoutCount(pattern);
    });
    await asset.clear();
    expect(order.indexOf('ack')).toBeGreaterThan(order.lastIndexOf('drop'));
    expect(order.indexOf('ack')).toBeLessThan(order.indexOf('delete-own'));
    expect(await rowsOf(f, ackSubject('own'))).toBe(0);
  });
});

describe('published snapshot cleanup: bounded by the version a publication confirmed', () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const UAL = `did:dkg:base:8453/${AUTHOR}/61`;
  const scope = createGraphKnowledgeAssetScope(UAL, 1);
  const SWM = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
  const VM = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
  const HEAD = `${UAL}#dkg-swm-head`;

  /**
   * Shares one version through the publisher's own staging entry point (the SWM graph, the operation
   * rows and snapshot, the head) and records the StorageACK copy a publishing core signs for it.
   * A version has as many quads as its number, so a count tells the versions apart.
   */
  const share = async (f: Fixture, assertionVersion: number) => {
    const shared = makeQuads(assertionVersion, `version-${assertionVersion}`);
    const sharedDigest = workspacePublicQuadsDigest(shared);
    await f.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CG, kaUal: UAL, assertionVersion, shareOperationId: `share-v${assertionVersion}`,
      quads: shared, privateTripleCount: 0, publisherPeerId: 'peer-publisher',
    });
    const copyId = storageAckOperationId(UAL, assertionVersion, new Uint8Array(32).fill(assertionVersion));
    const copy = generateKnowledgeAssetShareMetadata({
      shareOperationId: copyId, contextGraphId: CG,
      kaUal: UAL, assertionVersion, publicTripleCount: shared.length, privateTripleCount: 0,
      publisherPeerId: 'peer-publisher', timestamp: new Date(0),
    }, META);
    copy.push({ subject: copy[0]!.subject, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(sharedDigest), graph: META });
    await f.store.insert(copy);
    return { quads: shared, operation: `urn:dkg:share:${CG}:share-v${assertionVersion}`, copy: copy[0]!.subject, copyId,
      path: snapshotPath(f.directory, sharedDigest) };
  };
  /** The cleanup a publication runs once `finalizedVersion` is confirmed; without one, the call a lock-holding caller makes. */
  const confirm = (f: Fixture, finalizedVersion?: number) => f.publisher.clearPublishedKnowledgeAssetSwm(CG,
    { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
    undefined, createOperationContext('publish'), UAL, finalizedVersion, finalizedVersion === undefined ? undefined : {
      publicQuadsDigest: workspacePublicQuadsDigest(makeQuads(finalizedVersion, `version-${finalizedVersion}`)), privateTripleCount: 0,
    });
  /** Every row of the SWM meta graph, by subject. */
  const metaRows = async (f: Fixture) => {
    const result = await f.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } }`);
    const rows = new Map<string, string[]>();
    for (const row of result.type === 'bindings' ? result.bindings : []) {
      rows.set(row['s']!, [...(rows.get(row['s']!) ?? []), `${row['p']} ${row['o']}`].sort());
    }
    return rows;
  };

  it.each([false, true])('retains a same-version replacement and its marker when the earlier mint confirms (same content: %s)', async sameContent => {
    const f = await fixture();
    const NAME = 'same-version-mint';
    const firstPayload = [{ subject: 'urn:note:first', predicate: 'http://schema.org/value', object: '"first"', graph: '' }];
    await f.publisher.assertionCreate(CG, NAME, AUTHOR);
    await f.publisher.assertionWrite(CG, NAME, AUTHOR, firstPayload);
    const first = await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
    const firstShare = await f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'peer-publisher' });
    await f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    if (!sameContent) await f.publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:note:replacement', predicate: 'http://schema.org/value', object: '"replacement"', graph: '' }]);
    await finalizeRootlessAssertionForTest({ publisher: f.publisher, store: f.store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion: 1 });
    const secondShare = await f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'peer-publisher' });
    const replacement = await f.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${first.sharedGraphUri}> { ?s ?p ?o } }`);
    if (replacement.type !== 'quads') throw new Error('Expected replacement quads');
    const replacementDigest = workspacePublicQuadsDigest(replacement.quads);
    const before = await metaRows(f);
    const asset = createGraphKnowledgeAssetScope(first.kaUal, 1);
    await f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: asset.agentAddress, kaNumber: BigInt(asset.kaNumber) } },
      undefined, createOperationContext('publish'), first.kaUal, 1,
      { publicQuadsDigest: workspacePublicQuadsDigest(firstPayload), privateTripleCount: 0 }, firstShare.shareOperationId);
    expect(await f.store.countQuads(first.sharedGraphUri)).toBe(sameContent ? 1 : 2);
    expect(await metaRows(f)).toEqual(before);
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, firstShare.shareOperationId);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    expect(secondShare.shareOperationId).not.toBe(firstShare.shareOperationId);
    // B's own confirmation consumes its marker without consuming A's snapshot identity.
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, secondShare.shareOperationId);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ finalizedSnapshots: 0, deletedSnapshots: 0 });
    await expect(stat(snapshotPath(f.directory, replacementDigest))).resolves.toBeDefined();
  });

  it('separates legacy publication consumption from unconditional marker invalidation', async () => {
    const f = await fixture(), name = 'legacy-completion';
    await f.publisher.markSwmShareComplete(CG, name, AUTHOR);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(true);
    await f.publisher.consumePublishedSwmShareComplete(CG, name, AUTHOR, null);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
    await f.publisher.markSwmShareComplete(CG, name, AUTHOR);
    await f.store.insert([{ subject: assertionLifecycleUri(CG, AUTHOR, name), graph: contextGraphMetaUri(CG),
      predicate: `${DKG}shareOperationId`, object: '"replacement-share"' }]);
    await f.publisher.consumePublishedSwmShareComplete(CG, name, AUTHOR, null);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(true);
    await f.publisher.clearSwmShareComplete(CG, name, AUTHOR);
    expect(await f.publisher.hasSwmShareComplete(CG, name, AUTHOR)).toBe(false);
  });

  it('retains an equal-version head without evidence or with a different private count', async () => {
    const f = await fixture();
    const v1 = await share(f, 1);
    const before = await metaRows(f);
    await f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      undefined, createOperationContext('publish'), UAL, 1);
    await f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      undefined, createOperationContext('publish'), UAL, 1,
      { publicQuadsDigest: workspacePublicQuadsDigest(v1.quads), privateTripleCount: 1, privateMerkleRoot: '0x' + 'ab'.repeat(32) });
    expect(await metaRows(f)).toEqual(before);
    expect(await f.store.countQuads(SWM)).toBe(v1.quads.length);
    await confirm(f, 1);
    expect(await f.store.countQuads(SWM)).toBe(0);
  });

  it('compares private roots when version, public digest and private triple counts all match', async () => {
    const f = await fixture();
    const publicPayload = makeQuads(1, 'same-public');
    const privateA = makeQuads(1, 'private-A'), privateB = makeQuads(1, 'private-B');
    const rootA = computePrivateRootV10(privateA)!, rootB = computePrivateRootV10(privateB)!;
    expect(rootA).not.toEqual(rootB);
    await f.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({ contextGraphId: CG, kaUal: UAL, assertionVersion: 1,
      shareOperationId: 'same-count-private-B', quads: publicPayload, privateMerkleRoot: rootB, privateTripleCount: 1, publisherPeerId: 'peer-publisher' });
    const before = await metaRows(f), publicQuadsDigest = workspacePublicQuadsDigest(publicPayload);
    const clear = (root: Uint8Array) => f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      undefined, createOperationContext('publish'), UAL, 1,
      { publicQuadsDigest, privateTripleCount: 1, privateMerkleRoot: `0x${Buffer.from(root).toString('hex')}` });
    await clear(rootA);
    expect(await metaRows(f)).toEqual(before); expect(await f.store.countQuads(SWM)).toBe(publicPayload.length);
    await clear(rootB);
    expect((await metaRows(f)).has(HEAD)).toBe(false); expect(await f.store.countQuads(SWM)).toBe(0);
  });

  it('leaves version 3, its StorageACK copy and its snapshot in place when version 2 confirms after version 3 was shared', async () => {
    const f = await fixture();
    const v2 = await share(f, 2); // its publication is queued and waits for confirmation
    const v3 = await share(f, 3); // shared while that confirmation is pending: the head now names version 3
    await f.store.insert(v2.quads.map(q => ({ ...q, graph: VM }))); // version 2 confirms and is durable in VM
    const before = await metaRows(f);
    await confirm(f, 2);
    const after = await metaRows(f);
    // Version 3 is durable nowhere else: its StorageACK copy, its operation, the head and the graph stay as they were.
    for (const subject of [v3.copy, v3.operation, HEAD]) expect(after.get(subject), subject).toEqual(before.get(subject));
    expect(await f.store.countQuads(SWM)).toBe(v3.quads.length);
    // Nothing above version 2 is discharged, and under a newer head nothing of version 2 either: its rows
    // go with version 3's own cleanup or the SWM TTL.
    expect(after).toEqual(before);
    // No retirement was recorded, so version 3's snapshot outlives the grace period.
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ finalizedSnapshots: 0, referencedSnapshots: 0, deletedSnapshots: 0 });
    await expect(stat(v3.path)).resolves.toBeDefined();
    expect(await f.store.countQuads(VM)).toBe(v2.quads.length);
  });

  it('waits for a share that holds the per-KA write lock, then finds its newer head and leaves it', async () => {
    const f = await fixture();
    await share(f, 2);
    // Version 3's share has replaced the SWM graph and is held before it moves the head.
    const replaceGraph = f.store.replaceGraph.bind(f.store);
    let reached!: () => void;
    const replaced = new Promise<void>(resolve => { reached = resolve; });
    let resume!: () => void;
    const held = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(f.store, 'replaceGraph').mockImplementationOnce(async (graph, quads) => {
      await replaceGraph(graph, quads);
      reached();
      await held;
    });
    const sharing = share(f, 3);
    await replaced;
    const dropGraph = vi.spyOn(f.store, 'dropGraph');
    const clearing = confirm(f, 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(dropGraph).not.toHaveBeenCalled();
    resume();
    const v3 = await sharing;
    await clearing;
    expect(dropGraph).not.toHaveBeenCalled();
    expect(await f.store.countQuads(SWM)).toBe(v3.quads.length);
    const rows = await metaRows(f);
    expect(rows.get(HEAD)).toEqual(expect.arrayContaining([`${DKG}shareOperationId "share-v3"`]));
    for (const subject of [v3.copy, v3.operation]) expect(rows.has(subject), subject).toBe(true);
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ finalizedSnapshots: 0, referencedSnapshots: 0, deletedSnapshots: 0 });
    await expect(stat(v3.path)).resolves.toBeDefined();
  });

  it('passes the version a publication from shared memory confirmed to its cleanup', async () => {
    const f = await fixture();
    const v2 = await share(f, 2);
    // A later version is shared before the publication of version 2 returns.
    let v3!: Awaited<ReturnType<typeof share>>;
    vi.spyOn(f.publisher, 'publish').mockImplementationOnce(async () => {
      v3 = await share(f, 3);
      return { kaId: 1n, ual: UAL, merkleRoot: new Uint8Array(32), kaManifest: [], status: 'confirmed', publicQuads: v2.quads };
    });
    await f.publisher.publishFromSharedMemory(CG, 'all', {
      sharedMemoryScope: { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: UAL, assertionVersion: 2,
      publicTripleCount: v2.quads.length, privateTripleCount: 0,
    });
    const rows = await metaRows(f);
    expect(rows.get(HEAD)).toEqual(expect.arrayContaining([`${DKG}shareOperationId "share-v3"`]));
    for (const subject of [v3.copy, v3.operation]) expect(rows.has(subject), subject).toBe(true);
    expect(await f.store.countQuads(SWM)).toBe(v3.quads.length);
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ finalizedSnapshots: 0, referencedSnapshots: 0, deletedSnapshots: 0 });
    await expect(stat(v3.path)).resolves.toBeDefined();
  });

  it('applies the same bound to a version shared through assertionPromote while the previous one waits for confirmation', async () => {
    const f = await fixture();
    const NAME = 'notes';
    const sealAndShare = async (value: string, assertionVersion: number) => {
      await f.publisher.assertionWrite(CG, NAME, AUTHOR,
        [{ subject: `urn:note:${value}`, predicate: 'http://schema.org/value', object: JSON.stringify(value), graph: '' }]);
      const sealed = await finalizeRootlessAssertionForTest({
        publisher: f.publisher, store: f.store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR, assertionVersion });
      await f.publisher.assertionPromote(CG, NAME, AUTHOR, { publisherPeerId: 'peer-publisher' });
      return sealed;
    };
    // Version 1 is already in VM (not modelled here). Version 2 is shared and its publication is pending; the
    // draft is reopened, sealed as version 3 (finalize advances past a confirmed VM version) and shared.
    await f.publisher.assertionCreate(CG, NAME, AUTHOR);
    const { kaUal, sharedGraphUri } = await sealAndShare('two', 2);
    await f.publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    await sealAndShare('three', 3);
    const promoted = createGraphKnowledgeAssetScope(kaUal, 1);
    const confirmPromoted = (finalizedVersion: number) => f.publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: promoted.agentAddress, kaNumber: BigInt(promoted.kaNumber) } },
      undefined, createOperationContext('publish'), kaUal, finalizedVersion, {
        publicQuadsDigest: workspacePublicQuadsDigest([
          { subject: 'urn:note:two', predicate: 'http://schema.org/value', object: '"two"', graph: '' },
          ...(finalizedVersion === 3 ? [{ subject: 'urn:note:three', predicate: 'http://schema.org/value', object: '"three"', graph: '' }] : []),
        ]), privateTripleCount: 0,
      });
    await confirmPromoted(2);
    expect(await f.store.countQuads(sharedGraphUri)).toBe(2);
    expect((await metaRows(f)).get(`${kaUal}#dkg-swm-head`)).toEqual(expect.arrayContaining([`${DKG}assertionVersion ${version(3)}`]));
    await confirmPromoted(3);
    expect(await f.store.countQuads(sharedGraphUri)).toBe(0);
    expect((await metaRows(f)).has(`${kaUal}#dkg-swm-head`)).toBe(false);
  });

  it.each([
    [2, 'the version the head is at'],
    [3, 'a version above the head'],
  ])('clears the head, its StorageACK copy and, after grace, its snapshot when version %i confirms (%s)', async finalizedVersion => {
    const f = await fixture();
    const v2 = await share(f, 2);
    await f.store.insert(v2.quads.map(q => ({ ...q, graph: VM })));
    await confirm(f, finalizedVersion);
    const rows = await metaRows(f);
    for (const subject of [v2.copy, v2.operation, HEAD]) expect(rows.has(subject), subject).toBe(false);
    expect(await f.store.countQuads(SWM)).toBe(0);
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 0, finalizedSnapshots: 1 });
    await expect(stat(v2.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.store.countQuads(VM)).toBe(v2.quads.length);
  });

  it('clears a head that names the StorageACK copy, as a core\'s own ACK of a direct update leaves it', async () => {
    const f = await fixture();
    const v2 = await share(f, 2);
    await storeKnowledgeAssetWorkspaceHead({ store: f.store, graphManager: new GraphManager(f.store), contextGraphId: CG,
      kaUal: UAL, assertionVersion: 2, shareOperationId: v2.copyId });
    await confirm(f, 2);
    const rows = await metaRows(f);
    for (const subject of [v2.copy, HEAD]) expect(rows.has(subject), subject).toBe(false);
    expect(await f.store.countQuads(SWM)).toBe(0);
  });

  it('still drops a SWM graph that no head owns', async () => {
    const f = await fixture();
    await f.store.insert(makeQuads(2, 'headless').map(q => ({ ...q, graph: SWM })));
    await confirm(f, 1);
    expect(await f.store.countQuads(SWM)).toBe(0);
  });

  it('keeps a head it cannot resolve, and reports it once', async () => {
    const f = await fixture();
    const v2 = await share(f, 2);
    // A second version beside the first, as a synced copy of a peer's head row leaves it.
    await f.store.insert([{ graph: META, subject: HEAD, predicate: `${DKG}assertionVersion`, object: version(3) }]);
    const before = await metaRows(f);
    const records: { level: string; message: string }[] = [];
    Logger.setSink(record => { records.push({ level: record.level, message: record.message }); });
    try { await confirm(f, 2); } finally { Logger.setSink(null); }
    expect(await metaRows(f)).toEqual(before);
    expect(await f.store.countQuads(SWM)).toBe(v2.quads.length);
    const warnings = records.filter(record => record.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('its head cannot be resolved');
    f.advance();
    expect(await f.snapshots.collectGarbage()).toMatchObject({ finalizedSnapshots: 0, referencedSnapshots: 0, deletedSnapshots: 0 });
    await expect(stat(v2.path)).resolves.toBeDefined();
  });

  it('refuses a confirmed version that is not a positive integer, and removes nothing', async () => {
    const f = await fixture();
    const v2 = await share(f, 2);
    const before = await metaRows(f);
    await expect(confirm(f, 0)).rejects.toThrow('KA assertion version must be at least 1');
    expect(await metaRows(f)).toEqual(before);
    expect(await f.store.countQuads(SWM)).toBe(v2.quads.length);
  });

  it('takes no lock without a version, so a caller that holds the per-KA write lock can run it', async () => {
    const f = await fixture();
    await share(f, 2);
    await withKeyedLocks(f.publisher.writeLocks, [swmKaWriteLockKey(CG, undefined, UAL)], () => confirm(f));
    expect(await f.store.countQuads(SWM)).toBe(0);
    expect((await metaRows(f)).has(HEAD)).toBe(false);
  }, 5_000);
});
