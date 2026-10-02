import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { FileWorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';
import { storeKnowledgeAssetOperationPublicQuads, storeWorkspaceOperationPublicQuads } from '../src/workspace-resolution.js';

const quads = [{ subject: 'urn:root', predicate: 'urn:p', object: '"value"', graph: '' }];
const ual = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';

describe('production public snapshot write boundaries', () => {
  for (const kind of ['workspace', 'knowledge-asset'] as const) {
    for (const fail of [false, true]) {
      it(`${kind} holds a real file lease through metadata ${fail ? 'failure' : 'completion'}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dkg-write-scope-'));
        const rdf = new OxigraphStore();
        const snapshots = new FileWorkspacePublicSnapshotStore(directory, undefined, { gc: { enabled: false } });
        let active = 0;
        const acquire = snapshots.lifecycle.acquire;
        vi.spyOn(snapshots.lifecycle, 'acquire').mockImplementation(async ref => {
          const release = await acquire(ref); active++;
          return () => { active--; release(); };
        });
        const put = vi.spyOn(snapshots, 'putSnapshot');
        const insert = rdf.insert.bind(rdf);
        let commits = 0;
        vi.spyOn(rdf, 'insert').mockImplementation(async rows => {
          if (rows.some(q => q.predicate.endsWith('/publicQuadsDigest'))) {
            commits++;
            expect(active).toBeGreaterThan(0);
            expect(put).toHaveBeenCalledTimes(1);
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
          expect(active).toBe(0);
        } finally { snapshots.stopGarbageCollection(); await rdf.close(); await rm(directory, { recursive: true, force: true }); }
      });
    }
  }
});
