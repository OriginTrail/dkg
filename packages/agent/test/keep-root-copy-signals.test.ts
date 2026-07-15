import { describe, expect, it } from 'vitest';
import { contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import {
  GraphSetIndexStore,
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { KEEP_ROOT_COPY_PREDICATE } from '../src/finalization-handler.js';
import { persistKeepRootCopySignals } from '../src/dkg-agent-publish.js';

describe('persistKeepRootCopySignals', () => {
  it('replaces every safe root signal in one awaited store update', async () => {
    const store = new OxigraphStore();
    const graph = contextGraphWorkspaceMetaGraphUri('keep-root-batch');
    const roots = Array.from({ length: 51 }, (_, index) => `urn:test:root:${index}`);
    await store.insert(roots.map((root) => ({
      subject: root,
      predicate: KEEP_ROOT_COPY_PREDICATE,
      object: '"stale"',
      graph,
    })));

    const originalUpdate = store.update.bind(store);
    const updates: Array<{ sparql: string; options: unknown }> = [];
    store.update = async (sparql, options) => {
      updates.push({ sparql, options });
      return originalUpdate(sparql, options);
    };

    await persistKeepRootCopySignals(store, graph, [...roots, roots[0], 'not an iri'], true);

    expect(updates).toHaveLength(1);
    expect(updates[0].options).toEqual({
      source: 'publish.persistKeepRootCopySignals',
      touchedGraphs: [graph],
    });
    const result = await store.query(`SELECT ?root ?value WHERE {
      GRAPH <${graph}> { ?root <${KEEP_ROOT_COPY_PREDICATE}> ?value }
    }`);
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings).toHaveLength(51);
      expect(new Set(result.bindings.map((binding) => binding.value))).toEqual(new Set(['"true"']));
    }
  });

  it('does not dispatch a mutation when no root is a safe IRI', async () => {
    const store = new OxigraphStore();
    let updateCalls = 0;
    store.update = async () => { updateCalls += 1; };

    await persistKeepRootCopySignals(
      store,
      contextGraphWorkspaceMetaGraphUri('keep-root-empty'),
      ['not an iri', '<also-not-an-iri>'],
      false,
    );

    expect(updateCalls).toBe(0);
  });

  it('keeps the awaited per-root fallback for a decorator reporting update unsupported', async () => {
    const base = new OxigraphStore();
    const graph = contextGraphWorkspaceMetaGraphUri('keep-root-fallback');
    const deleteCalls: string[] = [];
    const insertCalls: string[] = [];
    const innerWithoutUpdate = new Proxy(base as unknown as TripleStore, {
      get(target, property, receiver) {
        if (property === 'update') return undefined;
        if (property === 'deleteByPattern') {
          return async (...args: Parameters<TripleStore['deleteByPattern']>) => {
            deleteCalls.push(args[0].subject ?? '');
            return target.deleteByPattern(...args);
          };
        }
        if (property === 'insert') {
          return async (...args: Parameters<TripleStore['insert']>) => {
            insertCalls.push(...args[0].map((quad) => quad.subject));
            return target.insert(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const store = new GraphSetIndexStore(innerWithoutUpdate);
    let typedUnsupportedSignals = 0;
    const originalUpdate = store.update.bind(store);
    store.update = async (...args) => {
      try {
        await originalUpdate(...args);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
        typedUnsupportedSignals += 1;
        throw error;
      }
    };

    await persistKeepRootCopySignals(
      store,
      graph,
      ['urn:test:fallback:one', 'urn:test:fallback:two'],
      false,
    );

    expect(typedUnsupportedSignals).toBe(1);
    expect(deleteCalls).toEqual(['urn:test:fallback:one', 'urn:test:fallback:two']);
    expect(insertCalls).toEqual(['urn:test:fallback:one', 'urn:test:fallback:two']);
  });

  it('propagates genuine update errors instead of masking them with fallback writes', async () => {
    const base = new OxigraphStore();
    const updateFailure = new Error('update backend unavailable');
    let fallbackCalls = 0;
    const failingInner = new Proxy(base as unknown as TripleStore, {
      get(target, property, receiver) {
        if (property === 'update') return async () => { throw updateFailure; };
        if (property === 'deleteByPattern' || property === 'insert') {
          return async () => {
            fallbackCalls += 1;
            throw new Error('fallback must not run');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(persistKeepRootCopySignals(
      new GraphSetIndexStore(failingInner),
      contextGraphWorkspaceMetaGraphUri('keep-root-genuine-error'),
      ['urn:test:genuine-error'],
      true,
    )).rejects.toBe(updateFailure);

    expect(fallbackCalls).toBe(0);
  });
});
