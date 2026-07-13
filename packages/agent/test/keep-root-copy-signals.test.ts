import { describe, expect, it } from 'vitest';
import { contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
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

  it('keeps the awaited per-root fallback for stores without SPARQL UPDATE', async () => {
    const store = new OxigraphStore();
    const graph = contextGraphWorkspaceMetaGraphUri('keep-root-fallback');
    const deleteCalls: string[] = [];
    const insertCalls: string[] = [];
    const originalDelete = store.deleteByPattern.bind(store);
    const originalInsert = store.insert.bind(store);
    store.update = undefined;
    store.deleteByPattern = async (pattern, options) => {
      deleteCalls.push(pattern.subject ?? '');
      return originalDelete(pattern, options);
    };
    store.insert = async (quads, options) => {
      insertCalls.push(...quads.map((quad) => quad.subject));
      return originalInsert(quads, options);
    };

    await persistKeepRootCopySignals(
      store,
      graph,
      ['urn:test:fallback:one', 'urn:test:fallback:two'],
      false,
    );

    expect(deleteCalls).toEqual(['urn:test:fallback:one', 'urn:test:fallback:two']);
    expect(insertCalls).toEqual(['urn:test:fallback:one', 'urn:test:fallback:two']);
  });
});
