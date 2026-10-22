import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, expect, it, vi } from 'vitest';
import { generateEd25519Keypair, createOperationContext } from '@origintrail-official/dkg-core';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { FileWorkspacePublicSnapshotStore, type DKGPublisher, type DKGPublisherConfig } from '@origintrail-official/dkg-publisher';
import { createPublisherRuntimeFromAgent } from '../src/publisher-runner.js';

const constructed = vi.hoisted(() => [] as Array<{ publisher: DKGPublisher; config: DKGPublisherConfig }>);
vi.mock('@origintrail-official/dkg-publisher', async importOriginal => {
  const original = await importOriginal<typeof import('@origintrail-official/dkg-publisher')>();
  return { ...original, DKGPublisher: class extends original.DKGPublisher {
    constructor(config: DKGPublisherConfig) { super(config); constructed.push({ publisher: this, config }); }
  } };
});
afterEach(() => { constructed.length = 0; vi.restoreAllMocks(); });

it('passes the composed cleanup through the runtime to every wallet and its retirement path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-cleanup-wiring-'));
  const store = new OxigraphStore();
  const snapshots = new FileWorkspacePublicSnapshotStore(join(directory, 'snapshots'), undefined, {
    gc: { enabled: true, finalizedCleanupEnabled: true },
  });
  snapshots.stopGarbageCollection();
  // Public development keys: no real RPC or signing is performed by this test.
  const wallets = [1, 2].map(n => {
    const privateKey = `0x${String(n).repeat(64)}`;
    return { address: new ethers.Wallet(privateKey).address, privateKey };
  });
  await writeFile(join(directory, 'publisher-wallets.json'), JSON.stringify({ wallets }));
  vi.spyOn(EVMChainAdapter.prototype, 'getIdentityId').mockResolvedValue(0n);
  const cleanup = vi.fn(async () => {});
  let runtime: Awaited<ReturnType<typeof createPublisherRuntimeFromAgent>> | undefined;
  try {
    runtime = await createPublisherRuntimeFromAgent({
      dataDir: directory, store, keypair: await generateEd25519Keypair(),
      chainBase: { rpcUrl: 'http://127.0.0.1:1', hubAddress: '0x' + 'a'.repeat(40), chainId: 'evm:31337' },
      publicSnapshotStore: snapshots, storageAckCopyCleanup: cleanup,
    });
    expect(constructed).toHaveLength(2);
    const author = '0x' + 'b'.repeat(40);
    const meta = 'did:dkg:context-graph:cleanup/_shared_memory_meta';
    for (const [i, { publisher, config }] of constructed.entries()) {
      expect(config.storageAckCopyCleanup).toBe(cleanup);
      const ual = `did:dkg:evm:31337/${author}/${i + 1}`;
      const operation = `urn:share:cleanup:${i}`;
      await store.insert([
        { graph: meta, subject: `${ual}#dkg-swm-head`, predicate: 'http://dkg.io/ontology/shareOperationId', object: `"share-${i}"` },
        { graph: meta, subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
        { graph: meta, subject: operation, predicate: 'http://dkg.io/ontology/shareOperationId', object: `"share-${i}"` },
        { graph: meta, subject: operation, predicate: 'http://dkg.io/ontology/kaUal', object: ual },
      ]);
      await publisher.clearPublishedKnowledgeAssetSwm('cleanup', {
        kind: 'named-lifecycle', identity: { agentAddress: author, kaNumber: BigInt(i + 1) },
      }, undefined, createOperationContext('test'), ual);
      expect(cleanup).toHaveBeenNthCalledWith(i + 1, { metaGraph: meta, kaUal: ual, cleanedOperations: [operation] });
    }
  } finally {
    await runtime?.stop();
    snapshots.stopGarbageCollection();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
