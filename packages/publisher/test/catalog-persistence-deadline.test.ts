import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
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

  it('finishes every fallback subject delete and the insert after the first delete outlives abort', async () => {
    const base = new OxigraphStore();
    const graph = 'urn:catalog:fallback-deadline';
    const subjects = ['urn:catalog:first', 'urn:catalog:second'];
    await base.insert(subjects.map((subject) => ({ subject, predicate: 'urn:p:value', object: '"old"', graph })));
    const originalDelete = base.deleteByPatternWithoutCount!.bind(base);
    let entered!: () => void;
    let release!: () => void;
    const inDelete = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const deleteCalls: Array<{ subject?: string; signal?: AbortSignal }> = [];
    vi.spyOn(base, 'deleteByPatternWithoutCount').mockImplementation(async (pattern, options) => {
      deleteCalls.push({ subject: pattern.subject, signal: options?.signal });
      if (deleteCalls.length === 1) { entered(); await held; }
      await originalDelete(pattern);
    });
    const insert = vi.spyOn(base, 'insert');
    const flush = vi.spyOn(base, 'flush');
    const store = new Proxy(base as TripleStore, {
      get(target, property) {
        if (property === 'update') return undefined;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const deadline = new AbortController();
    const persistence = replaceCatalogQuads(store, graph, subjects.map((subject) => ({
      subject, predicate: 'urn:p:value', object: '"new"', graph: '',
    })), deadline.signal);
    await inDelete;
    deadline.abort();
    release();
    await persistence;

    expect(deleteCalls.map(({ subject }) => subject)).toEqual(subjects);
    expect(deleteCalls[0]?.signal).toBe(deadline.signal);
    expect(deleteCalls[1]?.signal).toBeUndefined();
    expect(insert.mock.calls.at(-1)?.[1]?.signal).toBeUndefined();
    expect(flush.mock.calls[0]?.[0]?.signal).toBeUndefined();
    const result = await base.query(`SELECT ?s ?o WHERE { GRAPH <${graph}> { ?s <urn:p:value> ?o } }`);
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings).toEqual(expect.arrayContaining(subjects.map((subject) => ({ s: subject, o: '"new"' }))));
      expect(result.bindings).toHaveLength(subjects.length);
    }
  });
});
