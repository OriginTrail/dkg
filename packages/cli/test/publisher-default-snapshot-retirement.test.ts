import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { createPublisherRuntime, createPublisherInspector, createPublisherRuntimeFromAgent } from '../src/publisher-runner.js';
import { addPublisherWallet } from '../src/publisher-wallets.js';
import type { DkgConfig } from '../src/config.js';

// This is a local composition test; do not construct a public RPC adapter.
vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, loadNetworkConfig: async () => null };
});

const capture = vi.hoisted(() => ({ store: undefined as TripleStore | undefined,
  snapshots: undefined as FileWorkspacePublicSnapshotStore | undefined }));
// Capture the actual composition result; all file operations and RDF checks remain real.
vi.mock('@origintrail-official/dkg-publisher', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-publisher')>();
  return { ...actual, TripleStoreAsyncLiftPublisher: class extends actual.TripleStoreAsyncLiftPublisher {
    constructor(...args: ConstructorParameters<typeof actual.TripleStoreAsyncLiftPublisher>) {
      super(...args);
      capture.store = args[0];
      capture.snapshots = args[1]?.publicSnapshotStore as FileWorkspacePublicSnapshotStore;
    }
  } };
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  capture.snapshots?.stopGarbageCollection();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  capture.store = undefined; capture.snapshots = undefined;
  vi.restoreAllMocks();
});

describe('CLI default snapshot retirement composition', () => {
  it.each(['standalone', 'inspector', 'agent-runtime'] as const)('%s checks references in its own RDF store', async kind => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-cli-default-retirement-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const config: DkgConfig = {
      name: 'retirement-wiring', apiPort: 0, listenPort: 0, nodeRole: 'edge',
      store: { backend: 'oxigraph' },
      sharedMemoryPublicSnapshotStorage: { gc: {
        finalizedCleanupEnabled: true, finalizedRetentionMs: 0,
        triggerFreeBytes: 1, targetFreeBytes: 2, hardReserveBytes: 0,
      } },
    };
    if (kind === 'inspector') {
      const inspector = await createPublisherInspector({ dataDir, config });
      cleanups.push(() => inspector.stop());
    } else {
      await addPublisherWallet(dataDir, ethers.Wallet.createRandom().privateKey);
      if (kind === 'standalone') {
        const runtime = await createPublisherRuntime({ dataDir, config });
        cleanups.push(() => runtime.stop());
      } else {
        const store = await createTripleStore({ backend: 'oxigraph' });
        cleanups.push(() => store.close());
        const runtime = await createPublisherRuntimeFromAgent({ dataDir, config, store,
          keypair: await generateEd25519Keypair() });
        cleanups.push(() => runtime.stop());
        expect(capture.store).toBe(store);
      }
    }
    const { store, snapshots } = capture;
    expect(snapshots).toBeInstanceOf(FileWorkspacePublicSnapshotStore);
    snapshots!.stopGarbageCollection();
    const query = vi.spyOn(store!, 'query');
    const quads = [{ subject: 'urn:cli', predicate: 'urn:p', object: '"value"', graph: '' }];
    const digest = workspacePublicQuadsDigest(quads);
    await snapshots!.putSnapshot({ digest, quads });
    await store!.insert([{ graph: 'urn:pending', subject: 'urn:op',
      predicate: 'http://dkg.io/ontology/publicSnapshotRef', object: JSON.stringify(digest) }]);
    await snapshots!.lifecycle.markPublished([digest]);
    expect((await snapshots!.collectGarbage()).referencedSnapshots).toBe(1);
    expect(query.mock.calls.some(([sparql]) => sparql.startsWith('ASK'))).toBe(true);
    await store!.dropGraph('urn:pending');
    expect((await snapshots!.collectGarbage()).finalizedSnapshots).toBe(1);
  });
});
