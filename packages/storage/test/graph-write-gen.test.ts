/**
 * Per-graph write-generation tracking (#1609) — the storage half of the
 * chain-reconcile negative memo. The memo suppresses a reconcile rescan ONLY
 * while a stable `getWriteRevision(cgPrefix)` is unchanged, so the contract under test is
 * fail-open: every write that MAY touch a prefix must be visible to it
 * (scoped writes to matching graphs, unscoped bumps for raw UPDATEs and
 * pattern deletes without a graph, LRU-eviction folding), while writes to
 * unrelated graphs must NOT perturb it (else the memo never holds and #1609's
 * O(#ops)-per-sweep rescan storm returns).
 */
import { describe, it, expect } from 'vitest';
import {
  GraphWriteGenTracker,
  asGraphWriteGenSource,
  asGraphWriteRevisionSource,
  type GraphWriteGenSource,
} from '../src/graph-write-gen.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';

const CG_PREFIX = 'did:dkg:context-graph:fun-facts/';
const SWM_GRAPH = `${CG_PREFIX}_shared_memory`;
const SWM_META_GRAPH = `${CG_PREFIX}_shared_memory_meta`;
const OTHER_GRAPH = 'did:dkg:context-graph:other-cg/_shared_memory';

describe('GraphWriteGenTracker', () => {
  it('bumps matching prefixes on scoped writes and leaves unrelated prefixes alone', () => {
    const tracker = new GraphWriteGenTracker();
    const before = tracker.getWriteGen(CG_PREFIX);

    tracker.recordWrite({ kind: 'graphs', graphs: [OTHER_GRAPH] });
    expect(tracker.getWriteGen(CG_PREFIX)).toBe(before);

    tracker.recordWrite({ kind: 'graphs', graphs: [SWM_GRAPH] });
    const after = tracker.getWriteGen(CG_PREFIX);
    expect(after).toBeGreaterThan(before);
    // Stable while nothing else is written.
    expect(tracker.getWriteGen(CG_PREFIX)).toBe(after);
  });

  it('bumps every prefix on an unscoped write', () => {
    const tracker = new GraphWriteGenTracker();
    const cgBefore = tracker.getWriteGen(CG_PREFIX);
    const otherBefore = tracker.getWriteGen('did:dkg:context-graph:other-cg/');

    tracker.recordWrite({ kind: 'all' });
    expect(tracker.getWriteGen(CG_PREFIX)).toBeGreaterThan(cgBefore);
    expect(tracker.getWriteGen('did:dkg:context-graph:other-cg/')).toBeGreaterThan(otherBefore);
  });

  it('keeps default-graph writes invisible to named-graph prefixes', () => {
    const tracker = new GraphWriteGenTracker();
    const before = tracker.getWriteGen(CG_PREFIX);
    tracker.recordWrite({ kind: 'graphs', graphs: [''] });
    expect(tracker.getWriteGen(CG_PREFIX)).toBe(before);
    // ...but visible to the match-everything empty prefix.
    expect(tracker.getWriteGen('')).toBeGreaterThan(0);
  });

  it('exposes one stable global generation for all scoped and unscoped writes', () => {
    const tracker = new GraphWriteGenTracker();
    const initial = tracker.getWriteGen('');

    tracker.recordWrite({ kind: 'graphs', graphs: [SWM_GRAPH, OTHER_GRAPH] });
    const afterScoped = tracker.getWriteGen('');
    expect(afterScoped).toBeGreaterThan(initial);
    expect(tracker.getWriteGen('')).toBe(afterScoped);

    tracker.recordWrite({ kind: 'all' });
    expect(tracker.getWriteGen('')).toBeGreaterThan(afterScoped);
  });

  it('reports an indeterminate remote scope as observably unstable without mutating reads', () => {
    const tracker = new GraphWriteGenTracker();
    tracker.beginWrite({ kind: 'graphs', graphs: [SWM_GRAPH] }).indeterminate();

    const firstScoped = tracker.getWriteRevision(CG_PREFIX);
    expect(firstScoped.stable).toBe(false);
    expect(tracker.getWriteRevision(CG_PREFIX)).toEqual(firstScoped);
    const firstGlobal = tracker.getWriteRevision('');
    expect(firstGlobal.stable).toBe(false);
    expect(tracker.getWriteRevision('')).toEqual(firstGlobal);

    const unrelated = tracker.getWriteRevision('did:dkg:context-graph:unrelated/');
    expect(unrelated.stable).toBe(true);
    expect(tracker.getWriteRevision('did:dkg:context-graph:unrelated/')).toEqual(unrelated);
  });

  it('brackets an active remote write with stable generation changes', () => {
    const tracker = new GraphWriteGenTracker();
    const before = tracker.getWriteRevision(CG_PREFIX);

    const lifecycle = tracker.beginWrite({ kind: 'graphs', graphs: [SWM_GRAPH] });
    const pending = tracker.getWriteRevision(CG_PREFIX);
    expect(pending.generation).toBeGreaterThan(before.generation);
    expect(pending.stable).toBe(false);
    expect(tracker.getWriteRevision(CG_PREFIX)).toEqual(pending);

    lifecycle.settle();
    const settled = tracker.getWriteRevision(CG_PREFIX);
    expect(settled.generation).toBeGreaterThan(pending.generation);
    expect(settled.stable).toBe(true);
  });

  it('keeps overlapping scoped writes unstable until every lifecycle settles', () => {
    const tracker = new GraphWriteGenTracker();
    const first = tracker.beginWrite({ kind: 'graphs', graphs: [SWM_GRAPH] });
    const second = tracker.beginWrite({ kind: 'graphs', graphs: [SWM_GRAPH] });

    const bothPending = tracker.getWriteRevision(CG_PREFIX);
    expect(bothPending.stable).toBe(false);
    first.settle();
    const onePending = tracker.getWriteRevision(CG_PREFIX);
    expect(onePending.generation).toBeGreaterThan(bothPending.generation);
    expect(onePending.stable).toBe(false);

    second.settle();
    const settled = tracker.getWriteRevision(CG_PREFIX);
    expect(settled.generation).toBeGreaterThan(onePending.generation);
    expect(settled.stable).toBe(true);
  });

  it('makes every prefix unstable for unscoped pending and indeterminate writes', () => {
    const settledTracker = new GraphWriteGenTracker();
    const pending = settledTracker.beginWrite({ kind: 'all' });
    expect(settledTracker.getWriteRevision(CG_PREFIX).stable).toBe(false);
    expect(settledTracker.getWriteRevision('did:dkg:context-graph:other/').stable).toBe(false);
    pending.settle();
    expect(settledTracker.getWriteRevision(CG_PREFIX).stable).toBe(true);

    const indeterminateTracker = new GraphWriteGenTracker();
    const indeterminate = indeterminateTracker.beginWrite({ kind: 'all' });
    indeterminate.indeterminate();
    const revision = indeterminateTracker.getWriteRevision(CG_PREFIX);
    expect(revision.stable).toBe(false);
    expect(indeterminateTracker.getWriteRevision(CG_PREFIX)).toEqual(revision);
  });

  it('folds LRU-evicted graphs into the global floor (eviction can only force rescans)', () => {
    const tracker = new GraphWriteGenTracker();
    tracker.recordWrite({ kind: 'graphs', graphs: [SWM_GRAPH] });
    const observed = tracker.getWriteGen(CG_PREFIX);

    // Flood with enough distinct graphs to evict SWM_GRAPH from the LRU map.
    for (let i = 0; i < 8300; i++) {
      tracker.recordWrite({ kind: 'graphs', graphs: [`urn:flood:${i}`] });
    }
    // The evicted graph folded into the global floor: the prefix must NOT
    // keep reporting the old generation it can no longer prove unchanged —
    // a memo gated on it then rescans (fail-open) instead of going stale.
    expect(tracker.getWriteGen(CG_PREFIX)).toBeGreaterThan(observed);
  });
});

