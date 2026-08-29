/**
 * #1938 — the shared atomic-replace/fallback writer both persistent publisher control-plane
 * queues (async-lift #1863/#1919 and async-promote #1933) route their mutable-subject writes
 * through. These tests pin the helper's ORCHESTRATION directly (independent of either queue):
 *  - an atomic-capable store routes through `replaceSubject` (never a control-graph delete);
 *  - a store with no `replaceSubject`, or one that refuses it, takes the BOUNDED
 *    delete-then-insert fallback;
 *  - the fallback delete is scoped to EXACTLY the target subject (never widens to a
 *    co-located subject in the same graph — the invariant the lift queue's immutable request
 *    row and the promote queue's single-subject write both depend on).
 * Internal commit atomicity of `replaceSubject` is a storage-layer concern, proven there.
 */

import { describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { replaceSubjectAtomicallyOrFallback } from '../src/subject-atomic-write.js';

const GRAPH = 'urn:test:subject-atomic-write';
const SUBJECT = 'urn:test:subject-atomic-write:subject';
const PRED = 'urn:test:subject-atomic-write:pred';

function quad(subject: string, object: string, graph = GRAPH): Quad {
  return { subject, predicate: PRED, object, graph };
}

async function objectsFor(store: OxigraphStore, subject: string): Promise<string[]> {
  const result = await store.query(`SELECT ?o WHERE { GRAPH <${GRAPH}> { <${subject}> <${PRED}> ?o } }`);
  return result.type === 'bindings' ? result.bindings.map((b) => b['o']!).sort() : [];
}

/**
 * Wrap a real OxigraphStore, counting `replaceSubject` calls and control-graph
 * `deleteByPattern` calls. `mode` selects the capability behaviour (mirrors the per-queue
 * atomicity suites): `real` delegates to the real atomic replace; `absent` exposes no
 * capability; `refuse` raises a clean capability refusal (best-effort SparqlHttpStore).
 */
function countingStore(
  inner: OxigraphStore,
  mode: 'real' | 'absent' | 'refuse',
): { store: TripleStore; counts: { replaceSubject: number; graphDeletes: number } } {
  const counts = { replaceSubject: 0, graphDeletes: 0 };
  type RealStore = {
    replaceSubject: (g: string, s: string, q: unknown, o?: unknown) => Promise<void>;
    deleteByPattern: (p: unknown, o?: unknown) => Promise<unknown>;
  };
  const store = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'replaceSubject') {
        if (mode === 'absent') return undefined;
        return async (g: string, s: string, q: unknown, o?: unknown) => {
          counts.replaceSubject++;
          if (mode === 'refuse') {
            throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'SparqlHttpStore');
          }
          return (target as unknown as RealStore).replaceSubject(g, s, q, o);
        };
      }
      if (prop === 'deleteByPattern') {
        return async (pattern: { graph?: string }, o?: unknown) => {
          if (pattern?.graph === GRAPH) counts.graphDeletes++;
          return (target as unknown as RealStore).deleteByPattern(pattern, o);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as TripleStore;
  return { store, counts };
}

describe('#1938 replaceSubjectAtomicallyOrFallback', () => {
  it('routes an atomic-capable store through replaceSubject, never a delete', async () => {
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    await inner.insert([quad(SUBJECT, '"old"')]);
    const { store, counts } = countingStore(inner, 'real');

    await replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [quad(SUBJECT, '"new"')], 'test.source');

    expect(counts.replaceSubject).toBe(1);
    expect(counts.graphDeletes).toBe(0);
    // replaceSubject fully replaces the subject: the prior value is gone, the new one present.
    expect(await objectsFor(inner, SUBJECT)).toEqual(['"new"']);
  });

  it('falls back to delete-then-insert when the store has no replaceSubject capability', async () => {
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    await inner.insert([quad(SUBJECT, '"old"')]);
    const { store, counts } = countingStore(inner, 'absent');

    await replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [quad(SUBJECT, '"new"')], 'test.source');

    expect(counts.replaceSubject).toBe(0);
    expect(counts.graphDeletes).toBeGreaterThan(0);
    // The fallback still replaces: delete removes the old value, insert writes the new.
    expect(await objectsFor(inner, SUBJECT)).toEqual(['"new"']);
  });

  it('falls back when the store implements replaceSubject but refuses it (non-atomic backend)', async () => {
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    const { store, counts } = countingStore(inner, 'refuse');

    await replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [quad(SUBJECT, '"new"')], 'test.source');

    // The capability was attempted (and refused), then the bounded fallback ran.
    expect(counts.replaceSubject).toBe(1);
    expect(counts.graphDeletes).toBeGreaterThan(0);
    expect(await objectsFor(inner, SUBJECT)).toEqual(['"new"']);
  });

  it('the fallback delete is scoped to EXACTLY the target subject (a co-located subject survives)', async () => {
    const sibling = 'urn:test:subject-atomic-write:sibling';
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    await inner.insert([quad(sibling, '"keep"'), quad(SUBJECT, '"old"')]);
    const { store } = countingStore(inner, 'absent'); // force the fallback delete path

    await replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [quad(SUBJECT, '"new"')], 'test.source');

    expect(await objectsFor(inner, SUBJECT)).toEqual(['"new"']);
    // The bounded fallback never widened to the sibling row.
    expect(await objectsFor(inner, sibling)).toEqual(['"keep"']);
  });

  // #1938 — the helper enforces the atomic path's single-subject contract on BOTH paths
  // (assertSubjectReplacementPayload), so an out-of-contract payload throws BEFORE any
  // deleteByPattern/insert — the fallback can never silently leak what the atomic path
  // would reject. Each case runs in 'absent' mode (the fallback path): without the guard
  // the delete+insert would run; with it, the throw pre-empts all store interaction.
  it('rejects a multi-subject payload before any delete/insert (fallback path)', async () => {
    const other = 'urn:test:subject-atomic-write:other';
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    const { store, counts } = countingStore(inner, 'absent');

    await expect(
      replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [quad(SUBJECT, '"a"'), quad(other, '"b"')], 'test.source'),
    ).rejects.toThrow(/must target subject/);

    expect(counts.graphDeletes).toBe(0);
    expect(await objectsFor(inner, SUBJECT)).toEqual([]);
    expect(await objectsFor(inner, other)).toEqual([]);
  });

  it('rejects a wrong-graph payload before any delete/insert (fallback path)', async () => {
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    const { store, counts } = countingStore(inner, 'absent');

    await expect(
      replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [quad(SUBJECT, '"a"', 'urn:test:other-graph')], 'test.source'),
    ).rejects.toThrow(/must target subject/);

    expect(counts.graphDeletes).toBe(0);
    expect(await objectsFor(inner, SUBJECT)).toEqual([]);
  });

  it('rejects a blank-node payload before any delete/insert (parity with the atomic path)', async () => {
    const inner = new OxigraphStore();
    await inner.createGraph(GRAPH);
    const { store, counts } = countingStore(inner, 'absent');

    // subject/graph match, but a blank-node object — the atomic path rejects this, so the
    // fallback must too (the asymmetry a subject/graph-only re-check would have left open).
    await expect(
      replaceSubjectAtomicallyOrFallback(store, GRAPH, SUBJECT, [{ subject: SUBJECT, predicate: PRED, object: '_:b0', graph: GRAPH }], 'test.source'),
    ).rejects.toThrow(/blank node/);

    expect(counts.graphDeletes).toBe(0);
    expect(await objectsFor(inner, SUBJECT)).toEqual([]);
  });
});
