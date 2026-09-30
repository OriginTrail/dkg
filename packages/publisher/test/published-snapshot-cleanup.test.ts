import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, createGraphKnowledgeAssetScope, createOperationContext, generateEd25519Keypair,
  knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest } from '../src/workspace-snapshot-store.js';
import { snapshotReferenceCheck } from '../src/workspace-snapshot-lifecycle.js';
import { PublishedSnapshotRetirement } from '../src/published-snapshot-retirement.js';
import { generateKnowledgeAssetShareMetadata } from '../src/metadata.js';
import { storageAckOperationId } from '../src/storage-ack-ledger.js';
import { makeQuads, snapshotPath } from './_helpers/workspace-snapshot-store.js';

const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CG = 'snapshot-cleanup';
const META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const DKG = 'http://dkg.io/ontology/';
const quads = makeQuads(2, 'published');
const digest = workspacePublicQuadsDigest(quads);
const cleanups: (() => Promise<void>)[] = [];
const version = (value: number) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;

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
  const seed = async (number: number, payload = { quads, digest }) => {
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
      { graph: META, subject: operation, predicate: `${DKG}assertionVersion`, object: version(1) },
      { graph: META, subject: operation, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(digest) },
    ]);
    return { swm, vm, ual, digest, clear: () => publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      undefined, createOperationContext('test'), ual) };
  };
  /** One operation row set, in the shape the share/ACK writers persist it. */
  const operationRows = (subject: string, shareId: string, ual: string, assertionVersion: number, digest: string) => [
    { graph: META, subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
    { graph: META, subject, predicate: `${DKG}shareOperationId`, object: JSON.stringify(shareId) },
    { graph: META, subject, predicate: `${DKG}kaUal`, object: ual },
    { graph: META, subject, predicate: `${DKG}assertionVersion`, object: version(assertionVersion) },
    { graph: META, subject, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(digest) },
  ];
  return {
    store, snapshots, seed, operationRows, directory, open, path: snapshotPath(directory, digest), advance: () => { now += 1_001; },
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
  /** The StorageACK lookups are the store queries that read assertion versions. */
  const isAckLookup = (sparql: string) => sparql.includes(`${DKG}assertionVersion`);
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

  it('leaves the ACK copy alone when finalized cleanup is off', async () => {
    const f = await fixture(false);
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const query = vi.spyOn(f.store, 'query');
    await asset.clear();
    expect(await rowsOf(f, ackSubject('own'))).toBe(5);
    expect(query.mock.calls.some(([sparql]) => isAckLookup(sparql))).toBe(false);
  });

  it('keeps the copy and still completes the cleanup when its lookup fails', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const query = f.store.query.bind(f.store);
    vi.spyOn(f.store, 'query').mockImplementation((sparql, options) =>
      isAckLookup(sparql) ? Promise.reject(new Error('store unavailable')) : query(sparql, options));
    await expect(asset.clear()).resolves.toBeUndefined();
    expect(await f.store.countQuads(asset.swm)).toBe(0);
    expect(await rowsOf(f, ackSubject('own'))).toBe(5);
    f.advance();
    expect((await f.snapshots.collectGarbage()).referencedSnapshots).toBe(1);
  });

  it('reports a failed deletion through the warning channel and leaves every copy in place', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    const warn = vi.fn();
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    for (const id of ['one', 'two']) await f.store.insert(f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest));
    const plan = await retirement.findDischargedStorageAckCopies(META, asset.ual, ['urn:dkg:share:snapshot-cleanup:share-41'], warn);
    expect([...plan.operations].sort()).toEqual([ackSubject('one'), ackSubject('two')]);
    vi.spyOn(f.store, 'update').mockRejectedValueOnce(new Error('disk full'));
    await expect(retirement.clearStorageAckCopies(plan, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not clear storage ACK copy metadata after publication: disk full');
    // One mutation failed as a whole: no prefix of the list was applied.
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
    for (const id of ids) expect(ackUpdates[0]![0]).toContain(`<${ackSubject(id)}>`);
    expect(ackUpdates[0]![1]).toMatchObject({ touchedGraphs: [META] });
    // No per-subject mutation for any copy.
    expect([...deleteByPattern.mock.calls, ...deleteWithoutCount.mock.calls, ...remove.mock.calls]
      .filter(([arg]) => touchesAck(arg))).toEqual([]);
    for (const id of ids) expect(await rowsOf(f, ackSubject(id))).toBe(0);
  });

  it('reports a failed mutation once and keeps the copies, the file and the rest of the cleanup', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    for (const id of ['a', 'b']) await f.store.insert(f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest));
    const update = f.store.update!.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation((sparql, options) =>
      sparql.includes('storage-ack-') ? Promise.reject(new Error('store offline')) : update(sparql, options));
    await expect(asset.clear()).resolves.toBeUndefined();
    expect(await f.store.countQuads(asset.swm)).toBe(0);
    expect(await f.store.countQuads(asset.vm)).toBe(quads.length);
    for (const id of ['a', 'b']) expect(await rowsOf(f, ackSubject(id))).toBe(5);
    f.advance();
    expect((await f.snapshots.collectGarbage()).referencedSnapshots).toBe(1);
    await expect(stat(f.path)).resolves.toBeDefined();
  });

  it('applies nothing when one planned subject cannot be written into the update', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('one'), 'storage-ack-one', asset.ual, 1, digest));
    const warn = vi.fn();
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    await retirement.clearStorageAckCopies({ metaGraph: META, operations: [ackSubject('one'), 'not an iri'], truncated: false }, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(await rowsOf(f, ackSubject('one'))).toBe(5);
  });

  it('keeps the copies and reports it when the store cannot run an update', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('one'), 'storage-ack-one', asset.ual, 1, digest));
    const warn = vi.fn();
    const withoutUpdate = { query: f.store.query.bind(f.store) } as unknown as OxigraphStore;
    const retirement = new PublishedSnapshotRetirement(withoutUpdate, f.snapshots.lifecycle);
    const plan = await retirement.findDischargedStorageAckCopies(META, asset.ual, ['urn:dkg:share:snapshot-cleanup:share-41'], warn);
    expect(plan.operations).toEqual([ackSubject('one')]);
    await retirement.clearStorageAckCopies(plan, warn);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Could not clear storage ACK copy metadata after publication: the triple store cannot run a single update for the whole set');
    expect(await rowsOf(f, ackSubject('one'))).toBe(5);
  });

  it('plans nothing without a cleaned operation to take the version from', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const retirement = new PublishedSnapshotRetirement(f.store, f.snapshots.lifecycle);
    const warn = vi.fn();
    expect((await retirement.findDischargedStorageAckCopies(META, asset.ual, [], warn)).operations).toEqual([]);
    // An operation id that is not in the graph gives no version either.
    expect((await retirement.findDischargedStorageAckCopies(META, asset.ual, ['urn:dkg:share:unknown'], warn)).operations).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  describe.each([[false], [true]])('with more copies than one lookup returns (store answers ACK rows first: %s)', ackFirst => {
    const COPIES = 130;
    /** Emulate a store whose unordered results begin with the ACK rows, whatever the LIMIT cuts off. */
    function answerAckRowsFirst(f: Awaited<ReturnType<typeof fixture>>) {
      const query = f.store.query.bind(f.store);
      vi.spyOn(f.store, 'query').mockImplementation(async (sparql, options) => {
        const limit = /\bLIMIT (\d+)\s*$/.exec(sparql);
        if (!ackFirst || !limit || sparql.includes('ORDER BY') || !isAckLookup(sparql)) return query(sparql, options);
        const all = await query(sparql.replace(/\bLIMIT \d+\s*$/, ''), options);
        if (all.type !== 'bindings') return all;
        const isAck = (row: Record<string, string>) => String(row['shareId']).includes('storage-ack-');
        return { ...all, bindings: [...all.bindings.filter(isAck), ...all.bindings.filter(row => !isAck(row))].slice(0, Number(limit[1])) };
      });
    }

    it('removes every discharged copy and only those', async () => {
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
      answerAckRowsFirst(f);
      await asset.clear();
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
      const ids = Array.from({ length: COPIES }, (_, i) => `copy-${String(i).padStart(3, '0')}`);
      await f.store.insert(ids.flatMap(id => f.operationRows(ackSubject(id), `storage-ack-${id}`, asset.ual, 1, digest)));
      answerAckRowsFirst(f);
      await asset.clear();
      f.advance();
      expect(await f.snapshots.collectGarbage()).toMatchObject({ referencedSnapshots: 0, finalizedSnapshots: 1 });
      await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('bounds a stuck copy lookup on the client side and plans nothing', async () => {
    const f = await fixture();
    const warn = vi.fn();
    const stuck = { query: () => new Promise<never>(() => {}) } as unknown as OxigraphStore;
    const retirement = new PublishedSnapshotRetirement(stuck, f.snapshots.lifecycle);
    vi.useFakeTimers();
    try {
      const finding = retirement.findDischargedStorageAckCopies(META, 'did:dkg:base:8453/0xabc/1', ['urn:dkg:share:x'], warn);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await finding).operations).toEqual([]);
    } finally { vi.useRealTimers(); }
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Could not look up storage ACK copy metadata for cleanup: Storage ACK copy lookup timed out');
  });

  it('warns when a plan reaches its page limit and still hands back the copies it read', async () => {
    const f = await fixture();
    const warn = vi.fn();
    let pages = 0;
    // A store with an endless supply of copies: every page is full and starts after the previous one.
    const endless = { query: async (sparql: string) => sparql.includes('ORDER BY')
      ? { type: 'bindings' as const, bindings: Array.from({ length: 64 }, (_, i) => ({
        operation: `urn:dkg:share:${CG}:storage-ack-${String(pages++ * 64 + i).padStart(6, '0')}` })) }
      : { type: 'bindings' as const, bindings: [{ version: version(1) }] } } as unknown as OxigraphStore;
    const retirement = new PublishedSnapshotRetirement(endless, f.snapshots.lifecycle);
    const plan = await retirement.findDischargedStorageAckCopies(META, 'did:dkg:base:8453/0xabc/1', ['urn:dkg:share:x'], warn);
    expect(plan.truncated).toBe(true);
    expect(plan.operations).toHaveLength(64 * 64);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Storage ACK copy cleanup reached its page or time limit; 4096 copies are planned for removal and any others stay');
  });

  it('plans nothing when a later page fails, even though the boundary was found', async () => {
    const f = await fixture();
    const asset = await f.seed(41);
    await f.store.insert(f.operationRows(ackSubject('own'), 'storage-ack-own', asset.ual, 1, digest));
    const query = f.store.query.bind(f.store);
    vi.spyOn(f.store, 'query').mockImplementation((sparql, options) =>
      sparql.includes('ORDER BY ?operation') ? Promise.reject(new Error('page failed')) : query(sparql, options));
    await expect(asset.clear()).resolves.toBeUndefined();
    expect(await rowsOf(f, ackSubject('own'))).toBe(5);
    f.advance();
    expect((await f.snapshots.collectGarbage()).referencedSnapshots).toBe(1);
  });
});
