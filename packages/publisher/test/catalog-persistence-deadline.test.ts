import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { replaceCatalogQuads } from '../src/catalog-persistence.js';

describe('catalog persistence deadline boundary', () => {
  it('finishes insert and flush after a non-cooperative targeted delete commits past abort', async () => {
    const store = new OxigraphStore();
    const graph = 'urn:catalog:deadline';
    const subject = 'urn:catalog:item';
    await store.insert([{ subject, predicate: 'urn:p:value', object: '"old"', graph }]);
    const originalUpdate = store.update!.bind(store);
    let entered!: () => void;
    let release!: () => void;
    const inUpdate = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, 'update').mockImplementation(async (sparql) => {
      entered();
      await held;
      // This adapter ignores the aborted signal and commits anyway.
      await originalUpdate(sparql);
    });
    const insert = vi.spyOn(store, 'insert');
    const flush = vi.spyOn(store, 'flush');
    const deadline = new AbortController();

    const persistence = replaceCatalogQuads(store, graph, [
      { subject, predicate: 'urn:p:value', object: '"new"', graph: '' },
    ], deadline.signal);
    await inUpdate;
    deadline.abort();
    release();
    await persistence;

    expect(insert.mock.calls[0]?.[1]?.signal).toBeUndefined();
    expect(flush.mock.calls[0]?.[0]?.signal).toBeUndefined();
    const result = await store.query(`SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <urn:p:value> ?o } }`);
    expect(result).toEqual({ type: 'bindings', bindings: [{ o: '"new"' }] });
  });
});
