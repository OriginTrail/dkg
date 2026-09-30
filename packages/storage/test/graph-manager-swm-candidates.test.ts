import { describe, it, expect, vi } from 'vitest';
import {
  createTripleStore,
  loadSelectedSharedMemoryQuads,
  loadSharedMemorySliceWithKaBoundFallback,
  loadMerkleVerifiedSharedMemorySlice,
} from '../src/index.js';
import { contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import { AUTHOR_A_MIXED, AUTHOR_A, AUTHOR_B, keys } from './graph-manager-swm-fixtures.js';

describe('loadSharedMemorySliceWithKaBoundFallback — the safe bounded read', () => {
  const SOURCES = {
    bounded: 'test.bounded',
    widened: 'test.widened',
    unbounded: 'test.unbounded',
  } as const;

  it('rejects an unsafe bucket before root-indexed discovery can query the backend', () => {
    const query = vi.fn();
    const withReadSnapshot = vi.fn();
    const store = { query, withReadSnapshot, listGraphs: vi.fn() } as unknown as
      Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    const unsafe = 'urn:unused> UNDEF } SERVICE <http://internal.example/sparql> { ?s ?p ?o } VALUES ?dummy { <urn:unused';
    expect(() => loadMerkleVerifiedSharedMemorySlice(
      store, unsafe, { rootEntities: ['urn:safe:root'] }, undefined,
      {
        sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
        expectedMerkleRoot: new Uint8Array(32),
        createMerkleAccept: async () => (quads) => quads,
      },
    )).toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(withReadSnapshot).not.toHaveBeenCalled();
    expect(store.listGraphs).not.toHaveBeenCalled();
  });

  it('bounded hit: reads the bound and never widens or re-accepts', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-hit');
    const r = 'urn:fb:hit';
    try {
      await store.insert([
        { subject: r, predicate: 'urn:p', object: '"bucket"', graph: swm },
        { subject: r, predicate: 'urn:p', object: '"in"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: r, predicate: 'urn:p', object: '"out"', graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      let accepts = 0;
      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        store, swm, { rootEntities: [r] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: SOURCES,
          createAccept: async () => (qs) => { accepts += 1; return qs; },
        },
      );

      // Bounded read excluded the out-of-range graph, and the accept predicate
      // approved it, so no widen fired.
      expect(quads.map((q) => q.object).sort()).toEqual(['"bucket"', '"in"']);
      expect(accepted?.map((q) => q.object).sort()).toEqual(['"bucket"', '"in"']);
      expect(accepts).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('bounded mismatch: widens to the complete read and re-accepts', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-miss');
    const r = 'urn:fb:miss';
    const outObj = '"out"';
    try {
      await store.insert([
        { subject: r, predicate: 'urn:p', object: '"in"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: r, predicate: 'urn:p', object: outObj, graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      // accept only when the out-of-range object is present ⇒ the bounded read is
      // rejected and the widen must supply it.
      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        store, swm, { rootEntities: [r] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: SOURCES,
          createAccept: async () => (qs) => (qs.some((q) => q.object === outObj) ? qs : null),
        },
      );

      expect(accepted).not.toBeNull();
      expect(quads.map((q) => q.object).sort()).toEqual(['"in"', '"out"']);
    } finally {
      await store.close();
    }
  });

  it('finds a recurring exact root in another author graph without a complete-family scan', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-root-indexed');
    const root = 'urn:fb:root-indexed';
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const read = {
      query,
      listGraphs: async () => { throw new Error('snapshot graph enumeration must not run'); },
    };
    const snapshotted = {
      query,
      listGraphs: store.listGraphs.bind(store),
      withReadSnapshot: async (fn: (value: typeof read) => Promise<unknown>) => fn(read),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"own"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: root, predicate: 'urn:p', object: '"recurred"', graph: `${swm}/${AUTHOR_B}/12` },
        { subject: root, predicate: 'urn:p', object: '"staging"', graph: `${swm}/staging/tmp` },
        { subject: root, predicate: 'urn:p', object: '"other bucket"', graph: `${swm}-other/${AUTHOR_B}/12` },
      ]);
      const expectedMerkleRoot = new Uint8Array(32).fill(7);
      const result = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot,
          createMerkleAccept: async (merkleRoot) => {
            expect(merkleRoot).toEqual(expectedMerkleRoot);
            return (candidate) => candidate.some((quad) => quad.object === '"recurred"') ? candidate : null;
          },
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(result.status).toBe('verified');
      if (result.status !== 'verified') throw new Error('Expected verified SWM slice');
      expect(keys(result.quads)).toEqual(keys(result.accepted));
      expect(result.quads.map((quad) => quad.object).sort()).toEqual(['"own"', '"recurred"']);
      expect(sources).toContain('test.rootIndexed');
      expect(sources).not.toContain(SOURCES.widened);
    } finally {
      await store.close();
    }
  });

  it('uses a merkle-checked warm graph catalog when exact-root discovery misses a skolem-only graph', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-root-indexed-skolem');
    const root = 'urn:fb:root-indexed-skolem';
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const read = {
      query,
      listGraphs: async () => { throw new Error('snapshot graph enumeration must not run'); },
    };
    const snapshotted = {
      query,
      listGraphs: store.listGraphs.bind(store),
      withReadSnapshot: async (fn: (value: typeof read) => Promise<unknown>) => fn(read),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"root"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        {
          subject: `${root}/.well-known/genid/child`, predicate: 'urn:p',
          object: '"child"', graph: `${swm}/${AUTHOR_B}/12`,
        },
      ]);
      const result = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => (candidate) =>
            candidate.some((quad) => quad.object === '"child"') ? candidate : null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(result.status).toBe('verified');
      if (result.status !== 'verified') throw new Error('Expected verified SWM slice');
      expect(keys(result.quads)).toEqual(keys(result.accepted));
      expect(result.quads.map((quad) => quad.object).sort()).toEqual(['"child"', '"root"']);
      expect(sources).toContain('test.rootIndexed');
      expect(sources).toContain('test.cachedGraphSet');
      expect(sources).not.toContain(SOURCES.widened);
    } finally {
      await store.close();
    }
  });

  it('rejects a stale warm candidate and refreshes a small complete family in a snapshot', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-stale-catalog');
    const root = 'urn:fb:stale-catalog';
    const rootGraph = `${swm}/${AUTHOR_A_MIXED}/7`;
    const childGraph = `${swm}/${AUTHOR_B}/12`;
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const snapshotRead = { query, listGraphs: store.listGraphs.bind(store) };
    const snapshotted = {
      query,
      listGraphs: async () => [rootGraph],
      withReadSnapshot: async (fn: (value: typeof snapshotRead) => Promise<unknown>) => fn(snapshotRead),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"root"', graph: rootGraph },
        { subject: `${root}/.well-known/genid/child`, predicate: 'urn:p', object: '"child"', graph: childGraph },
      ]);
      const result = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] }, undefined,
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => (candidate) =>
            candidate.some((quad) => quad.object === '"child"') ? candidate : null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(result.status).toBe('verified');
      if (result.status !== 'verified') throw new Error('Expected verified SWM slice');
      expect(result.quads.map((quad) => quad.object).sort()).toEqual(['"child"', '"root"']);
      expect(sources).toContain('test.cachedGraphSet');
      expect(sources).toContain(SOURCES.unbounded);
    } finally {
      await store.close();
    }
  });

  it('enumerates an unrestricted complete family only inside the read snapshot', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-complete-one-inventory');
    const root = 'urn:fb:complete-one-inventory';
    const outerListGraphs = vi.fn(store.listGraphs.bind(store));
    const snapshotListGraphs = vi.fn(store.listGraphs.bind(store));
    const snapshotRead = { query: store.query.bind(store), listGraphs: snapshotListGraphs };
    const snapshotted = {
      query: store.query.bind(store),
      listGraphs: outerListGraphs,
      withReadSnapshot: async (fn: (value: typeof snapshotRead) => Promise<unknown>) => fn(snapshotRead),
    } as unknown as Parameters<typeof loadSelectedSharedMemoryQuads>[0];
    try {
      await store.insert([{ subject: root, predicate: 'urn:p', object: '"value"', graph: swm }]);
      const quads = await loadSelectedSharedMemoryQuads(
        snapshotted, swm, { rootEntities: [root] },
      );
      expect(quads.map((quad) => quad.object)).toEqual(['"value"']);
      expect(outerListGraphs).not.toHaveBeenCalled();
      expect(snapshotListGraphs).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });

  it('refreshes an omitted child after a stale catalog spans multiple graph chunks', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-stale-catalog-chunked');
    const root = 'urn:fb:stale-catalog-chunked';
    const rootGraph = `${swm}/${AUTHOR_A_MIXED}/7`;
    const childGraph = `${swm}/${AUTHOR_B}/12`;
    const staleGraphs = [rootGraph, ...Array.from({ length: 17 }, (_, i) => `${swm}/decoy-${i}`)];
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const snapshotListGraphs = vi.fn(store.listGraphs.bind(store));
    const snapshotRead = { query, listGraphs: snapshotListGraphs };
    const snapshotted = {
      query,
      listGraphs: async () => staleGraphs,
      withReadSnapshot: async (fn: (value: typeof snapshotRead) => Promise<unknown>) => fn(snapshotRead),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"root"', graph: rootGraph },
        { subject: `${root}/.well-known/genid/child`, predicate: 'urn:p', object: '"child"', graph: childGraph },
        ...staleGraphs.slice(1).map((graph, i) => ({
          subject: `urn:decoy:${i}`, predicate: 'urn:p', object: '"decoy"', graph,
        })),
      ]);
      const result = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] }, undefined,
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => (candidate) =>
            candidate.some((quad) => quad.object === '"child"') ? candidate : null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
        },
      );
      expect(result.status).toBe('verified');
      if (result.status !== 'verified') throw new Error('Expected verified SWM slice');
      expect(result.quads.map((quad) => quad.object).sort()).toEqual(['"child"', '"root"']);
      expect(snapshotListGraphs).toHaveBeenCalled();
      expect(sources).toContain('test.cachedGraphSet');
      expect(sources).toContain(SOURCES.unbounded);
    } finally {
      await store.close();
    }
  });

  it('defers an unmatched huge family before issuing hundreds of graph chunks', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-huge-family');
    const root = 'urn:fb:huge-family';
    const rootGraph = `${swm}/${AUTHOR_A_MIXED}/7`;
    const graphs = [rootGraph, ...Array.from({ length: 513 }, (_, i) => `${swm}/decoy-${i}`)];
    const sources: string[] = [];
    const query = async (...args: Parameters<typeof store.query>) => {
      sources.push(args[1]?.source ?? '');
      return store.query(...args);
    };
    const snapshotted = {
      query,
      listGraphs: async () => graphs,
      withReadSnapshot: async (read: (value: typeof store) => Promise<unknown>) => read({
        query, listGraphs: store.listGraphs.bind(store),
      } as typeof store),
    } as unknown as Parameters<typeof loadMerkleVerifiedSharedMemorySlice>[0];
    try {
      await store.insert([{ subject: root, predicate: 'urn:p', object: '"root"', graph: rootGraph }]);
      const result = await loadMerkleVerifiedSharedMemorySlice(
        snapshotted, swm, { rootEntities: [root] }, undefined,
        {
          sources: { ...SOURCES, rootIndexed: 'test.rootIndexed', cachedGraphSet: 'test.cachedGraphSet' },
          expectedMerkleRoot: new Uint8Array(32),
          createMerkleAccept: async () => () => null,
          resultBudget: { pageRows: 100, maxRows: 1000, maxBytesEstimate: 1024 * 1024 },
          maxCompleteFamilyGraphs: 512,
        },
      );
      expect(result.status).toBe('deferred');
      if (result.status !== 'deferred') throw new Error('Expected deferred SWM slice');
      expect(result.candidateQuads.map((quad) => quad.object)).toEqual(['"root"']);
      expect(result).not.toHaveProperty('quads');
      expect(sources).toContain('test.rootIndexed');
      expect(sources).not.toContain(SOURCES.unbounded);
    } finally {
      await store.close();
    }
  });

  it('deprecated positional options preserve bounded widening behavior', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-legacy');
    const root = 'urn:fb:legacy';
    const widenedObject = '"widened"';
    try {
      await store.insert([
        { subject: root, predicate: 'urn:p', object: '"bounded"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: root, predicate: 'urn:p', object: widenedObject, graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      const { quads, accepted } = await loadSharedMemorySliceWithKaBoundFallback(
        store,
        swm,
        { rootEntities: [root] },
        { agentAddress: AUTHOR_A, startNumber: 7n, endNumber: 7n },
        SOURCES,
        async () => (candidate) =>
          candidate.some((quad) => quad.object === widenedObject) ? candidate : null,
      );

      expect(quads.map((quad) => quad.object).sort()).toEqual(['"bounded"', widenedObject]);
      expect(accepted).toEqual(quads);
    } finally {
      await store.close();
    }
  });

  it('no bound: one complete read, accept predicate applied once', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const swm = contextGraphSharedMemoryUri('fb-none');
    const r = 'urn:fb:none';
    try {
      await store.insert([
        { subject: r, predicate: 'urn:p', object: '"a"', graph: `${swm}/${AUTHOR_A_MIXED}/7` },
        { subject: r, predicate: 'urn:p', object: '"b"', graph: `${swm}/${AUTHOR_B}/12` },
      ]);

      let accepts = 0;
      const { quads } = await loadSharedMemorySliceWithKaBoundFallback(
        store, swm, { rootEntities: [r] },
        undefined,
        {
          sources: SOURCES,
          createAccept: async () => (qs) => { accepts += 1; return qs; },
        },
      );

      // Unbounded ⇒ both authors read; accept applied exactly once.
      expect(quads.map((q) => q.object).sort()).toEqual(['"a"', '"b"']);
      expect(accepts).toBe(1);
    } finally {
      await store.close();
    }
  });
});
