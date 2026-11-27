import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

describe('DKGAgent public snapshot store injection', () => {
  let agent: DKGAgent | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => {});
      await agent.store.close().catch(() => {});
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('binds default finalized cleanup to the agent RDF store without an injected snapshot store', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-agent-default-retirement-'));
    agent = await DKGAgent.create({
      name: 'DefaultSnapshotBot', dataDir, listenHost: '127.0.0.1',
      sharedMemoryPublicSnapshotStorage: { gc: {
        finalizedCleanupEnabled: true, finalizedRetentionMs: 0,
        triggerFreeBytes: 1, targetFreeBytes: 2, hardReserveBytes: 0,
      } },
    });
    expect(agent.publicSnapshotStore).toBeInstanceOf(FileWorkspacePublicSnapshotStore);
    const snapshots = agent.publicSnapshotStore as FileWorkspacePublicSnapshotStore;
    snapshots.stopGarbageCollection();
    const query = vi.spyOn(agent.store, 'query');
    const quads: Quad[] = [{ subject: 'urn:default', predicate: 'urn:p', object: '"value"', graph: '' }];
    const digest = workspacePublicQuadsDigest(quads);
    await snapshots.putSnapshot({ digest, quads });
    await agent.store.insert([{ graph: 'urn:pending', subject: 'urn:op',
      predicate: 'http://dkg.io/ontology/publicSnapshotRef', object: JSON.stringify(digest) }]);
    await snapshots.lifecycle.markPublished([digest]);
    expect((await snapshots.collectGarbage()).referencedSnapshots).toBe(1);
    expect(query.mock.calls.some(([sparql]) => sparql.startsWith('ASK'))).toBe(true);
    await agent.store.dropGraph('urn:pending');
    expect((await snapshots.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('constructs one custom store after its RDF store exists and shares it with the publisher', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-agent-store-factory-'));
    const snapshots: WorkspacePublicSnapshotStore = {
      putSnapshot: vi.fn(async ({ digest }) => ({ ref: digest, byteLength: 0 })),
      getSnapshot: async () => null,
    };
    const factory = vi.fn(() => snapshots);
    agent = await DKGAgent.create({ name: 'FactorySnapshotBot', dataDir, listenHost: '127.0.0.1',
      publicSnapshotStoreFactory: factory });
    expect(factory).toHaveBeenCalledExactlyOnceWith(agent.store);
    expect(agent.publicSnapshotStore).toBe(snapshots);
    await agent.publisher.writeToWorkspace('factory-test', [
      { subject: 'urn:factory', predicate: 'urn:p', object: '"value"', graph: '' },
    ], { publisherPeerId: 'factory-peer' });
    expect(snapshots.putSnapshot).toHaveBeenCalledOnce();
  });

  it('uses the injected store for workspace public snapshots', async () => {
    const publicQuads: Quad[] = [{
      subject: 'urn:snapshot-store-injection:entity',
      predicate: 'http://schema.org/name',
      object: '"Injected snapshot store"',
      graph: '',
    }];
    let persistedSnapshot: { digest: string; quads: readonly Quad[] } | undefined;
    const publicSnapshotStore: WorkspacePublicSnapshotStore = {
      async putSnapshot(input) {
        persistedSnapshot = input;
        return { ref: input.digest, byteLength: 0 };
      },
      async getSnapshot() {
        return null;
      },
    };
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-agent-snapshot-store-injection-'));
    agent = await DKGAgent.create({
      name: 'SnapshotStoreInjectionBot',
      dataDir,
      listenHost: '127.0.0.1',
      publicSnapshotStore,
    });

    await agent.publisher.writeToWorkspace('snapshot-store-injection', publicQuads, {
      publisherPeerId: 'snapshot-store-injection-peer',
    });

    expect(persistedSnapshot).toEqual({
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      quads: publicQuads,
    });
  });
});
