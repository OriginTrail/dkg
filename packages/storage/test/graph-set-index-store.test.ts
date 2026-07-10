import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  GraphSetIndexStore,
  OxigraphStore,
  createTripleStore,
  registerTripleStoreAdapter,
  type GraphSetMutationEvent,
  type QueryOptions,
} from '../src/index.js';
import { CountingStore, MutationHookStore, emptyBindings, q } from './graph-set-index-store-harness.js';

class FailingMaintenanceStore extends CountingStore {
  failHasGraph = false;

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (this.failHasGraph) throw new Error('hasGraph failed');
    return super.hasGraph(graphUri, options);
  }
}

class GatedMaintenanceStore extends CountingStore {
  hasGraphGate: Promise<void> | null = null;

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const present = await super.hasGraph(graphUri, options);
    if (this.hasGraphGate) await this.hasGraphGate;
    return present;
  }
}

describe('GraphSetIndexStore', () => {
  it('seeds from one listGraphs scan and serves prefix lookups from memory', async () => {
    const inner = new OxigraphStore();
    await inner.insert([
      q('did:dkg:context-graph:alpha'),
      q('did:dkg:context-graph:beta'),
    ]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting);

    await expect(store.listGraphsByPrefix('did:dkg:context-graph:a')).resolves.toEqual([
      'did:dkg:context-graph:alpha',
    ]);
    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining(['did:dkg:context-graph:alpha', 'did:dkg:context-graph:beta']),
    );
    expect(counting.listGraphsCalls).toBe(1);
  });

  it('honors enabled false for direct callers by passing graph reads through', async () => {
    const inner = new OxigraphStore();
    const counting = new CountingStore(inner);
    const events: unknown[] = [];
    const store = new GraphSetIndexStore(counting, {
      enabled: false,
      onMutation: (event) => events.push(event),
    });

    await store.insert([q('did:dkg:context-graph:disabled')]);
    await expect(store.listGraphsByPrefix('did:dkg:context-graph:dis')).resolves.toEqual([
      'did:dkg:context-graph:disabled',
    ]);
    await expect(store.listGraphsByPrefix('did:dkg:context-graph:dis')).resolves.toEqual([
      'did:dkg:context-graph:disabled',
    ]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toEqual([]);
  });

  it('maintains the graph set through local insert/delete/drop/deleteBySubjectPrefix mutators', async () => {
    const counting = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await expect(store.listGraphs()).resolves.toEqual([]);

    const graph = 'did:dkg:context-graph:mutators';
    const root = 'urn:root';
    const child = `${root}/.well-known/genid/1`;
    await store.insert([q(graph, root), q(graph, child)]);
    await expect(store.listGraphsByPrefix('did:dkg:context-graph:mut')).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.delete([q(graph, child)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    await store.deleteBySubjectPrefix(graph, root);
    await expect(store.listGraphs()).resolves.toEqual([]);

    await store.insert([q(graph)]);
    await store.dropGraph(graph);
    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('defers stale touched-graph probe results when another mutation wins the race', async () => {
    const graph = 'did:dkg:context-graph:stale-delete-probe';
    const inner = new OxigraphStore();
    await inner.insert([q(graph)]);
    const gated = new GatedMaintenanceStore(inner);
    const events: GraphSetMutationEvent[] = [];
    let release!: () => void;
    gated.hasGraphGate = new Promise<void>((resolve) => { release = resolve; });
    const store = new GraphSetIndexStore(gated, { onMutation: (event) => events.push(event) });
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(gated.listGraphsCalls).toBe(1);

    const staleDelete = store.delete([q(graph)]);
    for (let i = 0; i < 10 && gated.hasGraphOptions.length === 0; i++) {
      await Promise.resolve();
    }
    expect(gated.hasGraphOptions).toHaveLength(1);
    await store.insert([q(graph, 'urn:after')]);
    release();
    await staleDelete;

    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(gated.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [],
      removed: [],
      source: 'delete',
    });
  });

  it('refreshes the full index after graph-wide deleteByPattern without a graph constraint', async () => {
    const counting = new CountingStore(new OxigraphStore());
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });
    await store.insert([q('did:dkg:context-graph:one'), q('did:dkg:context-graph:two')]);
    await expect(store.listGraphs()).resolves.toHaveLength(2);
    expect(counting.listGraphsCalls).toBe(1);

    await store.deleteByPattern({ predicate: 'urn:p' });
    expect(counting.listGraphsCalls).toBe(1);
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [],
      removed: [
        'did:dkg:context-graph:one',
        'did:dkg:context-graph:two',
      ],
      source: 'deleteByPattern',
    });
  });

  it('preserves deferred mutation source when hasGraph reads before listGraphs', async () => {
    const graph = 'did:dkg:context-graph:has-before-list';
    const counting = new CountingStore(new OxigraphStore());
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.deleteByPattern({ predicate: 'urn:p' });
    expect(counting.listGraphsCalls).toBe(1);

    await expect(store.hasGraph(graph)).resolves.toBe(false);
    expect(counting.listGraphsCalls).toBe(2);
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [],
      removed: [graph],
      source: 'deleteByPattern',
    });
    expect(events).not.toContainEqual({
      type: 'graph-removed',
      graph,
      source: 'revalidate',
    });
  });

  it('inherits mutator priority for touched-graph maintenance reads', async () => {
    const graph = 'did:dkg:context-graph:ack-maintenance';
    const counting = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    await store.deleteByPattern(
      { graph, predicate: 'urn:p' },
      { priority: 'ack', source: 'test.ack.deleteByPattern' },
    );

    expect(counting.hasGraphOptions.at(-1)).toMatchObject({
      priority: 'ack',
      source: 'test.ack.deleteByPattern',
    });
  });

  it('revalidates after the configured interval to discover out-of-contract writers', async () => {
    let now = 1_000;
    const inner = new OxigraphStore();
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100, now: () => now });

    await expect(store.listGraphs()).resolves.toEqual([]);
    await inner.insert([q('did:dkg:context-graph:external')]);

    now += 99;
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    now += 1;
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:external']);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('treats revalidateMs 0 as always expired', async () => {
    const inner = new OxigraphStore();
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, { revalidateMs: 0 });

    await expect(store.listGraphs()).resolves.toEqual([]);
    await inner.insert([q('did:dkg:context-graph:zero-revalidate')]);
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:zero-revalidate']);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('coalesces concurrent refresh callers onto one listGraphs scan', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q('did:dkg:context-graph:coalesced')]);
    const counting = new CountingStore(inner);
    let release!: () => void;
    counting.listGraphsGate = new Promise<void>((resolve) => { release = resolve; });
    const store = new GraphSetIndexStore(counting);

    const calls = Promise.all([
      store.listGraphs(),
      store.listGraphsByPrefix('did:dkg:context-graph:'),
      store.listGraphs(),
    ]);
    await Promise.resolve();
    expect(counting.listGraphsCalls).toBe(1);
    counting.listGraphsGate = null;
    release();

    const [a, b, c] = await calls;
    expect(a).toEqual(['did:dkg:context-graph:coalesced']);
    expect(b).toEqual(['did:dkg:context-graph:coalesced']);
    expect(c).toEqual(['did:dkg:context-graph:coalesced']);
  });

  it('restarts an in-flight refresh when a local write lands during the scan', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q('did:dkg:context-graph:before')]);
    const counting = new CountingStore(inner);
    let release!: () => void;
    counting.listGraphsGate = new Promise<void>((resolve) => { release = resolve; });
    const store = new GraphSetIndexStore(counting);

    const listed = store.listGraphs();
    await Promise.resolve();
    expect(counting.listGraphsCalls).toBe(1);

    await store.insert([q('did:dkg:context-graph:after')]);
    counting.listGraphsGate = null;
    release();

    await expect(listed).resolves.toEqual(
      expect.arrayContaining(['did:dkg:context-graph:before', 'did:dkg:context-graph:after']),
    );
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('restarts an in-flight refresh when a deferred SPARQL mutation lands during the scan', async () => {
    const graph = 'did:dkg:context-graph:deferred-during-scan';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q(graph)]);
        return emptyBindings();
      },
    });
    const events: GraphSetMutationEvent[] = [];
    let release!: () => void;
    counting.listGraphsGate = new Promise<void>((resolve) => { release = resolve; });
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });

    const listed = store.listGraphs();
    await Promise.resolve();
    expect(counting.listGraphsCalls).toBe(1);

    await store.query('INSERT DATA { GRAPH <g> { <urn:s> <urn:p> "v" } }');
    expect(counting.listGraphsCalls).toBe(1);
    counting.listGraphsGate = null;
    release();

    await expect(listed).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toEqual([
      {
        type: 'graph-set-revalidated',
        added: [graph],
        removed: [],
        source: 'query',
      },
    ]);
  });

  it('refreshes after successful mutating SPARQL passed through query()', async () => {
    const graph = 'did:dkg:context-graph:query-created';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q(graph)]);
        return emptyBindings();
      },
    });
    const store = new GraphSetIndexStore(counting);
    await expect(store.listGraphs()).resolves.toEqual([]);

    await store.query(`# cleanup\nINSERT DATA { GRAPH <${graph}> { <urn:s> <urn:p> "v" } }`);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
  });

  it('defers SPARQL updates: N updates cause zero eager rescans, then one coalesced rebuild on the next read', async () => {
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner, seq }) => {
        await inner.insert([q(`did:dkg:context-graph:seq-${seq}`)]);
        return emptyBindings();
      },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });
    // Seed the index (one scan).
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    // Three mutating SPARQL updates. Pre-fix each eager-rescanned the whole
    // store (calls would be 4 here); the fix defers them.
    await store.query('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:g0> } }');
    await store.query('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:g1> } }');
    await store.query('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:g2> } }');
    expect(counting.listGraphsCalls).toBe(1); // no eager rescan per update

    // The next read rebuilds exactly once and reflects ALL three writes
    // (read-after-write correctness preserved).
    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining([
        'did:dkg:context-graph:seq-0',
        'did:dkg:context-graph:seq-1',
        'did:dkg:context-graph:seq-2',
      ]),
    );
    expect(counting.listGraphsCalls).toBe(2); // single coalesced rebuild
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [
        'did:dkg:context-graph:seq-0',
        'did:dkg:context-graph:seq-1',
        'did:dkg:context-graph:seq-2',
      ],
      removed: [],
      source: 'query',
    });
  });

  it('runs deferred full rebuild scans on the background lane even when an ack read waits for them', async () => {
    const graph = 'did:dkg:context-graph:ack-triggered-rebuild';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q(graph)]);
        return emptyBindings();
      },
    });
    const store = new GraphSetIndexStore(counting);
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.query(`INSERT DATA { GRAPH <${graph}> { <urn:s> <urn:p> "v" } }`);
    expect(counting.listGraphsCalls).toBe(1);

    await expect(store.listGraphs({ priority: 'ack', source: 'test.ack.listGraphs' })).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(counting.listGraphsOptions.at(-1)).toMatchObject({
      priority: 'background',
      source: 'graph-set-index.rebuild',
    });
  });

  it('a SPARQL update marks the index dirty so the next read rebuilds even within revalidateMs', async () => {
    let now = 1_000;
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner, seq }) => {
        await inner.insert([q(`did:dkg:context-graph:seq-${seq}`)]);
        return emptyBindings();
      },
    });
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100_000, now: () => now });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    // Well within revalidateMs — a read alone would serve cache — but a mutating
    // update forces the next read to rebuild (freshness, not staleness).
    await store.query('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:g> } }');
    now += 1;
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:seq-0']);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('defers update(): updates cause zero eager rescans, then one coalesced rebuild on the next read', async () => {
    let now = 1_000;
    const counting = new MutationHookStore(new OxigraphStore(), {
      onUpdate: async ({ inner, seq }) => {
        await inner.insert([q(`did:dkg:context-graph:update-${seq}`)]);
      },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, {
      revalidateMs: 100_000,
      now: () => now,
      onMutation: (event) => events.push(event),
    });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.update('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:g0> } }');
    await store.update('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:g1> } }');
    expect(counting.listGraphsCalls).toBe(1);

    now += 1;
    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining([
        'did:dkg:context-graph:update-0',
        'did:dkg:context-graph:update-1',
      ]),
    );
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [
        'did:dkg:context-graph:update-0',
        'did:dkg:context-graph:update-1',
      ],
      removed: [],
      source: 'update',
    });
  });

  it('#1549: update() with declared touchedGraphs maintains the index INCREMENTALLY — no full rebuild scan', async () => {
    const healed = 'did:dkg:context-graph:heal';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onUpdate: async ({ inner }) => { await inner.insert([q(healed)]); },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, {
      revalidateMs: 100_000, now: () => 1_000, onMutation: (e) => events.push(e),
    });
    await store.insert([q('did:dkg:context-graph:seed')]);
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:seed']);
    expect(counting.listGraphsCalls).toBe(1);

    // A server-side UPDATE that creates a new graph, with the touched graph DECLARED.
    // Contrast with the "defers update()" test above (no touchedGraphs → a full
    // rebuild scan on the next read); here the index stays warm with zero scans.
    await store.update(
      'INSERT DATA { GRAPH <did:dkg:context-graph:heal> { <urn:s> <urn:p> "v" } }',
      { touchedGraphs: [healed] },
    );

    expect(counting.listGraphsCalls).toBe(1); // incremental hasGraph, NOT a full scan
    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining([healed, 'did:dkg:context-graph:seed']),
    );
    expect(counting.listGraphsCalls).toBe(1); // still warm — no rebuild triggered
    expect(events).toContainEqual({ type: 'graph-added', graph: healed, source: 'update' });
  });

  it('#1549: a rebuild triggered by an ack-priority read runs the full scan on the BACKGROUND lane, not ack', async () => {
    const counting = new MutationHookStore(new OxigraphStore(), {
      onUpdate: async ({ inner }) => { await inner.insert([q('did:dkg:context-graph:y')]); },
    });
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100_000, now: () => 1_000 });
    await store.insert([q('did:dkg:context-graph:x')]);
    await store.listGraphs(); // seed (listGraphsCalls = 1)
    expect(counting.listGraphsCalls).toBe(1);

    // Opaque update (NO touchedGraphs) marks the index dirty → next read rebuilds.
    await store.update('INSERT DATA { GRAPH <did:dkg:context-graph:y> { <urn:s> <urn:p> "v" } }');

    // An ACK-priority read on the dirty index forces the rebuild. The rebuild's full
    // SELECT DISTINCT ?g scan must NOT run on the ack lane (it would consume the
    // scarce reserved ACK slot); it is forced onto background + tagged.
    await store.listGraphsByPrefix('did:dkg:', { priority: 'ack', source: 'test.ack.read' });
    expect(counting.listGraphsCalls).toBe(2);

    const rebuildScan = counting.listGraphsOptions.at(-1);
    expect(rebuildScan).toMatchObject({ priority: 'background', source: 'graph-set-index.rebuild' });
    expect(rebuildScan?.priority).not.toBe('ack');
  });

  it('#1549: a cold/seed ack-priority read KEEPS the ACK lane (only the dirty rebuild is demoted)', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q('did:dkg:context-graph:seedme')]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting);

    // Cold index (graphs === null). An inbound StorageACK read must SEED on the ACK
    // lane — demoting the seed to background would make the first ACK after restart
    // wait behind saturated sync scans and miss its deadline.
    await expect(
      store.listGraphsByPrefix('did:dkg:', { priority: 'ack', source: 'test.ack.cold' }),
    ).resolves.toEqual(['did:dkg:context-graph:seedme']);
    expect(counting.listGraphsCalls).toBe(1);
    expect(counting.listGraphsOptions.at(-1)).toMatchObject({ priority: 'ack', source: 'test.ack.cold' });
  });

  it('#1549: update() with touchedGraphs REMOVES a graph emptied by a DELETE — no full rebuild scan', async () => {
    const graph = 'did:dkg:context-graph:prune-me';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onUpdate: async ({ inner }) => { await inner.deleteByPattern({ graph }); },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, {
      revalidateMs: 100_000, now: () => 1_000, onMutation: (e) => events.push(e),
    });
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(1);

    // A server-side DELETE that empties the graph, with the touched graph declared
    // (mirrors the agents-meta prune). The index REMOVES it via a bounded hasGraph,
    // never a full rebuild scan.
    await store.update(`DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`, { touchedGraphs: [graph] });

    expect(counting.listGraphsCalls).toBe(1); // incremental hasGraph, NOT a full scan
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1); // still warm — no rebuild triggered
    expect(events).toContainEqual({ type: 'graph-removed', graph, source: 'update' });
  });

  it('removes stale graph names after a deferred SPARQL query removal', async () => {
    const graph = 'did:dkg:context-graph:old-query';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.deleteByPattern({ graph });
        return emptyBindings();
      },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.query('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(counting.listGraphsCalls).toBe(1);

    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [],
      removed: [graph],
      source: 'query',
    });
  });

  it('removes stale graph names after a deferred update() removal', async () => {
    const graph = 'did:dkg:context-graph:old-update';
    const counting = new MutationHookStore(new OxigraphStore(), {
      onUpdate: async ({ inner }) => {
        await inner.deleteByPattern({ graph });
      },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, { onMutation: (event) => events.push(event) });
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(counting.listGraphsCalls).toBe(1);

    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated',
      added: [],
      removed: [graph],
      source: 'update',
    });
  });

  it('preserves the first deferred mutation source when later pending writes coalesce', async () => {
    const counting = new MutationHookStore(new OxigraphStore(), {
      onQuery: async ({ inner }) => {
        await inner.insert([q('did:dkg:context-graph:mixed-query')]);
        return emptyBindings();
      },
      onUpdate: async ({ inner, seq }) => {
        await inner.insert([q(`did:dkg:context-graph:update-${seq}`)]);
      },
    });
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(counting, {
      onMutation: (event) => events.push(event),
    });
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(1);

    await store.query('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:q> } }');
    await store.update('INSERT { GRAPH ?g { <urn:s> <urn:p> "v" } } WHERE { VALUES ?g { <urn:u> } }');
    expect(counting.listGraphsCalls).toBe(1);

    await expect(store.listGraphs()).resolves.toEqual(
      expect.arrayContaining([
        'did:dkg:context-graph:mixed-query',
        'did:dkg:context-graph:update-0',
      ]),
    );
    expect(counting.listGraphsCalls).toBe(2);
    expect(events).toEqual([
      {
        type: 'graph-set-revalidated',
        added: [
          'did:dkg:context-graph:mixed-query',
          'did:dkg:context-graph:update-0',
        ],
        removed: [],
        source: 'query',
      },
    ]);
  });

  it('does not let observer failures reject committed writes', async () => {
    const store = new GraphSetIndexStore(new CountingStore(new OxigraphStore()), {
      onMutation: () => {
        throw new Error('observer failed');
      },
    });
    await store.listGraphs();

    await expect(store.insert([q('did:dkg:context-graph:observer')])).resolves.toBeUndefined();
    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:observer']);
  });

  it('clears the index instead of rejecting after post-commit maintenance failures', async () => {
    const graph = 'did:dkg:context-graph:maintenance-failure';
    const failing = new FailingMaintenanceStore(new OxigraphStore());
    const store = new GraphSetIndexStore(failing);
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    failing.failHasGraph = true;
    await expect(store.delete([q(graph)])).resolves.toBeUndefined();

    failing.failHasGraph = false;
    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('retries a failed lazy full refresh after graph-less deleteByPattern', async () => {
    const graph = 'did:dkg:context-graph:refresh-failure';
    const failing = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(failing);
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    await expect(store.deleteByPattern({ predicate: 'urn:p' })).resolves.toBe(1);
    expect(failing.listGraphsCalls).toBe(1);

    failing.failListGraphs = true;
    await expect(store.listGraphs()).rejects.toThrow('listGraphs failed');
    expect(failing.listGraphsCalls).toBe(2);
    failing.failListGraphs = false;
    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(failing.listGraphsCalls).toBe(3);
  });

  it('createTripleStore wraps local and managed stores by default, composes outside large-literal storage, and can be disabled', async () => {
    const defaultStore = await createTripleStore({ backend: 'oxigraph' });
    expect(typeof defaultStore.listGraphsByPrefix).toBe('function');
    await defaultStore.close();

    const disabledStore = await createTripleStore({ backend: 'oxigraph', graphSetIndex: false });
    expect(disabledStore.listGraphsByPrefix).toBeUndefined();
    await disabledStore.close();

    const blobDir = await mkdtemp(join(tmpdir(), 'dkg-graph-set-index-'));
    try {
      const composedStore = await createTripleStore({
        backend: 'oxigraph',
        largeLiteralStorage: { directory: blobDir, thresholdBytes: 1 },
      });
      expect(typeof composedStore.listGraphsByPrefix).toBe('function');
      await composedStore.insert([q('did:dkg:context-graph:composed')]);
      await expect(composedStore.listGraphsByPrefix!('did:dkg:context-graph:comp')).resolves.toEqual([
        'did:dkg:context-graph:composed',
      ]);
      await composedStore.close();
    } finally {
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  it('leaves operator-managed external stores uncached unless explicitly enabled', async () => {
    const operatorStore = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://example.invalid/query' },
    });
    expect(operatorStore.listGraphsByPrefix).toBeUndefined();
    await operatorStore.close();

    const managedStore = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://example.invalid/query', managedByDkg: true },
    });
    expect(typeof managedStore.listGraphsByPrefix).toBe('function');
    await managedStore.close();

    const optedInStore = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://example.invalid/query' },
      graphSetIndex: { revalidateMs: 0 },
    });
    expect(typeof optedInStore.listGraphsByPrefix).toBe('function');
    await optedInStore.close();
  });

  it('leaves custom backends uncached unless explicitly enabled', async () => {
    const backend = 'custom-remote-graph-set-index-test';
    registerTripleStoreAdapter(backend, async () => new OxigraphStore());

    const defaultStore = await createTripleStore({ backend });
    expect(defaultStore.listGraphsByPrefix).toBeUndefined();
    await defaultStore.close();

    const optedInStore = await createTripleStore({ backend, graphSetIndex: true });
    expect(typeof optedInStore.listGraphsByPrefix).toBe('function');
    await optedInStore.close();
  });
});
