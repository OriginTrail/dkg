import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  ChangelogStore,
  BlazegraphStore,
  GraphSetIndexStore,
  OxigraphStore,
  SparqlHttpStore,
  StoreSchedulerBusyError,
  StorePriorityScheduler,
  createManagedOxigraphRuntimeStoreConfigV1,
  createTripleStore,
  registerTripleStoreAdapter,
  type GraphSetIndexStoreOptions,
  type GraphSetMutationEvent,
  type Quad,
  type QueryOptions,
  type StoreWorkPriority,
  type TripleStore,
} from '../src/index.js';

import {
  ControlledProbeStore,
  CountingStore,
  MutationHookStore,
  emptyBindings,
  q,
} from './graph-set-index-store-harness.js';

class FailingMaintenanceStore extends CountingStore {
  failHasGraph = false;

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (this.failHasGraph) throw new Error('hasGraph failed');
    return super.hasGraph(graphUri, options);
  }
}

class PostCommitProbeBusyStore extends CountingStore {
  private rejectNextPresenceProbe = false;

  async replaceGraph(
    graphUri: string,
    quads: Quad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (typeof this.inner.replaceGraph !== 'function') {
      throw new Error('inner store does not support replaceGraph()');
    }
    await this.inner.replaceGraph(graphUri, quads, options);
    this.rejectNextPresenceProbe = true;
  }

  override hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (this.rejectNextPresenceProbe) {
      this.rejectNextPresenceProbe = false;
      throw new StoreSchedulerBusyError(
        'queue_wait_timeout',
        'normal',
        'sparql-http.hasGraph',
        { storeOperation: 'hasGraph' },
      );
    }
    return super.hasGraph(graphUri, options);
  }
}

class ScheduledGraphListStore extends CountingStore {
  readonly listGraphsGates: Partial<Record<StoreWorkPriority, Promise<void>>> = {};
  readonly listGraphsResults: Partial<Record<StoreWorkPriority, string[]>> = {};

  constructor(
    inner: OxigraphStore,
    private readonly scheduler: StorePriorityScheduler,
  ) {
    super(inner);
  }

  override listGraphs(options?: QueryOptions): Promise<string[]> {
    return this.scheduler.run(
      options?.priority,
      options?.source ?? 'test.graph-set.listGraphs',
      async () => {
        this.listGraphsCalls++;
        this.listGraphsOptions.push(options);
        const priority = options?.priority ?? 'normal';
        const gate = this.listGraphsGates[priority];
        if (gate) await gate;
        const result = this.listGraphsResults[priority];
        if (result) return result;
        return this.inner.listGraphs(options);
      },
      options?.signal,
    );
  }
}

async function exhaustTouchedGraphProbeRetries(
  store: GraphSetIndexStore,
  controlled: ControlledProbeStore,
  probed: string,
): Promise<string[]> {
  controlled.enableProbeGates();
  const mutation = store.delete([q(probed)]);
  const expectedGraphs: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await controlled.waitForProbe();
    const graph = `did:dkg:context-graph:churn-${attempt}`;
    expectedGraphs.push(graph);
    await store.insert([q(graph)]);
    controlled.releaseProbe();
  }
  await mutation;
  controlled.disableProbeGates();
  return expectedGraphs;
}

