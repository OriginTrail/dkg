import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { FileWorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';
import { snapshotHash, snapshotLifecycleGate } from '../src/workspace-snapshot-lifecycle.js';
import { storeKnowledgeAssetOperationPublicQuads, storeWorkspaceOperationPublicQuads } from '../src/workspace-resolution.js';

const quads = [{ subject: 'urn:root', predicate: 'urn:p', object: '"value"', graph: '' }];
const ual = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';

describe('production public snapshot write boundaries', () => {
  // Operation-long leases belong to finalized cleanup; a store without it keeps
  // its pre-existing pressure policy and takes none.
  for (const cleanup of [true, false]) {
    for (const kind of ['workspace', 'knowledge-asset'] as const) {
      for (const fail of [false, true]) {
        it(`${kind} ${cleanup ? 'holds a real file lease' : 'takes no lease with cleanup off'} through metadata ${fail ? 'failure' : 'completion'}`, async () => {
          const directory = await mkdtemp(join(tmpdir(), 'dkg-write-scope-'));
          const rdf = new OxigraphStore();
          const snapshots = new FileWorkspacePublicSnapshotStore(directory, undefined, cleanup
            ? { gc: { finalizedCleanupEnabled: true }, getAvailableBytes: async () => 100 * 1024 ** 3 }
            : { gc: { enabled: false } });
          // The lease is observable on the real gate: while an operation holds one, the digest is busy.
          const busy = async (digest: string) =>
            await snapshotLifecycleGate(directory).tryCollect(snapshotHash(digest), async () => 'idle') === undefined;
          expect('operationLease' in snapshots.lifecycle).toBe(cleanup);
          let held = 0;
          if (snapshots.lifecycle.operationLease) {
            const lease = snapshots.lifecycle.operationLease;
            vi.spyOn(snapshots.lifecycle, 'operationLease').mockImplementation(async ref => {
              const release = await lease(ref); held++;
              return () => { held--; release(); };
            });
          }
          const put = vi.spyOn(snapshots, 'putSnapshot');
          const insert = rdf.insert.bind(rdf);
          let commits = 0;
          vi.spyOn(rdf, 'insert').mockImplementation(async rows => {
            if (rows.some(q => q.predicate.endsWith('/publicQuadsDigest'))) {
              commits++;
              expect(put).toHaveBeenCalledTimes(1);
              const digest = put.mock.calls[0]![0].digest;
              // The digest is busy through the metadata commit exactly when the store offers the lease.
              expect(await busy(digest)).toBe(cleanup);
              if (cleanup) expect(held).toBeGreaterThan(0);
              else expect(held).toBe(0);
              if (fail) throw new Error('metadata unavailable');
            }
            return insert(rows);
          });
          const params = { store: rdf, graphManager: new GraphManager(rdf), contextGraphId: 'scope-test',
            shareOperationId: 'op', quads, publicSnapshotStore: snapshots };
          try {
            const result = kind === 'workspace'
              ? storeWorkspaceOperationPublicQuads({ ...params, rootEntities: ['urn:root'] })
              : storeKnowledgeAssetOperationPublicQuads({ ...params, kaUal: ual, assertionVersion: 1 });
            if (fail) await expect(result).rejects.toThrow('metadata unavailable');
            else await result;
            expect(commits).toBe(1);
            expect(held).toBe(0);
            // The lease is closed with the operation: the digest is free again.
            expect(await busy(put.mock.calls[0]![0].digest)).toBe(false);
          } finally { snapshots.stopGarbageCollection(); await rdf.close(); await rm(directory, { recursive: true, force: true }); }
        });
      }
    }
  }
});
