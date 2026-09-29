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
import { makeQuads, snapshotPath } from './_helpers/workspace-snapshot-store.js';

const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CG = 'snapshot-cleanup';
const META = `did:dkg:context-graph:${CG}/_shared_memory_meta`;
const DKG = 'http://dkg.io/ontology/';
const quads = makeQuads(2, 'published');
const digest = workspacePublicQuadsDigest(quads);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(finalizedCleanupEnabled = true, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-published-snapshot-'));
  const store = new OxigraphStore();
  let now = 100_000;
  const snapshots = new FileWorkspacePublicSnapshotStore(directory, undefined, {
    gc: { enabled, finalizedCleanupEnabled, finalizedRetentionMs: 1_000 }, now: () => now,
    getAvailableBytes: async () => 100 * 1024 ** 3,
    isSnapshotReferenced: snapshotReferenceCheck(store),
  });
  snapshots.stopGarbageCollection();
  cleanups.push(async () => { snapshots.stopGarbageCollection(); await rm(directory, { recursive: true, force: true }); });
  const publisher = new DKGPublisher({ store, publicSnapshotStore: snapshots,
    chain: new NoChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  const seed = async (number: number) => {
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
      { graph: META, subject: operation, predicate: `${DKG}publicQuadsDigest`, object: JSON.stringify(digest) },
    ]);
    return { swm, vm, clear: () => publisher.clearPublishedKnowledgeAssetSwm(CG,
      { kind: 'named-lifecycle', identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) } },
      undefined, createOperationContext('test'), ual) };
  };
  return { store, snapshots, seed, path: snapshotPath(directory, digest), advance: () => { now += 1_001; } };
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
