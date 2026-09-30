import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { ChangelogStore, CHANGELOG_GRAPH } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../src/atomic-graph-replace.js';
import { loadSelectedSharedMemoryQuads } from '../src/graph-manager.js';
import { asReadSnapshotCapability, type ReadSnapshotStore } from '../src/read-snapshot-capability.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import type { Quad, TripleStore } from '../src/triple-store.js';

it('preserves every read decorator over a large pinned SWM family', async () => {
  const inner = new OxigraphStore();
  const blobDir = await mkdtemp(join(tmpdir(), 'dkg-snapshot-decorator-'));
  const swm = contextGraphSharedMemoryUri('snapshot-decorator-unit');
  const root = 'urn:snapshot-decorator:root';
  const predicate = 'urn:snapshot-decorator:predicate';
  const graphs = Array.from({ length: 130 }, (_, i) =>
    `${swm}/0xabcdef0123456789abcdef0123456789abcdef01/${String(i + 1).padStart(3, '0')}`);
  const decoys: Quad[] = graphs.map((graph, i) => ({
    subject: `urn:snapshot-decorator:decoy:${i}`, predicate, object: '"decoy"', graph,
  }));
  const large: Quad = {
    subject: root, predicate, object: `"${'hydrate-me-'.repeat(12)}"`, graph: graphs[129]!,
  };
  const snapshotQuery = vi.fn(inner.query.bind(inner));
  const withReadSnapshot = vi.fn(async <T>(read: (snapshot: ReadSnapshotStore) => Promise<T>): Promise<T> =>
    read({
      query: snapshotQuery,
      listGraphs: inner.listGraphs.bind(inner),
      listGraphsByPrefix: async (prefix, options) =>
        (await inner.listGraphs(options)).filter((graph) => graph.startsWith(prefix)),
    }));
  Object.assign(inner, { withReadSnapshot });
  const blob = new SharedMemoryLiteralBlobStore(inner, { blobDir, thresholdBytes: 16 });
  const decorated = new ChangelogStore(new GraphSetIndexStore(blob));
  try {
    await inner.insert(decoys);
    await blob.insert([large]);
    expect(asReadSnapshotCapability(decorated)).not.toBeNull();
    for (const options of [
      undefined,
      { resultBudget: { pageRows: 1, maxRows: 1, maxBytesEstimate: 1024 * 1024 } },
    ]) {
      const result = await loadSelectedSharedMemoryQuads(
        decorated, swm, { rootEntities: [root] }, options,
      );
      expect(result).toMatchObject([{ subject: root, predicate, object: large.object }]);
    }
    expect(withReadSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshotQuery).toHaveBeenCalled();

    // An unadapted future decorator must choose one ordinary query, never
    // silently skip itself by traversing to the inner snapshot capability.
    const unadapted = { innerStore: decorated } as unknown as TripleStore;
    expect(asReadSnapshotCapability(unadapted)).toBeNull();
  } finally {
    await inner.close();
    await rm(blobDir, { recursive: true, force: true });
  }
});

it('keeps the changelog graph hidden through a pinned read facade', async () => {
  const visible = 'urn:dkg:visible';
  const graphs = [visible, CHANGELOG_GRAPH];
  const inner = {
    withReadSnapshot: async <T>(read: (snapshot: ReadSnapshotStore) => Promise<T>) => read({
      query: async () => ({ type: 'bindings', bindings: [] }) as never,
      listGraphs: async () => graphs,
      listGraphsByPrefix: async (prefix) => graphs.filter((graph) => graph.startsWith(prefix)),
    }),
  } as unknown as TripleStore;
  const snapshot = asReadSnapshotCapability(new ChangelogStore(inner));
  expect(snapshot).not.toBeNull();
  await snapshot!.withReadSnapshot(async (read) => {
    expect(await read.listGraphs()).toEqual([visible]);
    expect(await read.listGraphsByPrefix!('urn:dkg:')).toEqual([visible]);
    expect(await read.listGraphsByPrefix!('urn:dkg:changelog')).toEqual([]);
  });
});

it('keeps atomic replacement staging graphs hidden through a pinned index facade', async () => {
  const visible = 'urn:dkg:visible';
  const staging = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}orphan`;
  const graphs = [visible, staging];
  const inner = {
    withReadSnapshot: async <T>(read: (snapshot: ReadSnapshotStore) => Promise<T>) => read({
      query: async () => ({ type: 'bindings', bindings: [] }) as never,
      listGraphs: async () => graphs,
      listGraphsByPrefix: async (prefix) => graphs.filter((graph) => graph.startsWith(prefix)),
    }),
  } as unknown as TripleStore;
  const snapshot = asReadSnapshotCapability(new GraphSetIndexStore(inner));
  expect(snapshot).not.toBeNull();
  await snapshot!.withReadSnapshot(async (read) => {
    expect(await read.listGraphs()).toEqual([visible]);
    expect(await read.listGraphsByPrefix!('urn:')).toEqual([visible]);
    expect(await read.listGraphsByPrefix!(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX)).toEqual([]);
  });
});
