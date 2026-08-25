/**
 * Per-graph write-generation tracking (#1609) — the storage half of the
 * chain-reconcile negative memo. The memo suppresses a reconcile rescan ONLY
 * while `getWriteGen(cgPrefix)` is unchanged, so the contract under test is
 * fail-open: every write that MAY touch a prefix must be visible to it
 * (scoped writes to matching graphs, unscoped bumps for raw UPDATEs and
 * pattern deletes without a graph, LRU-eviction folding), while writes to
 * unrelated graphs must NOT perturb it (else the memo never holds and #1609's
 * O(#ops)-per-sweep rescan storm returns).
 */
import { describe, it, expect } from 'vitest';
import { GraphWriteGenTracker, asGraphWriteGenSource } from '../src/graph-write-gen.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';

const CG_PREFIX = 'did:dkg:context-graph:fun-facts/';
const SWM_GRAPH = `${CG_PREFIX}_shared_memory`;
const SWM_META_GRAPH = `${CG_PREFIX}_shared_memory_meta`;
const OTHER_GRAPH = 'did:dkg:context-graph:other-cg/_shared_memory';

describe('GraphWriteGenTracker', () => {
  it('bumps matching prefixes on scoped writes and leaves unrelated prefixes alone', () => {
    const tracker = new GraphWriteGenTracker();
    const before = tracker.getWriteGen(CG_PREFIX);

    tracker.recordGraphWrites([OTHER_GRAPH]);
    expect(tracker.getWriteGen(CG_PREFIX)).toBe(before);

    tracker.recordGraphWrites([SWM_GRAPH]);
    const after = tracker.getWriteGen(CG_PREFIX);
    expect(after).toBeGreaterThan(before);
    // Stable while nothing else is written.
    expect(tracker.getWriteGen(CG_PREFIX)).toBe(after);
  });

  it('bumps every prefix on an unscoped write', () => {
    const tracker = new GraphWriteGenTracker();
    const cgBefore = tracker.getWriteGen(CG_PREFIX);
    const otherBefore = tracker.getWriteGen('did:dkg:context-graph:other-cg/');

    tracker.recordUnscopedWrite();
    expect(tracker.getWriteGen(CG_PREFIX)).toBeGreaterThan(cgBefore);
    expect(tracker.getWriteGen('did:dkg:context-graph:other-cg/')).toBeGreaterThan(otherBefore);
  });

  it('keeps default-graph writes invisible to named-graph prefixes', () => {
    const tracker = new GraphWriteGenTracker();
    const before = tracker.getWriteGen(CG_PREFIX);
    tracker.recordGraphWrites(['']);
    expect(tracker.getWriteGen(CG_PREFIX)).toBe(before);
    // ...but visible to the match-everything empty prefix.
    expect(tracker.getWriteGen('')).toBeGreaterThan(0);
  });

  it('exposes one stable global generation for all scoped and unscoped writes', () => {
    const tracker = new GraphWriteGenTracker();
    const initial = tracker.getWriteGen('');

    tracker.recordGraphWrites([SWM_GRAPH, OTHER_GRAPH]);
    const afterScoped = tracker.getWriteGen('');
    expect(afterScoped).toBeGreaterThan(initial);
    expect(tracker.getWriteGen('')).toBe(afterScoped);

    tracker.recordUnscopedWrite();
    expect(tracker.getWriteGen('')).toBeGreaterThan(afterScoped);
  });

  it('never stabilizes affected generations after an indeterminate remote write', () => {
    const tracker = new GraphWriteGenTracker();
    tracker.recordIndeterminateGraphWrites([SWM_GRAPH]);

    const firstScoped = tracker.getWriteGen(CG_PREFIX);
    expect(tracker.getWriteGen(CG_PREFIX)).toBeGreaterThan(firstScoped);
    const firstGlobal = tracker.getWriteGen('');
    expect(tracker.getWriteGen('')).toBeGreaterThan(firstGlobal);

    const unrelated = tracker.getWriteGen('did:dkg:context-graph:unrelated/');
    expect(tracker.getWriteGen('did:dkg:context-graph:unrelated/')).toBe(unrelated);
  });

  it('folds LRU-evicted graphs into the global floor (eviction can only force rescans)', () => {
    const tracker = new GraphWriteGenTracker();
    tracker.recordGraphWrites([SWM_GRAPH]);
    const observed = tracker.getWriteGen(CG_PREFIX);

    // Flood with enough distinct graphs to evict SWM_GRAPH from the LRU map.
    for (let i = 0; i < 8300; i++) {
      tracker.recordGraphWrites([`urn:flood:${i}`]);
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
    // `.innerStore` forwarder (daemon wrapper shape) and `.inner` decorator shape.
    expect(asGraphWriteGenSource({ innerStore: { inner: store } })).not.toBeNull();
    expect(asGraphWriteGenSource({})).toBeNull();
    expect(asGraphWriteGenSource(null)).toBeNull();
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
