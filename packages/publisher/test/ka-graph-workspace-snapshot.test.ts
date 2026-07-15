import { describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  KnowledgeAssetOperationPublicSnapshotNotFoundError,
  resolveKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetOperationPublicQuads,
} from '../src/workspace-resolution.js';

const CONTEXT_GRAPH = 'rootless-load';
const OPERATION_ID = 'op-1';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';

describe('graph-scoped KA workspace snapshots', () => {
  it('distinguishes an absent snapshot from corruption and store outages', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const resolve = () => resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: OPERATION_ID,
      kaUal: UAL,
      assertionVersion: 1,
    });

    await expect(resolve()).rejects.toBeInstanceOf(
      KnowledgeAssetOperationPublicSnapshotNotFoundError,
    );

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    await store.insert([{
      subject: `urn:dkg:share:${CONTEXT_GRAPH}:${OPERATION_ID}`,
      predicate: 'http://dkg.io/ontology/contentScopeVersion',
      object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: metaGraph,
    }]);
    const corrupt = await resolve().catch((error: unknown) => error);
    expect(corrupt).toBeInstanceOf(Error);
    expect(corrupt).not.toBeInstanceOf(KnowledgeAssetOperationPublicSnapshotNotFoundError);
    expect((corrupt as Error).message).toContain('metadata is corrupt');

    const outage = new Error('snapshot metadata store unavailable');
    const query = vi.spyOn(store, 'query').mockRejectedValueOnce(outage);
    await expect(resolve()).rejects.toBe(outage);
    query.mockRestore();
  });

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

  it('rejects an unsafe snapshot graph as corruption, not absence', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: OPERATION_ID,
      kaUal: UAL,
      assertionVersion: 1,
      quads: [{
        subject: 'urn:entity:unsafe-snapshot',
        predicate: 'urn:predicate:value',
        object: '"value"',
        graph: '',
      }],
    });

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    const subject = `urn:dkg:share:${CONTEXT_GRAPH}:${OPERATION_ID}`;
    const predicate = 'http://dkg.io/ontology/publicSnapshotGraph';
    await store.deleteByPattern({ graph: metaGraph, subject, predicate });
    await store.insert([{
      subject,
      predicate,
      object: '"unsafe snapshot graph"',
      graph: metaGraph,
    }]);

    const error = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: OPERATION_ID,
      kaUal: UAL,
      assertionVersion: 1,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(KnowledgeAssetOperationPublicSnapshotNotFoundError);
    expect((error as Error).message).toContain('unsafe snapshot graph');
  });
});
