/**
 * OT-RFC-73 AC1: `createMutationObservedStore` is the store both async queues receive in the daemon (`dkg-agent.ts`: `agentStore`).
 * The control path routes by `QueryOptions.controlQueue`, which only reaches the adapter if this wrapper passes the options of
 * every method the queues call along unchanged. Each call below carries the options object `controlStoreOptions` returns (for
 * both queues) and the inner store must receive that same object.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  controlStoreOptions,
  deleteByPatternWithoutCount,
  tryReplaceSubjectAndInsertAtomically,
  tryReplaceSubjectAtomically,
  type Quad,
  type QueryOptions,
  type StoreControlQueue,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';

const GRAPH = 'urn:dkg:promote-queue:control-plane';
const SUBJECT = 'urn:dkg:promote-job:job-1';
const QUAD: Quad = { subject: SUBJECT, predicate: 'urn:test:state', object: '"queued"', graph: GRAPH };
const QUEUES: readonly StoreControlQueue[] = ['share', 'publisher'];

type Recorded = Record<string, unknown[]>;

/** An inner store with every capability the queues use; each method records the arguments it received. */
function innerStore(options: { withoutCount?: boolean } = {}): { store: TripleStore; received: Recorded } {
  const received: Recorded = {};
  const record = <R>(name: string, result: R) => vi.fn((...args: unknown[]) => { received[name] = args; return Promise.resolve(result); });
  const store = {
    query: record('query', { type: 'bindings', bindings: [] }),
    insert: record('insert', undefined),
    delete: record('delete', undefined),
    deleteByPattern: record('deleteByPattern', 1),
    deleteBySubjectPrefix: record('deleteBySubjectPrefix', 1),
    replaceSubject: record('replaceSubject', undefined),
    replaceSubjectAndInsert: record('replaceSubjectAndInsert', undefined),
    update: record('update', undefined),
    flush: record('flush', undefined),
    createGraph: record('createGraph', undefined),
    hasGraph: record('hasGraph', true),
    ...(options.withoutCount ? {} : { deleteByPatternWithoutCount: record('deleteByPatternWithoutCount', undefined) }),
  } as unknown as TripleStore;
  return { store, received };
}

const observed = (inner: TripleStore) => createMutationObservedStore(inner, createObservedStoreMutation(() => undefined));

interface Call {
  name: string;
  /** The inner method that must receive the options, and the index of its options argument. */
  inner: string;
  index: number;
  run: (store: TripleStore, options: QueryOptions) => Promise<unknown>;
}

const CALLS: readonly Call[] = [
  { name: 'query (SELECT)', inner: 'query', index: 1, run: (s, o) => s.query('SELECT ?s WHERE { GRAPH <urn:g> { ?s ?p ?o } } LIMIT 1', o) },
  { name: 'query (ASK)', inner: 'query', index: 1, run: (s, o) => s.query(`ASK { GRAPH <${GRAPH}> { ?s ?p ?o } }`, o) },
  { name: 'query (an update form)', inner: 'query', index: 1, run: (s, o) => s.query(`DELETE WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } }`, o) },
  { name: 'insert', inner: 'insert', index: 1, run: (s, o) => s.insert([QUAD], o) },
  { name: 'delete', inner: 'delete', index: 1, run: (s, o) => s.delete([QUAD], o) },
  { name: 'deleteByPattern', inner: 'deleteByPattern', index: 1, run: (s, o) => s.deleteByPattern({ subject: SUBJECT, graph: GRAPH }, o) },
  { name: 'deleteBySubjectPrefix', inner: 'deleteBySubjectPrefix', index: 2, run: (s, o) => s.deleteBySubjectPrefix(GRAPH, 'urn:dkg:promote-job:', o) },
  { name: 'replaceSubject', inner: 'replaceSubject', index: 3, run: (s, o) => s.replaceSubject!(GRAPH, SUBJECT, [QUAD], o) },
  { name: 'tryReplaceSubjectAtomically (the helper both queues use)', inner: 'replaceSubject', index: 3, run: (s, o) => tryReplaceSubjectAtomically(s, GRAPH, SUBJECT, [QUAD], o) },
  {
    name: 'replaceSubjectAndInsert',
    inner: 'replaceSubjectAndInsert', index: 4,
    run: (s, o) => s.replaceSubjectAndInsert!(GRAPH, SUBJECT, [QUAD], [{ ...QUAD, subject: 'urn:dkg:promote-job:job-2' }], o),
  },
  {
    name: 'tryReplaceSubjectAndInsertAtomically (the helper the publisher queue uses)',
    inner: 'replaceSubjectAndInsert', index: 4,
    run: (s, o) => tryReplaceSubjectAndInsertAtomically(s, GRAPH, SUBJECT, [QUAD], [{ ...QUAD, subject: 'urn:dkg:promote-job:job-2' }], o),
  },
  { name: 'update', inner: 'update', index: 1, run: (s, o) => s.update!(`INSERT DATA { GRAPH <${GRAPH}> { <${SUBJECT}> <urn:test:p> "v" } }`, o) },
  { name: 'flush', inner: 'flush', index: 0, run: (s, o) => s.flush!(o) },
  { name: 'hasGraph', inner: 'hasGraph', index: 1, run: (s, o) => s.hasGraph(GRAPH, o) },
];

