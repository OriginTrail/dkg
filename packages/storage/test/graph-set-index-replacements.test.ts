import { afterEach, describe, expect, it } from 'vitest';
import {
  GraphSetIndexStore, OxigraphStore, StoreSchedulerBusyError,
  UnsupportedTripleStoreCapabilityError,
  type GraphSetMutationEvent, type Quad, type QueryOptions,
} from '../src/index.js';
import type { StoreOperation } from '../src/store-operation-outcome.js';
import { CountingStore, q } from './graph-set-index-store-harness.js';

const GRAPH = 'urn:test:replacement';
const OTHER = 'urn:test:unrelated';
const SUBJECT = 'urn:test:subject';
const OPERATIONS = ['replaceGraph', 'replaceSubject', 'replaceSubjectAndInsert'] as const;
type ReplacementOperation = typeof OPERATIONS[number];

class ReplacementStore extends CountingStore {
  readonly backend: OxigraphStore;
  calls: Array<{ operation: ReplacementOperation; args: unknown[]; options?: QueryOptions }> = [];
  scopes: StoreOperation[] = [];
  scopedOptions: QueryOptions | undefined;
  insideScope = false;
  probesInsideScope: boolean[] = [];
  failure: Error | undefined;
  commitBeforeFailure = false;

  constructor() {
    const backend = new OxigraphStore();
    super(backend);
    this.backend = backend;
  }

  async runLogicalMutation<T>(
    operation: StoreOperation, options: QueryOptions | undefined,
    work: (options: QueryOptions | undefined) => Promise<T>,
  ): Promise<T> {
    this.scopes.push(operation);
    this.scopedOptions = { ...options, source: `${options?.source ?? 'test'}.scoped` };
    this.insideScope = true;
    try { return await work(this.scopedOptions); }
    finally { this.insideScope = false; }
  }

  override hasGraph(graph: string, options?: QueryOptions): Promise<boolean> {
    this.probesInsideScope.push(this.insideScope);
    return super.hasGraph(graph, options);
  }

  private async dispatch(
    operation: ReplacementOperation, args: unknown[], options: QueryOptions | undefined,
    work: () => Promise<void>,
  ): Promise<void> {
    expect(this.insideScope).toBe(true);
    this.calls.push({ operation, args, options });
    if (!this.failure || this.commitBeforeFailure) await work();
    if (this.failure) throw this.failure;
  }

  replaceGraph(graph: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.dispatch('replaceGraph', [graph, quads], options,
      () => this.backend.replaceGraph(graph, quads));
  }

  replaceSubject(graph: string, subject: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    return this.dispatch('replaceSubject', [graph, subject, quads], options,
      () => this.backend.replaceSubject(graph, subject, quads));
  }

  replaceSubjectAndInsert(
    graph: string, subject: string, replacement: Quad[], inserts: Quad[], options?: QueryOptions,
  ): Promise<void> {
    return this.dispatch('replaceSubjectAndInsert', [graph, subject, replacement, inserts], options,
      () => this.backend.replaceSubjectAndInsert(graph, subject, replacement, inserts, options));
  }
}

function replace(
  store: GraphSetIndexStore, operation: ReplacementOperation, quads: Quad[], options?: QueryOptions,
): Promise<void> {
  if (operation === 'replaceGraph') return store.replaceGraph(GRAPH, quads, options);
  if (operation === 'replaceSubject') return store.replaceSubject(GRAPH, SUBJECT, quads, options);
  return store.replaceSubjectAndInsert(GRAPH, SUBJECT, quads, [], options);
}

