import { describe, expect, it } from 'vitest';
import {
  GraphSetIndexStore,
  OxigraphStore,
  type GraphSetMutationEvent,
} from '../src/index.js';
import { MutationHookStore, emptyBindings, q } from './graph-set-index-store-harness.js';

describe('GraphSetIndexStore SPARQL update maintenance', () => {
  it('defers arbitrary SPARQL query updates to one lazy full refresh', async () => {
    const graph = 'did:dkg:context-graph:generic-query-update';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q(graph)]);
        return emptyBindings();
      },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.query(
      `PREFIX foaf.core: <http://example.com/foaf/>\n` +
        `INSERT DATA { GRAPH <${graph}> { <urn:s> <urn:p> "v" } }`,
    );

    expect(counting.listGraphsCalls).toBe(1);
    expect(counting.hasGraphOptions).toHaveLength(0);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [graph],
      removed: [],
      source: 'query',
    });
  });

  it('detects prefixed SPARQL updates with relative prologue IRIs', async () => {
    const graph = 'did:dkg:context-graph:relative-prefix-update';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q(graph)]);
        return emptyBindings();
      },
    });
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100_000 });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.query(
      `PREFIX ex: <1/>\n` +
        `INSERT DATA { GRAPH <${graph}> { <urn:s> ex:p "v" } }`,
    );

    expect(counting.listGraphsCalls).toBe(1);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('detects WITH-form SPARQL updates as mutating queries', async () => {
    const graph = 'did:dkg:context-graph:with-update';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q(graph)]);
        return emptyBindings();
      },
    });
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100_000 });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.query(
      `PREFIX ex: <urn:>\n` +
        `WITH <${graph}> DELETE { ?s ex:old ?o } INSERT { ?s ex:new ?o } WHERE { ?s ex:old ?o }`,
    );

    expect(counting.listGraphsCalls).toBe(1);
    expect(counting.hasGraphOptions).toHaveLength(0);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('defers generic update() text to one lazy full refresh', async () => {
    const graph = 'did:dkg:context-graph:generic-update';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onUpdate: async ({ inner }) => {
        await inner.insert([q(graph)]);
      },
    });
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100_000 });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.update(`INSERT DATA { GRAPH <${graph}> { <urn:s> <urn:p> "v" } }`);

    expect(counting.listGraphsCalls).toBe(1);
    expect(counting.hasGraphOptions).toHaveLength(0);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(2);
  });
});
