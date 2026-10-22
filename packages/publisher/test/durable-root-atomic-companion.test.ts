import { describe, expect, it, vi } from 'vitest';

import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { tryReplaceGraphWithDurableRootCompanionAtomically } from
  '../src/durable-root-atomic-companion.js';

const GRAPH = 'urn:test:root-graph';
const MARKER_GRAPH = 'urn:test:root-boundary';
const MARKER_SUBJECT = 'urn:test:root-boundary:one';
const CONTENT: readonly Quad[] = Object.freeze([
  Object.freeze({ subject: 'urn:test:asset', predicate: 'urn:test:value', object: '"one"', graph: GRAPH }),
]);
const MARKER: readonly Quad[] = Object.freeze([
  Object.freeze({ subject: MARKER_SUBJECT, predicate: 'urn:test:entry', object: '"one"', graph: MARKER_GRAPH }),
]);

async function hasRow(store: TripleStore, graph: string, subject: string): Promise<boolean> {
  const result = await store.query(`ASK { GRAPH <${graph}> { <${subject}> ?p ?o } }`);
  return result.type === 'boolean' && result.value;
}

describe('durable root atomic companion', () => {
  it('commits graph and companion together and settles true', async () => {
    const store = new OxigraphStore();
    const settle = vi.fn();

    await expect(tryReplaceGraphWithDurableRootCompanionAtomically(
      store,
      GRAPH,
      CONTENT,
      { graphUri: MARKER_GRAPH, subject: MARKER_SUBJECT, quads: MARKER, settle },
    )).resolves.toBe(true);

    await expect(store.hasGraph(GRAPH)).resolves.toBe(true);
    await expect(hasRow(store, MARKER_GRAPH, MARKER_SUBJECT)).resolves.toBe(true);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(true);
  });

  it('settles false and writes neither side on a clean capability refusal', async () => {
    const base = new OxigraphStore();
    const store = new Proxy(base as TripleStore, {
      get(target, property, receiver) {
        if (property === 'replaceGraphAndSubject') return undefined;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const settle = vi.fn();

    await expect(tryReplaceGraphWithDurableRootCompanionAtomically(
      store,
      GRAPH,
      CONTENT,
      { graphUri: MARKER_GRAPH, subject: MARKER_SUBJECT, quads: MARKER, settle },
    )).resolves.toBe(false);

    await expect(base.hasGraph(GRAPH)).resolves.toBe(false);
    await expect(hasRow(base, MARKER_GRAPH, MARKER_SUBJECT)).resolves.toBe(false);
    expect(settle).toHaveBeenCalledWith(false);
  });

  it('settles indeterminate when dispatch throws after the compound commit', async () => {
    const store = new OxigraphStore();
    const atomicReplace = store.replaceGraphAndSubject!.bind(store);
    store.replaceGraphAndSubject = async (...args) => {
      await atomicReplace(...args);
      throw new Error('response lost after commit');
    };
    const settle = vi.fn();

    await expect(tryReplaceGraphWithDurableRootCompanionAtomically(
      store,
      GRAPH,
      CONTENT,
      { graphUri: MARKER_GRAPH, subject: MARKER_SUBJECT, quads: MARKER, settle },
    )).rejects.toThrow('response lost after commit');

    await expect(store.hasGraph(GRAPH)).resolves.toBe(true);
    await expect(hasRow(store, MARKER_GRAPH, MARKER_SUBJECT)).resolves.toBe(true);
    expect(settle).toHaveBeenCalledWith(undefined);
  });
});
