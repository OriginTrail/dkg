import { describe, expect, it, vi } from 'vitest';
import {
  GraphWriteGenTracker, OxigraphStore, type GraphWriteRevisionSource,
} from '@origintrail-official/dkg-storage';
import { contextGraphDataUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { captureUnscopedQueryConsistency, executeUnscopedQuery } from '../src/unscoped-query-consistency.js';

const quad = (graph: string, object = '"public"') => ({
  graph, subject: 'urn:subject', predicate: 'urn:predicate', object,
});

describe('unscoped query execution consistency', () => {
  it('owns admission and releases the original result only after execution is checked', async () => {
    const store = new OxigraphStore();
    const result = { bindings: [{ value: 'public' }] };
    const phases: string[] = [];
    try {
      expect(await executeUnscopedQuery({
        store,
        readMetadataRevision: () => { phases.push('revision'); return 0; },
        admit: async () => { phases.push('admit'); return true; },
        execute: async () => { phases.push('execute'); return result; },
        denied: () => { throw new Error('unexpected denial'); },
      })).toBe(result);
      expect(phases).toEqual(['revision', 'admit', 'revision', 'execute', 'revision']);
    } finally { await store.close(); }
  });

  it.each(['admission', 'execution'] as const)('withholds data changed during %s', async (phase) => {
    const store = new OxigraphStore();
    const execute = vi.fn(async () => {
      if (phase === 'execution') await store.insert([quad('urn:new', '"private"')]);
      return { bindings: [{ value: 'private' }] };
    });
    try {
      await expect(executeUnscopedQuery({
        store, readMetadataRevision: () => 0,
        admit: async () => {
          if (phase === 'admission') await store.insert([quad('urn:new', '"private"')]);
          return true;
        },
        execute, denied: () => ({ bindings: [] }),
      })).rejects.toThrow(/changed/);
      expect(execute).toHaveBeenCalledTimes(phase === 'execution' ? 1 : 0);
    } finally { await store.close(); }
  });

  it('returns the denial shape without executing user SPARQL', async () => {
    const store = new OxigraphStore();
    const result = { bindings: [{ result: 'false' }] };
    const execute = vi.fn(async () => result);
    try {
      expect(await executeUnscopedQuery({
        store, readMetadataRevision: () => 0, admit: async () => false,
        execute, denied: () => result,
      })).toBe(result);
      expect(execute).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it.each(['admission', 'execution'] as const)('preserves the original %s failure', async (phase) => {
    const store = new OxigraphStore();
    const failure = new Error(`${phase} unavailable`);
    const execute = vi.fn(async () => { throw failure; });
    try {
      await expect(executeUnscopedQuery({
        store, readMetadataRevision: () => 0,
        admit: async () => { if (phase === 'admission') throw failure; return true; },
        execute, denied: () => undefined,
      })).rejects.toBe(failure);
      expect(execute).toHaveBeenCalledTimes(phase === 'execution' ? 1 : 0);
    } finally { await store.close(); }
  });

  it.each([{}, new GraphWriteGenTracker(), {
    getWriteRevision: () => ({ generation: 0, stable: true }),
  }])('rejects missing or process-local coverage before metadata discovery', (store) => {
    const metadata = vi.fn(() => 0);
    expect(() => captureUnscopedQueryConsistency(store, metadata)).toThrow(/all-writer.*contextGraphId/);
    expect(metadata).not.toHaveBeenCalled();
  });

  it('accepts an unchanged actual store through a decorator and keeps physical default-graph reads', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([quad(''), quad('urn:named', '"named"')]);
      const revision = vi.spyOn(store, 'getWriteRevision');
      const check = captureUnscopedQueryConsistency({ innerStore: store }, () => 0);
      expect(await store.query('SELECT ?o WHERE { <urn:subject> <urn:predicate> ?o }'))
        .toEqual({ type: 'bindings', bindings: [{ o: '"public"' }] });
      expect(check).not.toThrow();
      expect(revision.mock.calls.every(([prefix]) => prefix === '')).toBe(true);
    } finally { await store.close(); }
  });

  it.each(['', 'urn:public', contextGraphDataUri('private')])('rejects any graph write within the captured interval: %s', async (graph) => {
    const store = new OxigraphStore();
    try {
      const check = captureUnscopedQueryConsistency(store, () => 0);
      await store.insert([quad(graph)]);
      expect(check).toThrow(/changed.*retry.*contextGraphId/);
    } finally { await store.close(); }
  });

  it('detects create/read/delete ABA even when the final graph inventory is identical', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([quad('urn:public')]);
      const beforeGraphs = await store.listGraphs();
      const check = captureUnscopedQueryConsistency(store, () => 0);
      const privateGraph = contextGraphDataUri('private');
      await store.insert([quad(privateGraph, '"private marker"')]);
      const materialized = await store.query('SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(materialized.type === 'bindings' && materialized.bindings.some((row) => row.o === '"private marker"')).toBe(true);
      await store.dropGraph(privateGraph);
      expect(await store.listGraphs()).toEqual(beforeGraphs);
      expect(check).toThrow(/changed/);
    } finally { await store.close(); }
  });

  it('rejects a same-URI replacement while an asynchronous read is materializing', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([quad('urn:same')]);
      const check = captureUnscopedQueryConsistency(store, () => 0);
      let release!: () => void;
      const queryStarted = new Promise<void>((resolve) => { release = resolve; });
      const materialize = (async () => {
        await queryStarted;
        return store.query('SELECT ?o WHERE { GRAPH <urn:same> { ?s ?p ?o } }');
      })();
      await store.replaceGraph('urn:same', [quad('urn:same', '"private replacement"')]);
      release();
      expect(await materialize).toEqual({ type: 'bindings', bindings: [{ o: '"private replacement"' }] });
      expect(check).toThrow(/changed/);
    } finally { await store.close(); }
  });

  it('rejects an active writer at capture and a writer still active after capture', () => {
    const tracker = new GraphWriteGenTracker();
    const source: GraphWriteRevisionSource = {
      writeRevisionCoverage: 'all-writers',
      getWriteRevision: (prefix) => tracker.getWriteRevision(prefix),
    };
    const firstWrite = tracker.beginWrite({ kind: 'all' });
    expect(() => captureUnscopedQueryConsistency(source, () => 0)).toThrow(/changed/);
    firstWrite.settle();
    const check = captureUnscopedQueryConsistency(source, () => 0);
    const nextWrite = tracker.beginWrite({ kind: 'graphs', graphs: ['urn:new'] });
    expect(check).toThrow(/changed/);
    nextWrite.settle();
    expect(check).toThrow(/changed/);
  });

  it('rejects metadata authority invalidation even without a store-generation change', async () => {
    const store = new OxigraphStore();
    try {
      const projection = new ContextGraphMetaProjection(store);
      const check = captureUnscopedQueryConsistency(store, () => projection.readAuthorityFactsRevision);
      projection.markDirtyFromQuads([{
        subject: contextGraphDataUri('new-private'),
        predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
        object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED,
        graph: `${contextGraphDataUri('new-private')}/_meta`,
      }]);
      expect(check).toThrow(/read authority changed/);
    } finally { await store.close(); }
  });

  it('rejects coverage changes and snapshots mutable revision values by value', () => {
    const revision = { generation: 0, stable: true };
    const source: GraphWriteRevisionSource = {
      writeRevisionCoverage: 'all-writers', getWriteRevision: () => revision,
    };
    const check = captureUnscopedQueryConsistency(source, () => 0);
    revision.generation += 1;
    expect(check).toThrow(/changed/);
    Object.defineProperty(source, 'writeRevisionCoverage', { value: 'process-local' });
    expect(check).toThrow(/all-writer.*contextGraphId/);
  });

  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1])('rejects malformed revision generation %s before discovery', (generation) => {
    const metadata = vi.fn(() => 0);
    const source: GraphWriteRevisionSource = {
      writeRevisionCoverage: 'all-writers',
      getWriteRevision: () => ({ generation, stable: true }),
    };
    expect(() => captureUnscopedQueryConsistency(source, metadata)).toThrow(/changed/);
    expect(metadata).not.toHaveBeenCalled();
  });

  it('rejects an unstable final revision even when its generation is unchanged', () => {
    let stable = true;
    const source: GraphWriteRevisionSource = {
      writeRevisionCoverage: 'all-writers',
      getWriteRevision: () => ({ generation: 0, stable }),
    };
    const check = captureUnscopedQueryConsistency(source, () => 0);
    stable = false;
    expect(check).toThrow(/changed/);
  });
});