describe('GraphSetIndexStore', () => {
  for (const adapter of [
    {
      name: 'BlazegraphStore',
      create: (scheduler: StorePriorityScheduler): TripleStore => new BlazegraphStore(
        'http://blazegraph.test/sparql',
        { scheduler, timeout: 1_000 },
      ),
    },
    {
      name: 'SparqlHttpStore',
      create: (scheduler: StorePriorityScheduler): TripleStore => new SparqlHttpStore({
        queryEndpoint: 'http://sparql.test/query',
        updateEndpoint: 'http://sparql.test/update',
        consistencyProfile: 'atomic-update',
        scheduler,
        timeout: 1_000,
      }),
    },
  ]) {
    it(`keeps a warm index when the real ${adapter.name} boundary rejects before dispatch`, async () => {
      const existing = 'did:dkg:context-graph:existing';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({
          head: { vars: ['g'] },
          results: { bindings: [{ g: { type: 'uri', value: existing } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } },
      ));
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: 1,
        queueWaitTimeoutMs: 10,
      });
      const inner = adapter.create(scheduler);
      const diagnostics: unknown[] = [];
      const store = new GraphSetIndexStore(inner, {
        revalidateMs: 100_000,
        now: () => 1_000,
        onDiagnostic: (event) => diagnostics.push(event),
      } as GraphSetIndexStoreOptions);
      let releaseBlocker!: () => void;
      let blockerStarted = false;
      let blocker: Promise<void> | undefined;

      try {
        await expect(store.listGraphs()).resolves.toEqual([existing]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        blocker = scheduler.run('normal', 'test.atomic-replace-blocker', async () => {
          blockerStarted = true;
          await new Promise<void>((resolve) => { releaseBlocker = resolve; });
        });
        await Promise.resolve();
        expect(blockerStarted).toBe(true);

        for (const [storeOperation, work] of [
          ['replaceGraph', () => store.replaceGraph('urn:graph', [q('urn:graph')])],
          ['replaceGraphAndSubject', () => store.replaceGraphAndSubject(
            'urn:graph',
            [q('urn:graph')],
            'urn:meta',
            'urn:subject',
            [q('urn:meta', 'urn:subject')],
          )],
          ['replaceSubject', () => store.replaceSubject(
            'urn:graph', 'urn:subject', [q('urn:graph', 'urn:subject')],
          )],
        ] as const) {
          await expect(work()).rejects.toMatchObject({
            code: 'STORE_SCHEDULER_BUSY',
            outcome: 'not_started',
            storeOperation,
          });
        }

        for (const [storeOperation, read] of [
          ['hasGraph', () => inner.hasGraph('urn:probe')],
          ['listGraphs', () => inner.listGraphs()],
          ['countQuads', () => inner.countQuads('urn:probe')],
        ] as const) {
          await expect(read()).rejects.toMatchObject({
            code: 'STORE_SCHEDULER_BUSY',
            outcome: 'not_started',
            storeOperation,
          });
        }
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await expect(store.listGraphs()).resolves.toEqual([existing]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(diagnostics).toEqual([]);
      } finally {
        releaseBlocker?.();
        if (blocker) await blocker;
        await inner.close();
        fetchSpy.mockRestore();
      }
    });
  }

  it('dirties the index when a nested post-commit probe is rejected before dispatch', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q('did:dkg:context-graph:existing')]);
    const backend = new PostCommitProbeBusyStore(inner);
    const changelog = new ChangelogStore(backend);
    const store = new GraphSetIndexStore(changelog, { revalidateMs: 100_000 });

    await expect(store.listGraphs()).resolves.toEqual(['did:dkg:context-graph:existing']);
    expect(backend.listGraphsCalls).toBe(1);

    await expect(store.replaceGraph('urn:committed', [q('urn:committed')]))
      .rejects.toBeInstanceOf(StoreSchedulerBusyError);
    expect(changelog.needsReconcile).toBe(true);

    await expect(store.listGraphs()).resolves.toEqual(expect.arrayContaining([
      'did:dkg:context-graph:existing',
      'urn:committed',
    ]));
    expect(backend.listGraphsCalls).toBe(2);
    await inner.close();
  });

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
    const gated = new ControlledProbeStore(inner);
    const events: GraphSetMutationEvent[] = [];
    gated.enableProbeGates();
    const store = new GraphSetIndexStore(gated, { onMutation: (event) => events.push(event) });
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(gated.listGraphsCalls).toBe(1);

    const staleDelete = store.delete([q(graph)]);
    await gated.waitForProbe();
    expect(gated.hasGraphOptions).toHaveLength(1);
    await store.insert([q(graph, 'urn:after')]);
    gated.disableProbeGates();
    gated.releaseProbe();
    await staleDelete;

    // The stale probe observed the graph absent mid-race; that result is
    // discarded and the maintenance re-probes, observing the concurrent
    // insert's re-created graph — the index stays warm with no rebuild scan.
    await expect(store.listGraphs()).resolves.toEqual([graph]);
    expect(gated.listGraphsCalls).toBe(1);
    expect(gated.hasGraphOptions).toHaveLength(2);
    expect(events).not.toContainEqual({
      type: 'graph-removed',
      graph,
      source: 'delete',
    });
  });

  it('concurrent mutation during an in-flight touched-graph probe re-probes instead of scheduling a full rebuild', async () => {
    const probed = 'did:dkg:context-graph:probe-under-race';
    const concurrent = 'did:dkg:context-graph:concurrent-writer';
    const inner = new OxigraphStore();
    await inner.insert([q(probed)]);
    const gated = new ControlledProbeStore(inner);
    const events: GraphSetMutationEvent[] = [];
    gated.enableProbeGates();
    const store = new GraphSetIndexStore(gated, { onMutation: (event) => events.push(event) });
    await expect(store.listGraphs()).resolves.toEqual([probed]);
    expect(gated.listGraphsCalls).toBe(1);

    // A graph-scoped delete whose incremental maintenance probes
    // hasGraph(probed) and parks on the gate mid-flight.
    const racedDelete = store.delete([q(probed)]);
    await gated.waitForProbe();
    expect(gated.hasGraphOptions).toHaveLength(1);

    // A DIFFERENT-graph write lands while that probe is in flight, bumping the
    // mutation generation (insert maintains synchronously — no probe of its own).
    await store.insert([q(concurrent)]);
    gated.disableProbeGates();
    gated.releaseProbe();
    await racedDelete;

    // The maintenance RE-PROBED (second hasGraph call) and applied the result
    // incrementally. Pre-fix this race demoted to scheduleFullRefresh and the
    // read below would re-scan (listGraphsCalls = 2).
    expect(gated.hasGraphOptions).toHaveLength(2);
    await expect(store.listGraphs()).resolves.toEqual([concurrent]);
    expect(gated.listGraphsCalls).toBe(1);
    expect(events).toContainEqual({ type: 'graph-removed', graph: probed, source: 'delete' });
    expect(events).toContainEqual({ type: 'graph-added', graph: concurrent, source: 'insert' });
  });

  it('falls back to one background full rebuild when the generation stays unstable past the probe-retry cap', async () => {
    const probed = 'did:dkg:context-graph:churn-victim';
    const inner = new OxigraphStore();
    await inner.insert([q(probed)]);
    const stepped = new ControlledProbeStore(inner);
    const diagnostics: unknown[] = [];
    const store = new GraphSetIndexStore(stepped, {
      onDiagnostic: (event) => diagnostics.push(event),
    } as GraphSetIndexStoreOptions);
    await expect(store.listGraphs()).resolves.toEqual([probed]);
    expect(stepped.listGraphsCalls).toBe(1);

    // MAINTAIN_INDEX_MAX_PROBE_RETRIES = 4: bump the generation during every
    // in-flight probe so each attempt observes drift and the retry cap exhausts.
    const expectedGraphs = await exhaustTouchedGraphProbeRetries(store, stepped, probed);

    // Exactly the capped number of probes ran, then the maintenance demoted to
    // a deferred dirty rebuild realized by the next read — on the background lane.
    expect(stepped.hasGraphOptions).toHaveLength(4);
    const graphs = await store.listGraphs();
    expect(graphs).not.toContain(probed);
    expect(new Set(graphs)).toEqual(new Set(expectedGraphs));
    expect(stepped.listGraphsCalls).toBe(2);
    expect(stepped.listGraphsOptions.at(-1)).toMatchObject({
      priority: 'background',
      source: 'graph-set-index.rebuild',
    });
    expect(diagnostics).toEqual([
      { type: 'probe-retry-exhausted', source: 'delete', probeCount: 4 },
      { type: 'dirty-rebuild', source: 'delete', graphCount: 4 },
    ]);
  });

  it('ignores an internal diagnostic observer failure and still schedules the fallback rebuild', async () => {
    const probed = 'did:dkg:context-graph:throwing-diagnostic-victim';
    const inner = new OxigraphStore();
    await inner.insert([q(probed)]);
    const controlled = new ControlledProbeStore(inner);
    const store = new GraphSetIndexStore(controlled, {
      onDiagnostic: () => { throw new Error('diagnostic observer failed'); },
    } as GraphSetIndexStoreOptions);
    await expect(store.listGraphs()).resolves.toEqual([probed]);

    await expect(
      exhaustTouchedGraphProbeRetries(store, controlled, probed),
    ).resolves.toHaveLength(4);
    await expect(store.listGraphs()).resolves.not.toContain(probed);
    expect(controlled.listGraphsCalls).toBe(2);
    expect(controlled.listGraphsOptions.at(-1)).toMatchObject({
      priority: 'background',
      source: 'graph-set-index.rebuild',
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

  it('keeps graph membership correct after a no-count pattern delete', async () => {
    const graph = 'did:dkg:context-graph:no-count-delete';
    const counting = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await store.insert([q(graph)]);
    await expect(store.listGraphs()).resolves.toEqual([graph]);

    await store.deleteByPatternWithoutCount({ graph, predicate: 'urn:p' });

    await expect(store.listGraphs()).resolves.toEqual([]);
  });

  it('invalidates the full index after a graph-less no-count pattern delete', async () => {
    const counting = new CountingStore(new OxigraphStore());
    const store = new GraphSetIndexStore(counting);
    await store.insert([q('did:dkg:context-graph:no-count-one')]);
    await expect(store.listGraphs()).resolves.toHaveLength(1);
    expect(counting.listGraphsCalls).toBe(1);

    await store.deleteByPatternWithoutCount({ predicate: 'urn:p' });
    expect(counting.listGraphsCalls).toBe(1);

    await expect(store.listGraphs()).resolves.toEqual([]);
    expect(counting.listGraphsCalls).toBe(2);
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

  it('serves a warm index and exponentially backs off failed periodic revalidations', async () => {
    let now = 1_000;
    const cached = 'did:dkg:context-graph:cached';
    const external = 'did:dkg:context-graph:external-after-failure';
    const inner = new OxigraphStore();
    await inner.insert([q(cached)]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, {
      revalidateMs: 100,
      revalidateFailureBackoffMs: 10,
      revalidateFailureMaxBackoffMs: 40,
      now: () => now,
    });

    await expect(store.listGraphs()).resolves.toEqual([cached]);
    await inner.insert([q(external)]);
    counting.failListGraphs = true;

    // The first expired periodic refresh fails, but the warm write-through set
    // remains serviceable. Repeated readers do not immediately re-run the scan.
    now += 100;
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(2);
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    now += 9;
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(2);

    // Failure delays grow 10 -> 20 -> 40 ms and are bounded at 40 ms.
    now += 1;
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(3);
    now += 19;
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(3);
    now += 1;
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(4);
    now += 39;
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(4);

    counting.failListGraphs = false;
    now += 1;
    await expect(store.listGraphs()).resolves.toEqual(expect.arrayContaining([cached, external]));
    expect(counting.listGraphsCalls).toBe(5);

    // A successful refresh resets the exponential sequence to its initial delay.
    counting.failListGraphs = true;
    now += 100;
    await expect(store.listGraphs()).resolves.toEqual(expect.arrayContaining([cached, external]));
    expect(counting.listGraphsCalls).toBe(6);
    now += 9;
    await expect(store.listGraphs()).resolves.toEqual(expect.arrayContaining([cached, external]));
    expect(counting.listGraphsCalls).toBe(6);
    now += 1;
    await expect(store.listGraphs()).resolves.toEqual(expect.arrayContaining([cached, external]));
    expect(counting.listGraphsCalls).toBe(7);
  });

  it('keeps a failed cold seed strict instead of serving an empty graph set', async () => {
    const counting = new CountingStore(new OxigraphStore());
    counting.failListGraphs = true;
    const store = new GraphSetIndexStore(counting);

    await expect(store.listGraphs()).rejects.toThrow('listGraphs failed');
    expect(counting.listGraphsCalls).toBe(1);
    counting.failListGraphs = false;
    await expect(store.listGraphs()).resolves.toEqual([]);
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

  it('retries every read after a warm revalidation failure when revalidateMs is 0', async () => {
    const now = 1_000;
    const cached = 'did:dkg:context-graph:cached-zero-revalidate';
    const recovered = 'did:dkg:context-graph:recovered-zero-revalidate';
    const inner = new OxigraphStore();
    await inner.insert([q(cached)]);
    const counting = new CountingStore(inner);
    const store = new GraphSetIndexStore(counting, {
      revalidateMs: 0,
      revalidateFailureBackoffMs: 10,
      now: () => now,
    });

    await expect(store.listGraphs()).resolves.toEqual([cached]);
    await inner.insert([q(recovered)]);
    counting.failListGraphs = true;

    // A failed warm scan still serves the last known set for availability.
    await expect(store.listGraphs()).resolves.toEqual([cached]);
    expect(counting.listGraphsCalls).toBe(2);

    // Recovery is visible on the very next read at the same timestamp. The
    // configured failure delay must not override the always-revalidate contract.
    counting.failListGraphs = false;
    await expect(store.listGraphs()).resolves.toEqual(expect.arrayContaining([cached, recovered]));
    expect(counting.listGraphsCalls).toBe(3);
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

  it('lets an ack seed bypass an in-flight background seed through the reserved scheduler lane', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 1,
      normalReservedSlots: 0,
      backgroundReservedSlots: 0,
    });
    const inner = new OxigraphStore();
    const staleGraph = 'did:dkg:context-graph:background-snapshot';
    const freshGraph = 'did:dkg:context-graph:ack-snapshot';
    const scheduled = new ScheduledGraphListStore(inner, scheduler);
    scheduled.listGraphsResults.background = [staleGraph];
    scheduled.listGraphsResults.ack = [freshGraph];
    let releaseBackground!: () => void;
    let releaseAck!: () => void;
    scheduled.listGraphsGates.background = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    scheduled.listGraphsGates.ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const store = new GraphSetIndexStore(scheduled);
    const background = store.listGraphs({
      priority: 'background',
      source: 'agent.finalization.sharedMemorySlice',
    });
    let ack: Promise<string[]> | undefined;

    try {
      await Promise.resolve();
      expect(scheduled.listGraphsCalls).toBe(1);
      expect(scheduler.snapshot).toMatchObject({
        ackInflight: 0,
        ackQueued: 0,
        backgroundInflight: 1,
      });

      ack = store.listGraphs({
        priority: 'ack',
        source: 'publisher.storageACK.sharedMemorySlice',
      });
      await Promise.resolve();

      expect(scheduled.listGraphsCalls).toBe(2);
      expect(scheduled.listGraphsOptions).toEqual([
        {
          priority: 'background',
          source: 'agent.finalization.sharedMemorySlice',
        },
        {
          priority: 'ack',
          source: 'publisher.storageACK.sharedMemorySlice',
        },
      ]);
      expect(scheduler.snapshot).toMatchObject({
        ackInflight: 1,
        ackQueued: 0,
        backgroundInflight: 1,
      });

      releaseAck();
      await expect(ack).resolves.toEqual([freshGraph]);
      expect(scheduler.snapshot).toMatchObject({
        ackInflight: 0,
        backgroundInflight: 1,
      });

      // The older background response completes last with a stale snapshot. It
      // must neither overwrite the ACK result nor return stale data to its waiter.
      releaseBackground();
      await expect(background).resolves.toEqual([freshGraph]);
      await expect(store.listGraphs()).resolves.toEqual([freshGraph]);
      expect(scheduled.listGraphsCalls).toBe(2);
    } finally {
      releaseAck();
      releaseBackground();
      await Promise.allSettled([background, ...(ack ? [ack] : [])]);
    }
  });

  it('lets a normal seed bypass an in-flight background seed through the reserved scheduler lane', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 0,
      // Pin the pre-health-lane 2-slot ordinary pool this scenario was designed
      // around. Commit 4057c25df added DEFAULT_HEALTH_RESERVED_SLOTS=1, which would
      // otherwise steal the 2nd of 2 slots and clamp normalReservedSlots to 0, so
      // the normal read could not bypass the in-flight background seed. Production
      // (DEFAULT_MAX_CONCURRENT=4) keeps a 2-slot ordinary pool, so the bypass
      // invariant still holds there; only this contrived 2-slot config needs it.
      healthReservedSlots: 0,
      normalReservedSlots: 1,
      backgroundReservedSlots: 0,
    });
    const inner = new OxigraphStore();
    const staleGraph = 'did:dkg:context-graph:background-normal-promotion';
    const freshGraph = 'did:dkg:context-graph:normal-promoted-snapshot';
    const scheduled = new ScheduledGraphListStore(inner, scheduler);
    scheduled.listGraphsResults.background = [staleGraph];
    scheduled.listGraphsResults.normal = [freshGraph];
    let releaseBackground!: () => void;
    let releaseNormal!: () => void;
    scheduled.listGraphsGates.background = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    scheduled.listGraphsGates.normal = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    const store = new GraphSetIndexStore(scheduled);
    const background = store.listGraphs({
      priority: 'background',
      source: 'agent.finalization.sharedMemorySlice',
    });
    let normal: Promise<string[]> | undefined;

    try {
      await Promise.resolve();
      expect(scheduled.listGraphsCalls).toBe(1);
      expect(scheduler.snapshot).toMatchObject({
        normalInflight: 0,
        normalQueued: 0,
        backgroundInflight: 1,
      });

      normal = store.listGraphs({
        priority: 'normal',
        source: 'agent.query.sharedMemorySlice',
      });
      await Promise.resolve();

      expect(scheduled.listGraphsCalls).toBe(2);
      expect(scheduled.listGraphsOptions).toEqual([
        {
          priority: 'background',
          source: 'agent.finalization.sharedMemorySlice',
        },
        {
          priority: 'normal',
          source: 'agent.query.sharedMemorySlice',
        },
      ]);
      expect(scheduler.snapshot).toMatchObject({
        normalInflight: 1,
        normalQueued: 0,
        backgroundInflight: 1,
      });

      // Normal completes through its reserved lane while background remains
      // blocked; graph-index coalescing must not capture it first.
      releaseNormal();
      await expect(normal).resolves.toEqual([freshGraph]);
      expect(scheduler.snapshot).toMatchObject({
        normalInflight: 0,
        backgroundInflight: 1,
      });

      releaseBackground();
      await expect(background).resolves.toEqual([freshGraph]);
      await expect(store.listGraphs()).resolves.toEqual([freshGraph]);
      expect(scheduled.listGraphsCalls).toBe(2);
    } finally {
      releaseNormal();
      releaseBackground();
      await Promise.allSettled([background, ...(normal ? [normal] : [])]);
    }
  });

  it('ignores an older failed background revalidation after a promoted refresh publishes', async () => {
    let now = 1_000;
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 0,
      // Pin the pre-health-lane 2-slot ordinary pool this scenario was designed
      // around. Commit 4057c25df added DEFAULT_HEALTH_RESERVED_SLOTS=1, which would
      // otherwise steal the 2nd of 2 slots and clamp normalReservedSlots to 0, so
      // the normal read could not bypass the in-flight background seed. Production
      // (DEFAULT_MAX_CONCURRENT=4) keeps a 2-slot ordinary pool, so the bypass
      // invariant still holds there; only this contrived 2-slot config needs it.
      healthReservedSlots: 0,
      normalReservedSlots: 1,
      backgroundReservedSlots: 0,
    });
    const cachedGraph = 'did:dkg:context-graph:cached-before-promotion';
    const freshGraph = 'did:dkg:context-graph:fresh-promoted-snapshot';
    const nextGraph = 'did:dkg:context-graph:next-periodic-snapshot';
    const scheduled = new ScheduledGraphListStore(new OxigraphStore(), scheduler);
    scheduled.listGraphsResults.normal = [cachedGraph];
    const store = new GraphSetIndexStore(scheduled, {
      revalidateMs: 100,
      revalidateFailureBackoffMs: 1_000,
      now: () => now,
    });

    await expect(store.listGraphs()).resolves.toEqual([cachedGraph]);
    expect(scheduled.listGraphsCalls).toBe(1);

    now += 100;
    let rejectBackground!: (error: Error) => void;
    scheduled.listGraphsGates.background = new Promise<void>((_resolve, reject) => {
      rejectBackground = reject;
    });
    const background = store.listGraphs({
      priority: 'background',
      source: 'agent.finalization.sharedMemorySlice',
    });

    try {
      await Promise.resolve();
      expect(scheduled.listGraphsCalls).toBe(2);
      expect(scheduler.snapshot.backgroundInflight).toBe(1);

      scheduled.listGraphsResults.normal = [freshGraph];
      const normal = store.listGraphs({
        priority: 'normal',
        source: 'agent.query.sharedMemorySlice',
      });
      await expect(normal).resolves.toEqual([freshGraph]);
      expect(scheduled.listGraphsCalls).toBe(3);
      expect(scheduler.snapshot.backgroundInflight).toBe(1);

      // The older failure is superseded by the normal publication: its waiter
      // receives the fresh set instead of rejecting or applying failure backoff.
      rejectBackground(new Error('older background revalidation failed'));
      await expect(background).resolves.toEqual([freshGraph]);

      // The promoted success scheduled the next normal revalidation for +100ms.
      // If the older failure applied its 1s backoff, this read would not scan.
      now += 100;
      scheduled.listGraphsResults.normal = [freshGraph, nextGraph];
      await expect(store.listGraphs({ priority: 'normal' })).resolves.toEqual([
        freshGraph,
        nextGraph,
      ]);
      expect(scheduled.listGraphsCalls).toBe(4);
    } finally {
      rejectBackground(new Error('test cleanup'));
      await Promise.allSettled([background]);
    }
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
      { touchedGraphs: [healed], priority: 'ack', source: 'test.explicit-update' },
    );

    expect(counting.listGraphsCalls).toBe(1); // incremental hasGraph, NOT a full scan
    expect(counting.hasGraphOptions.at(-1)).toEqual({
      priority: 'ack',
      source: 'test.explicit-update',
    });
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

  it('preserves atomic graph replacement when a managed SPARQL store is index-wrapped', async () => {
    let updateRequests = 0;
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        if (body.trimStart().startsWith('ASK')) {
          response.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
          response.end(JSON.stringify({ boolean: true }));
          return;
        }
        updateRequests++;
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}/sparql`;
    const store = await createTripleStore(createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: {
        queryEndpoint: endpoint,
        updateEndpoint: endpoint,
        managedByDkg: true,
      },
    }));
    try {
      const graph = 'did:dkg:context-graph:managed-atomic';
      await expect(store.replaceGraph!(graph, [q(graph)])).resolves.toBeUndefined();
      expect(updateRequests).toBe(1);
    } finally {
      await store.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
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
