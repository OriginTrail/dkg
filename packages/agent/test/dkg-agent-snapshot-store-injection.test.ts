import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
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
