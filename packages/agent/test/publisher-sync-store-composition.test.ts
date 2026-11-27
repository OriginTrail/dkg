import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANGELOG_GRAPH, ChangelogStore, GraphSetIndexStore, OxigraphStore,
  SharedMemoryLiteralBlobStore, type Quad,
} from '@origintrail-official/dkg-storage';
import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';

const control = 'urn:publication/_shared_memory';
const data = 'urn:recovered/_shared_memory';
const metadata = 'urn:recovered:meta';
const quad = (graph: string, subject: string, value: string): Quad =>
  ({ graph, subject, predicate: 'urn:value', object: JSON.stringify(value) });

describe('publisher and sync writes through the composed agent store', () => {
  it.each([true, false])('keeps both commits queryable and indexed (sync queued first: %s)', async syncFirst => {
    const directory = await mkdtemp(join(tmpdir(), 'publisher-sync-store-'));
    const raw = new OxigraphStore();
    const index = new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(raw, {
      blobDir: directory, thresholdBytes: 16,
    }));
    const log = new ChangelogStore(index);
    const invalidate = vi.fn();
    const store = createListContextGraphsCacheInvalidatingStore(log, invalidate);
    const job = quad(control, 'urn:job', 'accepted publication '.repeat(8));
    const request = quad(control, 'urn:request', 'immutable request '.repeat(8));
    const recovered = quad(data, 'urn:entity', 'verified assertion '.repeat(8));
    const asset = { graphUri: data, graphQuads: [recovered], metaGraphUri: metadata,
      metadataSubject: 'urn:asset', metadataQuads: [quad(metadata, 'urn:asset', 'confirmed')] };
    const options = { signal: new AbortController().signal, priority: 'background' as const };
    try {
      await store.insert([quad(control, 'urn:job', 'old'), quad(data, 'urn:entity', 'old')]);
      await store.listGraphs(); // Seed the index before either replacement.
      invalidate.mockClear();
      const publish = () => store.replaceSubjectAndInsert!(control, 'urn:job', [job], [request],
        { ...options, source: 'publisher.asyncLift.writeJob' });
      const sync = () => store.replaceAssetGroup!([asset],
        { ...options, source: 'agent.durableSync.graphScopedMaterialization' });
      await Promise.all(syncFirst ? [sync(), publish()] : [publish(), sync()]);
      expect(invalidate).toHaveBeenCalledTimes(2);
      const result = await store.query(`SELECT ?s ?o WHERE { GRAPH ?g { ?s <urn:value> ?o }
        FILTER(?g IN (<${control}>, <${data}>, <${metadata}>)) } ORDER BY ?s`,
      { priority: 'normal', source: 'api.query', signal: options.signal });
      expect(result).toEqual({ type: 'bindings', bindings: [
        { s: 'urn:asset', o: '"confirmed"' }, { s: 'urn:entity', o: recovered.object },
        { s: 'urn:job', o: job.object }, { s: 'urn:request', o: request.object },
      ] });
      expect((await store.listGraphs()).sort()).toEqual([control, data, metadata].sort());
      expect(await log.graphEnumerationVisibility!(CHANGELOG_GRAPH)).toBe(false);
      expect(log.needsReconcile).toBe(false);
      expect((await log.readChanges(0, 100)).map(change => change.graph))
        .toEqual(expect.arrayContaining([control, data, metadata]));
      // A reserved sync destination must be refused without disturbing either commit.
      await expect(store.replaceAssetGroup!([{ ...asset, metaGraphUri: CHANGELOG_GRAPH,
        metadataQuads: [quad(CHANGELOG_GRAPH, 'urn:asset', 'forged')] }], options))
        .rejects.toThrow(/reserved changelog plane/);
      expect(invalidate).toHaveBeenCalledTimes(3); // Conservative invalidation after an untagged refusal.
      expect(await store.query(`ASK { GRAPH <${control}> { <urn:request> <urn:value> ${request.object} }
        GRAPH <${data}> { <urn:entity> <urn:value> ${recovered.object} } }`))
        .toEqual({ type: 'boolean', value: true });
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
