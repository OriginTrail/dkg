/**
 * #1963/#2079 — bounded materialization validation against a REAL OxigraphStore.
 *
 * The in-memory memo is a measurement this materializer already took. These
 * rows pin the boundaries that make skipping both full queries safe:
 *
 *   1. warm unchanged checks do neither COUNT nor CONSTRUCT;
 *   2. local mutation, expiry, restart and a missing revision source all force
 *      exact validation;
 *   3. digest/count changes and failed validation never produce a cache hit.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
  invalidateSwmMaterializationWitness,
  SWM_MATERIALIZATION_WITNESS_GRAPH,
} from '@origintrail-official/dkg-storage';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';

const GRAPH = 'did:dkg:context-graph:witness-cg/ka/1';

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
});

function newStore(): OxigraphStore {
  const s = new OxigraphStore();
  stores.push(s);
  return s;
}

/** N payload quads with a marker, so two versions can share a quad COUNT. */
function payload(marker: string, count: number): Quad[] {
  return Array.from({ length: count }, (_, i) => ({
    subject: `urn:snap:${marker}:${i}`,
    predicate: 'http://schema.org/status',
    object: `"${marker}"`,
    graph: '',
  }));
}

function descriptorFor(quads: Quad[], assertionGraph = GRAPH) {
  return {
    assertionGraph,
    publicQuadsCount: quads.length,
    publicQuadsDigest: workspacePublicQuadsDigest(quads),
  } as never;
}

