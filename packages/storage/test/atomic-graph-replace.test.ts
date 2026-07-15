import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  ChangelogStore,
  EXTERNAL_LITERAL_REF_DATATYPE,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SharedMemoryLiteralBlobStore,
  buildAtomicGraphReplaceUpdate,
  tryReplaceGraphAtomically,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '../src/index.js';

const TARGET = 'did:dkg:context-graph:atomic/_shared_memory/0xabc/7';
const OTHER = 'urn:test:unrelated';

function quad(subject: string, object: string, graph = TARGET): Quad {
  return {
    subject,
    predicate: 'urn:test:value',
    object,
    graph,
  };
}

/** Delegate every op to `base` (bound there, so its own state stays coherent)
 *  except the injected overrides. */
function overrideStore(base: TripleStore, overrides: Partial<TripleStore>): TripleStore {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in overrides) {
        return (overrides as Record<string | symbol, unknown>)[prop];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TripleStore;
}

describe('atomic named-graph replacement', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('replaces the complete target graph without touching unrelated graphs', async () => {
    const store = new OxigraphStore();
    await store.insert([
      quad('urn:old:1', '"old-1"'),
      quad('urn:old:2', '"old-2"'),
      quad('urn:other', '"keep"', OTHER),
    ]);

    await expect(tryReplaceGraphAtomically(store, TARGET, [
      quad('urn:new:1', '"new-1"'),
      quad('urn:new:2', '"new-2"'),
    ])).resolves.toBe(true);

    const target = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${TARGET}> { ?s <urn:test:value> ?o } } ORDER BY ?s`,
    );
    expect(target.type).toBe('bindings');
    if (target.type !== 'bindings') throw new Error('expected bindings');
    expect(target.bindings).toEqual([
      { s: 'urn:new:1', o: '"new-1"' },
      { s: 'urn:new:2', o: '"new-2"' },
    ]);
    expect(await store.countQuads(OTHER)).toBe(1);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);

    await expect(tryReplaceGraphAtomically(store, TARGET, [])).resolves.toBe(true);
    expect(await store.hasGraph(TARGET)).toBe(false);
    expect(await store.countQuads(OTHER)).toBe(1);
  });

  it('externalizes per-KA SWM literals and emits only the canonical changelog graph', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-atomic-graph-blobs-'));
    tempDirs.push(blobDir);
    const raw = new OxigraphStore();
    const blobs = new SharedMemoryLiteralBlobStore(raw, {
      blobDir,
      thresholdBytes: 20,
    });
    const indexed = new GraphSetIndexStore(blobs, { revalidateMs: 60_000 });
    const records: Array<{ graph: string; op: string }> = [];
    const store = new ChangelogStore(indexed, {
      onAppend: ({ graph, op }) => records.push({ graph, op }),
    });
    const largeLiteral = `"${'rootless-large-literal'.repeat(8)}"`;

    await expect(tryReplaceGraphAtomically(store, TARGET, [
      quad('urn:new:large', largeLiteral),
    ])).resolves.toBe(true);

    const hydrated = await store.query(
      `SELECT ?o WHERE { GRAPH <${TARGET}> { <urn:new:large> <urn:test:value> ?o } }`,
    );
    expect(hydrated.type).toBe('bindings');
    if (hydrated.type !== 'bindings') throw new Error('expected bindings');
    expect(hydrated.bindings).toEqual([{ o: largeLiteral }]);

    const stored = await raw.query(
      `SELECT ?o WHERE { GRAPH <${TARGET}> { <urn:new:large> <urn:test:value> ?o } }`,
    );
    expect(stored.type).toBe('bindings');
    if (stored.type !== 'bindings') throw new Error('expected bindings');
    expect(stored.bindings[0]?.o).toMatch(
      new RegExp(`^"sha256:[0-9a-f]{64}"\\^\\^<${EXTERNAL_LITERAL_REF_DATATYPE}>$`),
    );
    expect(records).toEqual([{ graph: TARGET, op: 'upsert' }]);
    expect(await store.listGraphs()).toContain(TARGET);
    expect((await store.listGraphs()).some(
      (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
    )).toBe(false);

    await store.replaceGraph!(TARGET, []);
    expect(records).toEqual([
      { graph: TARGET, op: 'upsert' },
      { graph: TARGET, op: 'drop' },
    ]);
  });

  it('replaces the complete graph through the worker-backed adapter', async () => {
    // Regression: the worker RPC method, argument serialization, and client
    // write-generation bookkeeping for replaceGraph are only exercised here.
    // Needs the compiled worker artifact — run
    // `pnpm --filter @origintrail-official/dkg-storage build` first.
    const store = new OxigraphWorkerStore();
    try {
      await store.insert([
        quad('urn:old:1', '"old-1"'),
        quad('urn:old:2', '"old-2"'),
        quad('urn:other', '"keep"', OTHER),
      ]);

      await expect(tryReplaceGraphAtomically(store, TARGET, [
        quad('urn:new:1', '"new-1"'),
      ])).resolves.toBe(true);

      const target = await store.query(
        `SELECT ?s ?o WHERE { GRAPH <${TARGET}> { ?s <urn:test:value> ?o } }`,
      );
      expect(target.type).toBe('bindings');
      if (target.type !== 'bindings') throw new Error('expected bindings');
      expect(target.bindings).toEqual([{ s: 'urn:new:1', o: '"new-1"' }]);
      expect(await store.countQuads(OTHER)).toBe(1);
      expect((await store.listGraphs()).some(
        (graph) => graph.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX),
      )).toBe(false);

      await expect(tryReplaceGraphAtomically(store, TARGET, [])).resolves.toBe(true);
      expect(await store.hasGraph(TARGET)).toBe(false);
    } finally {
      await store.close().catch(() => {});
    }
  });

  it('flags reconcile when replaceGraph fails after the backend may have committed', async () => {
    // The contract allows a rejected call to have left either the complete old
    // or the complete new graph (e.g. HTTP response lost after commit). A
    // committed overwrite with no marker would be a permanent delta-sync gap.
    const base = new OxigraphStore();
    const inner = overrideStore(base, {
      replaceGraph: async (graphUri: string, quads: Quad[], options?: QueryOptions) => {
        await base.replaceGraph!(graphUri, quads, options); // backend committed…
        throw new Error('response lost after commit');       // …but the caller sees failure
      },
    });
    const log = new ChangelogStore(inner);
    await log.insert([quad('urn:old:1', '"old-1"')]);
    expect(log.needsReconcile).toBe(false);
    const seqBefore = await log.headSeq();

    await expect(
      log.replaceGraph!(TARGET, [quad('urn:new:1', '"new-1"')]),
    ).rejects.toThrow(/response lost/);

    expect(await log.hasGraph(TARGET)).toBe(true); // the commit really landed
    expect(await log.headSeq()).toBe(seqBefore);   // …and no marker recorded it
    expect(log.needsReconcile).toBe(true);         // so the gap must be flagged
    await base.close();
  });

  it('flags reconcile when the post-replacement presence probe fails', async () => {
    // The replacement committed; if the hasGraph probe then fails, the marker
    // can never be written — the same committed-but-unlogged gap.
    const base = new OxigraphStore();
    let failProbes = false;
    const inner = overrideStore(base, {
      hasGraph: async (graphUri: string, options?: QueryOptions) => {
        if (failProbes) throw new Error('injected probe failure');
        return base.hasGraph(graphUri, options);
      },
    });
    const log = new ChangelogStore(inner);
    await log.insert([quad('urn:old:1', '"old-1"')]);
    expect(log.needsReconcile).toBe(false);

    failProbes = true;
    await expect(
      log.replaceGraph!(TARGET, [quad('urn:new:1', '"new-1"')]),
    ).rejects.toThrow(/injected probe failure/);
    failProbes = false;

    expect(log.needsReconcile).toBe(true);
    const target = await log.query(
      `SELECT ?o WHERE { GRAPH <${TARGET}> { <urn:new:1> <urn:test:value> ?o } }`,
    );
    expect(target.type).toBe('bindings');
    if (target.type !== 'bindings') throw new Error('expected bindings');
    expect(target.bindings).toEqual([{ o: '"new-1"' }]); // replacement committed
    await base.close();
  });

  it('fails closed for unsupported stores and malformed replacement payloads', async () => {
    const unsupported = {} as TripleStore;
    await expect(
      tryReplaceGraphAtomically(unsupported, TARGET, [quad('urn:s', '"v"')]),
    ).resolves.toBe(false);

    expect(() => buildAtomicGraphReplaceUpdate(TARGET, [
      quad('urn:s', '"v"', OTHER),
    ])).toThrow(/targets.*instead/i);
    expect(() => buildAtomicGraphReplaceUpdate(TARGET, [{
      subject: '_:b0',
      predicate: 'urn:test:value',
      object: '"v"',
      graph: TARGET,
    }])).toThrow(/canonical skolem IRIs/i);
  });
});
