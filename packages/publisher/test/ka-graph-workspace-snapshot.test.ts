import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetOperationPublicQuads,
} from '../src/workspace-resolution.js';
import { FileWorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';

const CONTEXT_GRAPH = 'rootless-load';
const OPERATION_ID = 'op-1';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const DKG = 'http://dkg.io/ontology/';

describe('graph-scoped KA workspace snapshots', () => {
  it('stores one operation and one snapshot for 1,000 distinct subjects', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const quads: Quad[] = Array.from({ length: 1_000 }, (_, index) => ({
      subject: `urn:entity:${index}`,
      predicate: 'urn:predicate:value',
      object: `"${index}"`,
      graph: '',
    }));

    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: OPERATION_ID,
      kaUal: UAL,
      assertionVersion: 1,
      quads,
      publisherPeerId: 'peer-1',
    });

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    const meta = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    expect(meta.type).toBe('quads');
    if (meta.type !== 'quads') throw new Error('expected metadata quads');
    expect(meta.quads.length).toBeLessThanOrEqual(13);
    expect(meta.quads.some((quad) => quad.predicate.endsWith('rootEntity'))).toBe(false);
    expect(meta.quads.some((quad) => quad.predicate.endsWith('workspaceOwner'))).toBe(false);
    expect(meta.quads.filter((quad) => quad.predicate.endsWith('publicQuadsDigest'))).toHaveLength(1);

    const resolved = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: OPERATION_ID,
      kaUal: UAL,
      assertionVersion: 1,
    });
    expect(resolved.quads).toHaveLength(1_000);
    expect(new Set(resolved.quads.map((quad) => quad.subject)).size).toBe(1_000);
    expect(resolved.kaUal).toBe(UAL);
  });

  it('resolves a missing legacy ref from its canonical digest snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-workspace-alias-snapshot-'));
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const snapshots = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: { enabled: false },
    });
    const quads: Quad[] = [{
      subject: 'urn:entity:legacy-alias',
      predicate: 'urn:predicate:value',
      object: '"canonical"',
      graph: '',
    }];
    try {
      await storeKnowledgeAssetOperationPublicQuads({
        store,
        graphManager,
        contextGraphId: CONTEXT_GRAPH,
        shareOperationId: OPERATION_ID,
        kaUal: UAL,
        assertionVersion: 1,
        quads,
        publicSnapshotStore: snapshots,
      });
      await store.insert([{
        subject: `urn:dkg:share:${CONTEXT_GRAPH}:${OPERATION_ID}`,
        predicate: `${DKG}publicSnapshotRef`,
        object: `"sha256:${'9'.repeat(64)}"`,
        graph: graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH),
      }]);

      await expect(resolveKnowledgeAssetOperationPublicQuads({
        store,
        graphManager,
        contextGraphId: CONTEXT_GRAPH,
        shareOperationId: OPERATION_ID,
        kaUal: UAL,
        assertionVersion: 1,
        publicSnapshotStore: snapshots,
      })).resolves.toMatchObject({ quads });
    } finally {
      snapshots.stopGarbageCollection();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