/** Counts both exact validation queries so the warm path is directly observable. */
function countingStore(inner: TripleStore) {
  let constructs = 0;
  let counts = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sparql: string, options?: unknown) => {
          if (sparql.trimStart().startsWith('CONSTRUCT')) constructs += 1;
          if (sparql.includes('SELECT (COUNT(*) AS ?n)')) counts += 1;
          return (target as TripleStore).query(sparql, options as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as TripleStore;
  return { store: proxy, constructs: () => constructs, counts: () => counts };
}

describe('#2079 witness module', () => {
  it('reads back only for the digest it was written with', async () => {
    const store = newStore();
    expect(await writeSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(true);
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(true);
    // A different digest must MISS. This is what makes an equal-count version
    // change safe without relying on anyone remembering to invalidate.
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:bbb')).toBe(false);
  });

  it('EVICTS the previous claim rather than accumulating', async () => {
    const store = newStore();
    await writeSwmMaterializationWitness(store, GRAPH, 'sha256:aaa');
    await writeSwmMaterializationWitness(store, GRAPH, 'sha256:bbb');
    // If the write appended instead of replacing the subject, the OLD digest
    // would still read true — a standing lie about content that is gone.
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(false);
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:bbb')).toBe(true);
  });

  it('invalidate removes the claim', async () => {
    const store = newStore();
    await writeSwmMaterializationWitness(store, GRAPH, 'sha256:aaa');
    await invalidateSwmMaterializationWitness(store, GRAPH);
    expect(await readSwmMaterializationWitness(store, GRAPH, 'sha256:aaa')).toBe(false);
  });

  it('lives outside every context-graph prefix', () => {
    // The chain-reset wipe and the sync responder both scope on the CG prefix;
    // a witness inside it would be served to peers and wiped as CG content.
    expect(SWM_MATERIALIZATION_WITNESS_GRAPH.startsWith('urn:dkg:local:')).toBe(true);
    expect(SWM_MATERIALIZATION_WITNESS_GRAPH.includes('did:dkg:context-graph:')).toBe(false);
  });
});

describe('#1963 isGraphAssetMaterialized validation memo', () => {
  it('avoids 75% of full queries across four unchanged passes', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const descriptor = descriptorFor(quads);

    for (let pass = 0; pass < 4; pass += 1) {
      expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    }

    expect([counted.counts(), counted.constructs()]).toEqual([1, 1]);
    const fullQueryReduction = 1 - ((counted.counts() + counted.constructs()) / (4 * 2));
    expect(fullQueryReduction).toBe(0.75);
  });

  it('expires a warm validation and performs both exact queries again', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    let now = 1_000;
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
      validationMemo: { ttlMs: 50, now: () => now },
    });
    const descriptor = descriptorFor(quads);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    now += 49;
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([1, 1]);

    now += 1;
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('forces exact validation for a new materializer runtime', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const descriptor = descriptorFor(quads);

    const first = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    expect(await first.isGraphAssetMaterialized(descriptor)).toBe(true);

    const restarted = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    expect(await restarted.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('forces exact validation after a local graph mutation', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });

    expect(await mat.isGraphAssetMaterialized(descriptorFor(v1))).toBe(true);
    await inner.replaceGraph(GRAPH, v2.map((q) => ({ ...q, graph: GRAPH })));
    expect(await mat.isGraphAssetMaterialized(descriptorFor(v2))).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('does not reuse an entry after its own successful graph replacement', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });

    expect(await mat.isGraphAssetMaterialized(descriptorFor(v1))).toBe(true);
    await mat.replaceGraph(GRAPH, v2.map((q) => ({ ...q, graph: GRAPH })));
    expect(await mat.isGraphAssetMaterialized(descriptorFor(v2))).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('cannot hit an older entry after expected digest or count changes', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const d1 = descriptorFor(v1);

    expect(await mat.isGraphAssetMaterialized(d1)).toBe(true);
    expect(await mat.isGraphAssetMaterialized(descriptorFor(v2))).toBe(false);
    expect(await mat.isGraphAssetMaterialized({
      ...d1,
      publicQuadsCount: d1.publicQuadsCount + 1,
    })).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([3, 2]);

    expect(await mat.isGraphAssetMaterialized(d1)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([4, 3]);
  });

  it('never caches a failed digest validation', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const mismatched = descriptorFor(v2);

    expect(await mat.isGraphAssetMaterialized(mismatched)).toBe(false);
    expect(await mat.isGraphAssetMaterialized(mismatched)).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('preserves the existing operator switch for disabling validation memoization', async () => {
    const previous = process.env['DKG_SWM_MATERIALIZATION_WITNESS'];
    process.env['DKG_SWM_MATERIALIZATION_WITNESS'] = '0';
    try {
      const inner = newStore();
      const quads = payload('v1', 6);
      await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
      const counted = countingStore(inner);
      const mat = createSharedMemorySnapshotMaterializer({
        store: counted.store,
        writeLocks: new Map<string, Promise<void>>(),
        invalidateListContextGraphsCache: () => {},
      });
      const descriptor = descriptorFor(quads);

      expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
      expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
      expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
    } finally {
      if (previous === undefined) delete process.env['DKG_SWM_MATERIALIZATION_WITNESS'];
      else process.env['DKG_SWM_MATERIALIZATION_WITNESS'] = previous;
    }
  });

  it('validates every time when the store exposes no write revision', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const withoutRevision = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'getWriteRevision' || prop === 'writeRevisionCoverage') return undefined;
        return Reflect.get(target, prop, receiver);
      },
    }) as TripleStore;
    const counted = countingStore(withoutRevision);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const descriptor = descriptorFor(quads);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('evicts the least recently used entry at the configured bound', async () => {
    const inner = newStore();
    const graphA = GRAPH + ':a';
    const graphB = GRAPH + ':b';
    const quadsA = payload('a', 3);
    const quadsB = payload('b', 3);
    await inner.replaceGraph(graphA, quadsA.map((q) => ({ ...q, graph: graphA })));
    await inner.replaceGraph(graphB, quadsB.map((q) => ({ ...q, graph: graphB })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
      validationMemo: { maxEntries: 1 },
    });

    expect(await mat.isGraphAssetMaterialized(descriptorFor(quadsA, graphA))).toBe(true);
    expect(await mat.isGraphAssetMaterialized(descriptorFor(quadsB, graphB))).toBe(true);
    expect(await mat.isGraphAssetMaterialized(descriptorFor(quadsA, graphA))).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([3, 3]);
  });

  it('does not certify a graph dropped after validation', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((q) => ({ ...q, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = createSharedMemorySnapshotMaterializer({
      store: counted.store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });
    const descriptor = descriptorFor(quads);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    await inner.dropGraph(GRAPH);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 1]);
  });
});
