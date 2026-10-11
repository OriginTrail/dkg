// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, STORE_OPERATION_OUTCOME_TAG, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';

// The factory is reachable through the historical `dkg-agent-base` export, whose third argument was
// a callback `(quads?, targetGraph?, targetSubject?)` before it became an observer.
const GRAPH = 'urn:example:g';
const SUBJECT = 'urn:example:s';
const quad = (): Quad => ({ subject: SUBJECT, predicate: 'urn:example:p', object: '"o"', graph: GRAPH });

describe('createListContextGraphsCacheInvalidatingStore with the historical callback (GH#3067)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });
  const open = (inner?: (store: OxigraphStore) => TripleStore) => {
    const store = new OxigraphStore();
    stores.push(store);
    const markProjectionDirty = vi.fn();
    const invalidate = vi.fn();
    const wrapper = createListContextGraphsCacheInvalidatingStore(inner ? inner(store) : store, invalidate, markProjectionDirty);
    return { store, wrapper, markProjectionDirty, invalidate };
  };
  const failing = (operation: string, error: Error) => (store: OxigraphStore): TripleStore => new Proxy(store, {
    get: (target, property) => property === operation
      ? async () => { throw error; }
      : (typeof Reflect.get(target, property) === 'function'
        ? (Reflect.get(target, property) as (...args: unknown[]) => unknown).bind(target)
        : Reflect.get(target, property)),
  });

  it('still dispatches the write and reports the quads it inserted', async () => {
    const { wrapper, store, markProjectionDirty, invalidate } = open();
    await wrapper.insert([quad()]);
    expect((await store.query('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }')).type).toBe('bindings');
    expect(markProjectionDirty).toHaveBeenCalledTimes(1);
    expect(markProjectionDirty).toHaveBeenCalledWith([quad()]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('reports the graph and subject of a replaced subject, and its quads', async () => {
    const { wrapper, markProjectionDirty } = open();
    await wrapper.replaceSubject!(GRAPH, SUBJECT, [quad()]);
    expect(markProjectionDirty).toHaveBeenCalledWith(undefined, GRAPH, SUBJECT);
    expect(markProjectionDirty).toHaveBeenCalledWith([quad()]);
  });

  it('reports the graph of a drop and of a pattern delete', async () => {
    const { wrapper, markProjectionDirty } = open();
    await wrapper.dropGraph(GRAPH);
    expect(markProjectionDirty).toHaveBeenLastCalledWith(undefined, GRAPH, undefined);
    await wrapper.deleteByPatternWithoutCount!({ graph: GRAPH, subject: SUBJECT });
    expect(markProjectionDirty).toHaveBeenLastCalledWith(undefined, GRAPH, SUBJECT);
  });

  it('reports a SPARQL update with no arguments', async () => {
    const { wrapper, markProjectionDirty } = open();
    await wrapper.update!(`INSERT DATA { GRAPH <${GRAPH}> { <${SUBJECT}> <urn:example:p> "o" } }`);
    expect(markProjectionDirty).toHaveBeenCalledTimes(1);
    expect(markProjectionDirty).toHaveBeenCalledWith();
  });

  it('does not report a write that changed nothing', async () => {
    const { wrapper, markProjectionDirty, invalidate } = open();
    await wrapper.insert([]);
    expect(markProjectionDirty).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('reports a write whose outcome is unknown, and not one that was refused before dispatch', async () => {
    const unknown = open(failing('insert', new Error('request timed out')));
    await expect(unknown.wrapper.insert([quad()])).rejects.toThrow('timed out');
    expect(unknown.markProjectionDirty).toHaveBeenCalledWith([quad()]);
    expect(unknown.invalidate).toHaveBeenCalledTimes(1);

    const refused = open(failing('insert', Object.assign(new Error('rejected'), {
      storeOperationOutcomeTag: STORE_OPERATION_OUTCOME_TAG,
      storeOperation: 'insert',
      outcome: 'not_started',
    })));
    await expect(refused.wrapper.insert([quad()])).rejects.toThrow('rejected');
    expect(refused.markProjectionDirty).not.toHaveBeenCalled();
    expect(refused.invalidate).not.toHaveBeenCalled();
  });
});