describe('createMutationObservedStore forwards QueryOptions, controlQueue included, unchanged', () => {
  const rows = CALLS.flatMap((call) => QUEUES.map((queue) => ({ call, queue })));

  it.each(rows.map((row) => [`${row.call.name} (${row.queue})`, row] as const))('%s', async (_name, { call, queue }) => {
    const { store, received } = innerStore();
    const options = controlStoreOptions(queue, 'test.observed.forwarding');
    await call.run(observed(store), options);
    const forwarded = received[call.inner]?.[call.index] as QueryOptions;
    expect(forwarded).toBe(options);
    expect(forwarded).toEqual({ source: 'test.observed.forwarding', controlQueue: queue });
    expect(Object.keys(forwarded).sort()).toEqual(['controlQueue', 'source']); // no priority, nothing added
  });

  it.each(QUEUES)('deleteByPatternWithoutCount (%s) reaches the inner store\'s own method with the options', async (queue) => {
    const { store, received } = innerStore();
    const options = controlStoreOptions(queue, 'test.observed.forwarding');
    await observed(store).deleteByPatternWithoutCount!({ subject: SUBJECT, graph: GRAPH }, options);
    expect(received['deleteByPatternWithoutCount']?.[1]).toBe(options);
    expect(received['deleteByPattern']).toBeUndefined();
  });

  it.each(QUEUES)('deleteByPatternWithoutCount (%s) falls back to deleteByPattern with the options when the inner store has none', async (queue) => {
    const { store, received } = innerStore({ withoutCount: true });
    const options = controlStoreOptions(queue, 'test.observed.forwarding');
    await deleteByPatternWithoutCount(observed(store), { subject: SUBJECT, graph: GRAPH }, options);
    expect(received['deleteByPattern']?.[1]).toBe(options);
  });

  it('keeps extra fields next to the tag (a signal, touchedGraphs) on the same object', async () => {
    const { store, received } = innerStore();
    const signal = new AbortController().signal;
    const options = { ...controlStoreOptions('share', 'test.observed.forwarding'), signal, touchedGraphs: [GRAPH] };
    await observed(store).update!(`INSERT DATA { GRAPH <${GRAPH}> { <${SUBJECT}> <urn:test:p> "v" } }`, options);
    expect(received['update']?.[1]).toBe(options);
  });

  it('createGraph takes no options and passes the graph through', async () => {
    const { store, received } = innerStore();
    await observed(store).createGraph(GRAPH);
    expect(received['createGraph']).toEqual([GRAPH]);
  });

  it('forwards an untagged call\'s options as they were, so the wrapper adds no tag of its own', async () => {
    const { store, received } = innerStore();
    const plain: QueryOptions = { source: 'test.observed.plain' };
    await observed(store).query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', plain);
    expect(received['query']?.[1]).toBe(plain);
    expect(plain).toEqual({ source: 'test.observed.plain' });
  });
});