describe('OxigraphStore write-generation capability', () => {
  const quad = (graph: string, value = 'v') => ({
    subject: 'urn:e:1',
    predicate: 'http://ex.org/p',
    object: `"${value}"`,
    graph,
  });

  it('is recoverable via asGraphWriteGenSource on the bare adapter and through decorator chains', () => {
    const store = new OxigraphStore();
    expect(asGraphWriteGenSource(store)).not.toBeNull();
    const decorated = new ChangelogStore(
      new GraphSetIndexStore(
        new SharedMemoryLiteralBlobStore(store, {
          blobDir: 'unused-capability-test-dir',
          thresholdBytes: 1024,
        }),
      ),
    );
    // The configured decorator order and the daemon's hand-rolled forwarder
    // both expose the documented innerStore boundary.
    const forwarded = { innerStore: decorated };
    expect(asGraphWriteGenSource(forwarded)).not.toBeNull();
    expect(asGraphWriteRevisionSource(forwarded)).not.toBeNull();
    // Undocumented implementation fields are deliberately not traversed.
    expect(asGraphWriteGenSource({ inner: store })).toBeNull();
    expect(asGraphWriteGenSource({})).toBeNull();
    expect(asGraphWriteGenSource(null)).toBeNull();
  });

  it('preserves legacy getWriteGen discovery without fabricating a stable revision', () => {
    const legacy: GraphWriteGenSource = { getWriteGen: () => 42 };
    const decorated = { innerStore: { innerStore: legacy } };

    expect(asGraphWriteGenSource(decorated)?.getWriteGen(CG_PREFIX)).toBe(42);
    expect(asGraphWriteRevisionSource(decorated)).toBeNull();

    const revisionOnly = { getWriteRevision: () => ({ generation: 7, stable: false }) };
    expect(asGraphWriteRevisionSource(revisionOnly)?.getWriteRevision(CG_PREFIX)).toEqual({
      generation: 7,
      stable: false,
    });
    expect(asGraphWriteGenSource(revisionOnly)).toBeNull();
  });

  it('bumps the CG prefix on every mutation kind that can affect an SWM scan', async () => {
    const store = new OxigraphStore();
    const gen = () => store.getWriteGen(CG_PREFIX);

    let last = gen();
    await store.insert([quad(SWM_GRAPH)]);
    expect(gen()).toBeGreaterThan(last);

    last = gen();
    await store.delete([quad(SWM_GRAPH)]);
    expect(gen()).toBeGreaterThan(last);

    last = gen();
    await store.insert([quad(SWM_META_GRAPH)]);
    await store.deleteByPattern({ graph: SWM_META_GRAPH, subject: 'urn:e:1' });
    expect(gen()).toBeGreaterThan(last);

    last = gen();
    await store.insert([quad(SWM_GRAPH)]);
    await store.deleteBySubjectPrefix(SWM_GRAPH, 'urn:e:');
    expect(gen()).toBeGreaterThan(last);

    last = gen();
    await store.dropGraph(SWM_GRAPH);
    expect(gen()).toBeGreaterThan(last);

    // Raw UPDATE: write scope unknowable → unscoped bump hits every prefix.
    last = gen();
    await store.update(`INSERT DATA { GRAPH <${OTHER_GRAPH}> { <urn:e:2> <http://ex.org/p> "x" } }`);
    expect(gen()).toBeGreaterThan(last);
  });

  it('does not bump the CG prefix on scoped writes to other graphs or on reads', async () => {
    const store = new OxigraphStore();
    await store.insert([quad(SWM_GRAPH)]);
    const before = store.getWriteGen(CG_PREFIX);

    await store.insert([quad(OTHER_GRAPH)]);
    await store.delete([quad(OTHER_GRAPH)]);
    await store.deleteByPattern({ graph: OTHER_GRAPH });
    await store.query(`ASK { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`);
    await store.listGraphs();
    await store.countQuads(SWM_GRAPH);

    expect(store.getWriteGen(CG_PREFIX)).toBe(before);
  });
});