describe.each(OPERATIONS)('graph index %s replacement lifecycle', (operation) => {
  let inner: ReplacementStore;
  afterEach(async () => { await inner?.close(); });

  function fixture(enabled = true) {
    inner = new ReplacementStore();
    const events: GraphSetMutationEvent[] = [];
    const store = new GraphSetIndexStore(inner, {
      enabled, revalidateMs: 100_000, onMutation: event => events.push(event),
    });
    return { store, events };
  }

  it('forwards the receiver and scoped options once, adding and removing only the touched graph', async () => {
    const { store, events } = fixture();
    await inner.backend.insert([q(OTHER)]);
    expect(await store.listGraphs()).toEqual([OTHER]);
    const options: QueryOptions = {
      source: 'test.replacement', priority: 'background', signal: new AbortController().signal,
    };
    const quads = [q(GRAPH, SUBJECT)];
    await replace(store, operation, quads, options);
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.operation).toBe(operation);
    expect(inner.calls[0]!.args[operation === 'replaceGraph' ? 1 : 2]).toBe(quads);
    expect(inner.calls[0]!.options).toBe(inner.scopedOptions);
    expect(inner.scopedOptions).toEqual({ ...options, source: 'test.replacement.scoped' });
    expect(inner.hasGraphOptions).toEqual([inner.scopedOptions]);
    expect(inner.probesInsideScope).toEqual([true]);
    expect(await store.listGraphs()).toEqual([GRAPH, OTHER]);
    await replace(store, operation, [], options);
    expect(await store.listGraphs()).toEqual([OTHER]);
    expect(inner.listGraphsCalls).toBe(1);
    expect(inner.scopes).toEqual([operation, operation]);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'graph-added', graph: GRAPH, source: operation },
      { type: 'graph-removed', graph: GRAPH, source: operation },
    ]));
  });

  it.each(['success', 'rejection'] as const)('bypasses index maintenance when disabled: %s', async outcome => {
    const { store, events } = fixture(false);
    const failure = new Error('committed then rejected');
    if (outcome === 'rejection') {
      inner.failure = failure;
      inner.commitBeforeFailure = true;
    }
    const pending = replace(store, operation, [q(GRAPH, SUBJECT)]);
    if (outcome === 'rejection') await expect(pending).rejects.toBe(failure);
    else await pending;
    expect(await store.listGraphs()).toEqual([GRAPH]);
    expect(await store.listGraphs()).toEqual([GRAPH]);
    expect(inner.calls).toHaveLength(1);
    expect(inner.hasGraphOptions).toEqual([]);
    expect(inner.listGraphsCalls).toBe(2);
    expect(events).toEqual([]);
  });

  it.each(['unsupported', 'admission'] as const)('keeps the warm index after a matching clean %s refusal', async kind => {
    const { store } = fixture();
    await inner.backend.insert([q(OTHER)]);
    expect(await store.listGraphs()).toEqual([OTHER]);
    inner.failure = kind === 'unsupported'
      ? new UnsupportedTripleStoreCapabilityError(operation, 'test')
      : new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test', { storeOperation: operation });
    await expect(replace(store, operation, [q(GRAPH, SUBJECT)])).rejects.toBe(inner.failure);
    expect(await store.listGraphs()).toEqual([OTHER]);
    expect(inner.listGraphsCalls).toBe(1);
    expect(inner.hasGraphOptions).toEqual([]);
    expect(inner.calls).toHaveLength(1);
  });

  it.each(['generic', 'nested-probe'] as const)('rebuilds after a committed %s failure without replay', async kind => {
    const { store, events } = fixture();
    expect(await store.listGraphs()).toEqual([]);
    inner.failure = kind === 'generic'
      ? new Error('response lost after commit')
      : new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test', { storeOperation: 'hasGraph' });
    inner.commitBeforeFailure = true;
    await expect(replace(store, operation, [q(GRAPH, SUBJECT)])).rejects.toBe(inner.failure);
    expect(await store.listGraphs()).toEqual([GRAPH]);
    expect(inner.calls).toHaveLength(1);
    expect(inner.listGraphsCalls).toBe(2);
    expect(inner.hasGraphOptions).toEqual([]);
    expect(events).toContainEqual({
      type: 'graph-set-revalidated', added: [GRAPH], removed: [], source: operation,
    });
  });
});
