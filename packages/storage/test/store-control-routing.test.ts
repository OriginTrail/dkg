/**
 * OT-RFC-73 AC1 check (2): the adapter routing table. Every TripleStore method the async queues call goes
 * through the same decorator stack `createTripleStore` applies, on BlazegraphStore and SparqlHttpStore, each
 * with a recording shared scheduler and recording control instances (injected through
 * `setStoreControlPathForTesting`) over a stub fetch. Each call is made with and without the control options,
 * under each ambient lane, with the path on and off.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import '../src/adapters/sparql-http.js';
import { tryReplaceSubjectAndInsertAtomically } from '../src/atomic-subject-insert.js';
import { assertSubjectReplacementPayload } from '../src/atomic-graph-replace.js';
import {
  STORE_CONTROL_QUEUES,
  buildStoreControlPath,
  controlStoreOptions,
  setStoreControlPathForTesting,
  type StoreControlPath,
} from '../src/store-control-path.js';
import {
  StorePriorityScheduler,
  activeDefaultStoreWorkPriority,
  withDefaultStoreWorkPriority,
} from '../src/store-priority-scheduler.js';
import {
  createTripleStore,
  deleteByPatternWithoutCount,
  registerTripleStoreAdapter,
  tryReplaceSubjectAtomically,
  type Quad,
  type QueryOptions,
  type StoreControlQueue,
  type StoreWorkPriority,
  type TripleStore,
  type TripleStoreConfig,
  type UpdateOptions,
} from '../src/triple-store.js';

const GRAPH = 'urn:dkg:promote-queue:control-plane';
const SUBJECT = 'urn:dkg:promote-job:routing-1';
const SOURCE = 'test.routing.call';
const quad = (object: string): Quad => ({ subject: SUBJECT, predicate: 'urn:test:status', object, graph: GRAPH });

type Ambient = StoreWorkPriority | undefined;
const AMBIENTS: readonly Ambient[] = [undefined, 'normal', 'background'];

interface Run {
  scheduler: 'shared' | StoreControlQueue;
  priority: StoreWorkPriority | undefined;
  ambient: Ambient;
  source: string;
}

/** The lane the shared scheduler resolves a run to: explicit priority, else the ambient default, else normal. */
const sharedLane = (run: Run): StoreWorkPriority => run.priority ?? run.ambient ?? 'normal';

interface CallCase {
  name: string;
  run: (store: TripleStore, options?: QueryOptions) => Promise<unknown>;
  /** Scheduler runs one call makes on a plain adapter (no decorators); `atomic` is whether the stack has atomic updates. */
  runs: (atomic: boolean) => number;
}

/** The publisher's `replaceSubjectAtomicallyOrFallback` (publisher/src/subject-atomic-write.ts), which storage cannot import. */
async function replaceSubjectOrFallback(store: TripleStore, options: QueryOptions | undefined): Promise<void> {
  const quads = [quad('"done"')];
  assertSubjectReplacementPayload(GRAPH, SUBJECT, quads);
  if (await tryReplaceSubjectAtomically(store, GRAPH, SUBJECT, quads, options)) return;
  await deleteByPatternWithoutCount(store, { subject: SUBJECT, graph: GRAPH }, options);
  await store.insert(quads, options);
}

const CALLS: readonly CallCase[] = [
  { name: 'query (SELECT)', run: (s, o) => s.query('SELECT ?s WHERE { GRAPH <urn:g> { ?s ?p ?o } } LIMIT 1', o), runs: () => 1 },
  { name: 'query (ASK)', run: (s, o) => s.query(`ASK { GRAPH <${GRAPH}> { ?s ?p ?o } }`, o), runs: () => 1 },
  { name: 'insert', run: (s, o) => s.insert([quad('"queued"')], o), runs: () => 1 },
  { name: 'delete', run: (s, o) => s.delete([quad('"queued"')], o), runs: () => 1 },
  { name: 'deleteByPattern (count, delete, count)', run: (s, o) => s.deleteByPattern({ subject: SUBJECT, graph: GRAPH }, o), runs: () => 3 },
  { name: 'deleteByPatternWithoutCount', run: (s, o) => deleteByPatternWithoutCount(s, { subject: SUBJECT, graph: GRAPH }, o), runs: () => 1 },
  { name: 'deleteBySubjectPrefix (count, delete, count)', run: (s, o) => s.deleteBySubjectPrefix(GRAPH, 'urn:dkg:promote-job:', o), runs: () => 3 },
  { name: 'replaceSubject', run: (s, o) => tryReplaceSubjectAtomically(s, GRAPH, SUBJECT, [quad('"running"')], o), runs: (atomic) => (atomic ? 1 : 0) },
  {
    name: 'replaceSubjectAndInsert',
    run: (s, o) => tryReplaceSubjectAndInsertAtomically(s, GRAPH, SUBJECT, [quad('"running"')],
      [{ ...quad('"request"'), subject: 'urn:dkg:promote-job:routing-2' }], o),
    runs: (atomic) => (atomic ? 1 : 0),
  },
  { name: 'replaceSubject or its delete-then-insert fallback', run: (s, o) => replaceSubjectOrFallback(s, o), runs: (atomic) => (atomic ? 1 : 2) },
  {
    name: 'update',
    run: (s, o) => s.update!(`INSERT DATA { GRAPH <${GRAPH}> { <${SUBJECT}> <urn:test:p> "v" } }`,
      { ...o, touchedGraphs: [GRAPH] } as UpdateOptions),
    runs: () => 1,
  },
  { name: 'createGraph (takes no options)', run: (s) => s.createGraph(GRAPH), runs: () => 0 },
  { name: 'flush', run: (s, o) => s.flush?.(o) ?? Promise.resolve(), runs: () => 0 },
];

interface Stack {
  name: string;
  atomic: boolean;
  /** Decorators can add follow-up reads (the graph-set index's hasGraph probes) after a mutation. */
  decorated: boolean;
  config: (shared: StorePriorityScheduler) => TripleStoreConfig;
}

let blobDir: string;
const BLAZEGRAPH_BACKEND = 'blazegraph-routing-test';
let blazegraphScheduler: StorePriorityScheduler;

const STACKS: readonly Stack[] = [
  {
    name: 'BlazegraphStore',
    atomic: true,
    decorated: false,
    config: () => ({ backend: BLAZEGRAPH_BACKEND }),
  },
  {
    name: 'BlazegraphStore + large-literal store + graph-set index',
    atomic: true,
    decorated: true,
    config: () => ({
      backend: BLAZEGRAPH_BACKEND,
      graphSetIndex: true,
      largeLiteralStorage: { directory: blobDir },
    }),
  },
  {
    name: 'BlazegraphStore + graph-set index + changelog',
    atomic: true,
    decorated: true,
    config: () => ({ backend: BLAZEGRAPH_BACKEND, graphSetIndex: true, changelog: true }),
  },
  {
    name: 'SparqlHttpStore (atomic updates)',
    atomic: true,
    decorated: false,
    config: (scheduler) => ({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://stub.test/query', updateEndpoint: 'http://stub.test/update', consistencyProfile: 'atomic-update', scheduler },
    }),
  },
  {
    name: 'SparqlHttpStore (no atomic updates: the fallback branches)',
    atomic: false,
    decorated: false,
    config: (scheduler) => ({
      backend: 'sparql-http',
      options: { queryEndpoint: 'http://stub.test/query', updateEndpoint: 'http://stub.test/update', scheduler },
    }),
  },
  {
    name: 'managed SparqlHttpStore (managedByDkg: graph-set index + follow-up hasGraph reads)',
    atomic: true,
    decorated: true,
    config: (scheduler) => ({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://stub.test/query',
        updateEndpoint: 'http://stub.test/update',
        consistencyProfile: 'atomic-update',
        managedByDkg: true,
        scheduler,
      },
    }),
  },
];

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } });

let countQueries = 0;

/** Every endpoint answers: updates 200, ASK true, COUNT a number that drops, anything else an empty SELECT. */
async function stubFetch(_input: unknown, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? init.body : '';
  if (/sparql-update|nquads/i.test(headers.get('content-type') ?? '')) return new Response('', { status: 200 });
  if (/\bASK\b/.test(body)) return json({ head: {}, boolean: true });
  if (/COUNT\s*\(/i.test(body)) {
    return json({ head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: String(100 - countQueries++) } }] } });
  }
  return json({ head: { vars: ['s'] }, results: { bindings: [] } });
}

interface Observed {
  runs: Run[];
  /** What each real scheduler recorded: the lanes its started operations ran in, sorted. */
  lanes: Record<'shared' | StoreControlQueue, string[]>;
}

interface Harness {
  store: TripleStore;
  shared: StorePriorityScheduler;
  path: StoreControlPath;
  observe: (call: CallCase, options: QueryOptions | undefined, ambient?: Ambient) => Promise<Observed>;
  inject: (queues: readonly StoreControlQueue[]) => void;
}

const harnesses = new Map<string, Harness>();
let recorded: Run[] = [];

function record(scheduler: StorePriorityScheduler, label: Run['scheduler']): void {
  const original = scheduler.run.bind(scheduler);
  vi.spyOn(scheduler, 'run').mockImplementation(((priority, operation, work, signal, metadata) => {
    recorded.push({ scheduler: label, priority, ambient: activeDefaultStoreWorkPriority(), source: operation });
    return original(priority, operation, work, signal, metadata);
  }) as StorePriorityScheduler['run']);
}

const startedLanes = (scheduler: StorePriorityScheduler): string[] =>
  scheduler.stats.takeIntervalQueueWaits().flatMap((wait) => Array<string>(wait.queueWaitCount).fill(wait.lane)).sort();

async function buildHarness(stack: Stack): Promise<Harness> {
  const shared = new StorePriorityScheduler({
    maxConcurrent: 4, ackReservedSlots: 1, healthReservedSlots: 1, normalReservedSlots: 1, backgroundReservedSlots: 1,
    queueLimits: 64, queueWaitTimeoutMs: 30_000,
  });
  const path = buildStoreControlPath({ share: 1, publisher: 2 }, shared);
  record(shared, 'shared');
  for (const queue of STORE_CONTROL_QUEUES) record(path[queue]!, queue);
  blazegraphScheduler = shared;
  const store = await createTripleStore(stack.config(shared));
  // Seed the graph-set index, so it probes the graphs a mutation touched (it maintains only a seeded index).
  if (stack.decorated) await store.listGraphs();
  // The change log reads its own state on first use, which no queue call causes; do that before observing.
  if (stack.name.includes('changelog')) await store.insert([quad('"warm-up"')]);
  const inject = (queues: readonly StoreControlQueue[]) =>
    setStoreControlPathForTesting(Object.fromEntries(queues.map((queue) => [queue, path[queue]])) as StoreControlPath);
  const schedulers = (): Array<['shared' | StoreControlQueue, StorePriorityScheduler]> =>
    [['shared', shared], ['share', path.share!], ['publisher', path.publisher!]];
  const observe: Harness['observe'] = async (call, options, ambient) => {
    for (const [, scheduler] of schedulers()) scheduler.stats.takeIntervalQueueWaits();
    recorded = [];
    await (ambient === undefined ? call.run(store, options) : withDefaultStoreWorkPriority(ambient, () => call.run(store, options)));
    return {
      runs: recorded,
      lanes: Object.fromEntries(schedulers().map(([label, scheduler]) => [label, startedLanes(scheduler)])) as Observed['lanes'],
    };
  };
  return { store, shared, path, observe, inject };
}

let originalFetchDescriptor: PropertyDescriptor | undefined;

beforeAll(async () => {
  blobDir = mkdtempSync(join(tmpdir(), 'dkg-routing-blobs-'));
  originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  vi.stubGlobal('fetch', stubFetch);
  registerTripleStoreAdapter(BLAZEGRAPH_BACKEND, async () => new BlazegraphStore('http://stub.test/blazegraph/sparql', { scheduler: blazegraphScheduler }));
  for (const stack of STACKS) harnesses.set(stack.name, await buildHarness(stack));
});

afterEach(() => {
  setStoreControlPathForTesting(undefined);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (originalFetchDescriptor) Object.defineProperty(globalThis, 'fetch', originalFetchDescriptor);
  rmSync(blobDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Make an assertion about the observed runs, whatever the stack. */
function expectCount(stack: Stack, call: CallCase, runs: readonly Run[]): void {
  const plain = call.runs(stack.atomic);
  if (plain === 0) expect(runs).toHaveLength(0);
  else if (stack.decorated) expect(runs.length).toBeGreaterThanOrEqual(plain);
  else expect(runs).toHaveLength(plain);
}

const stackCalls = STACKS.flatMap((stack) => CALLS.map((call) => ({ stack, call })));
const label = ({ stack, call }: { stack: Stack; call: CallCase }) => `${stack.name}: ${call.name}`;

describe('AC1 (2): control options route every scheduler run to the queue\'s own scheduler', () => {
  it.each(stackCalls.map((c) => [label(c), c] as const))('%s', async (_name, { stack, call }) => {
    const h = harnesses.get(stack.name)!;
    for (const queue of STORE_CONTROL_QUEUES) {
      const tagged = controlStoreOptions(queue, SOURCE);
      for (const ambient of AMBIENTS) {
        const context = `${queue}, ambient ${ambient ?? 'none'}`;

        // Path on: every run lands on the queue's own scheduler with its source, whatever the ambient lane.
        h.inject(STORE_CONTROL_QUEUES);
        const on = await h.observe(call, tagged, ambient);
        expectCount(stack, call, on.runs);
        expect(on.runs.map((run) => run.scheduler), context).toEqual(on.runs.map(() => queue));
        expect(on.runs.map((run) => run.source), context).toEqual(on.runs.map(() => SOURCE));
        expect(on.runs.map((run) => run.priority), `${context}: the helper sets no priority`).toEqual(on.runs.map(() => undefined));
        // The real schedulers agree: all started in the queue's control lane, none on the shared one.
        expect(on.lanes.shared, context).toEqual([]);
        expect(on.lanes[queue], context).toEqual(on.runs.map(() => 'control'));
        expect(on.lanes[queue === 'share' ? 'publisher' : 'share'], context).toEqual([]);

        // Path on, but only the other queue's instance: this queue's call resolves like an untagged one.
        h.inject(STORE_CONTROL_QUEUES.filter((other) => other !== queue));
        const otherOnly = await h.observe(call, tagged, ambient);
        const plainSourced = await h.observe(call, { source: SOURCE }, ambient);
        expect(otherOnly.runs.map((run) => [run.scheduler, sharedLane(run), run.source]), context)
          .toEqual(plainSourced.runs.map((run) => [run.scheduler, sharedLane(run), run.source]));
        expect(otherOnly.lanes, context).toEqual(plainSourced.lanes);

        // Path off: no instance exists. A tagged call gets exactly the lane the same call gets without the tag,
        // whatever the ambient default, and the real scheduler agrees.
        h.inject([]);
        const off = await h.observe(call, tagged, ambient);
        const untagged = await h.observe(call, { source: SOURCE }, ambient);
        const bare = await h.observe(call, undefined, ambient);
        expectCount(stack, call, off.runs);
        expect(off.runs.map((run) => run.scheduler), context).toEqual(off.runs.map(() => 'shared'));
        expect(off.runs.map((run) => [sharedLane(run), run.source]), context)
          .toEqual(untagged.runs.map((run) => [sharedLane(run), run.source]));
        expect(off.runs.map(sharedLane), `${context}: same lanes as the call with no options at all`)
          .toEqual(bare.runs.map(sharedLane));
        expect(off.lanes, context).toEqual(untagged.lanes);
        expect(off.lanes, context).toEqual(bare.lanes);
        expect(off.lanes.share.length + off.lanes.publisher.length, context).toBe(0);
        // With no priority set by the tag, the lane is the ambient default, else normal.
        expect(off.runs.map(sharedLane), context).toEqual(off.runs.map(() => ambient ?? 'normal'));
      }
    }
  });
});

describe('an untagged call never reaches the control path', () => {
  // Both instances are on and the call names no queue: it must stay on the shared scheduler, in the lane it
  // always had (explicit priority, else the ambient default, else normal), on every stack and under every ambient.
  it.each(stackCalls.map((c) => [label(c), c] as const))('%s', async (_name, { stack, call }) => {
    const h = harnesses.get(stack.name)!;
    h.inject(STORE_CONTROL_QUEUES);
    for (const ambient of AMBIENTS) {
      for (const [shape, options] of [['no options', undefined], ['a source only', { source: SOURCE }]] as const) {
        const context = `${shape}, ambient ${ambient ?? 'none'}`;
        const seen = await h.observe(call, options, ambient);
        expectCount(stack, call, seen.runs);
        expect(seen.runs.map((run) => run.scheduler), context).toEqual(seen.runs.map(() => 'shared'));
        expect(seen.runs.map(sharedLane), context).toEqual(seen.runs.map(() => ambient ?? 'normal'));
        expect(seen.lanes.share, context).toEqual([]);
        expect(seen.lanes.publisher, context).toEqual([]);
        expect(seen.lanes.shared, context).toEqual(seen.runs.map(() => ambient ?? 'normal'));
      }
    }
  });
});

describe('only controlQueue routes: no priority and no ambient lane reaches the control path', () => {
  const stack = STACKS[0];
  const rows: ReadonlyArray<[string, QueryOptions]> = [
    ['an ACK priority', { priority: 'ack' }],
    ['a health priority', { priority: 'health' }],
    ['a background priority', { priority: 'background' }],
    ['a normal priority', { priority: 'normal' }],
  ];

  it.each(rows)('a call with %s and no queue stays on the shared scheduler', async (_name, options) => {
    const h = harnesses.get(stack.name)!;
    h.inject(STORE_CONTROL_QUEUES);
    for (const ambient of AMBIENTS) {
      const seen = await h.observe(CALLS[2], { ...options, source: SOURCE }, ambient);
      expect(seen.runs.map((run) => run.scheduler)).toEqual(['shared']);
      expect(seen.lanes.share).toEqual([]);
      expect(seen.lanes.publisher).toEqual([]);
      expect(seen.lanes.shared).toEqual([options.priority]);
    }
  });

  it.each(rows)('a tagged call with %s still runs in the control lane when the path is on, and in that lane when off', async (_name, options) => {
    const h = harnesses.get(stack.name)!;
    for (const queue of STORE_CONTROL_QUEUES) {
      const tagged: QueryOptions = { ...controlStoreOptions(queue, SOURCE), ...options };
      for (const ambient of AMBIENTS) {
        h.inject(STORE_CONTROL_QUEUES);
        const on = await h.observe(CALLS[2], tagged, ambient);
        expect(on.runs.map((run) => run.scheduler)).toEqual([queue]);
        expect(on.lanes[queue]).toEqual(['control']);
        expect(on.lanes.shared).toEqual([]);

        h.inject([]);
        const off = await h.observe(CALLS[2], tagged, ambient);
        expect(off.runs.map((run) => run.scheduler)).toEqual(['shared']);
        expect(off.lanes.shared).toEqual([options.priority]);
      }
    }
  });

  it('ignores a controlQueue that names no queue', async () => {
    const h = harnesses.get(stack.name)!;
    h.inject(STORE_CONTROL_QUEUES);
    for (const bogus of ['other', 'constructor', '__proto__']) {
      const seen = await h.observe(CALLS[2], { source: SOURCE, controlQueue: bogus as StoreControlQueue });
      expect(seen.runs.map((run) => run.scheduler)).toEqual(['shared']);
    }
  });
});

describe('a managed store\'s follow-up reads after a tagged mutation', () => {
  const stack = STACKS.find((candidate) => candidate.name.startsWith('managed'))!;

  it.each(['delete', 'deleteByPattern (count, delete, count)', 'update', 'replaceSubject'])(
    'run hasGraph probes on the same queue scheduler after %s',
    async (name) => {
      const h = harnesses.get(stack.name)!;
      const call = CALLS.find((candidate) => candidate.name === name)!;
      for (const queue of STORE_CONTROL_QUEUES) {
        h.inject(STORE_CONTROL_QUEUES);
        const seen = await h.observe(call, controlStoreOptions(queue, SOURCE));
        // The mutation itself plus at least one probe, all tagged.
        expect(seen.runs.length).toBeGreaterThan(call.runs(true));
        expect(seen.runs.every((run) => run.scheduler === queue && run.source === SOURCE)).toBe(true);
        expect(seen.lanes.shared).toEqual([]);

        h.inject([]);
        const off = await h.observe(call, controlStoreOptions(queue, SOURCE), 'background');
        expect(off.runs.length).toBe(seen.runs.length);
        expect(off.runs.every((run) => run.scheduler === 'shared' && sharedLane(run) === 'background')).toBe(true);
      }
    },
  );
});

describe('option-less calls', () => {
  it.each(stackCalls.filter(({ call }) => call.runs(true) === 0).map((c) => [label(c), c] as const))(
    '%s causes no scheduler run, on or off',
    async (_name, { stack, call }) => {
      const h = harnesses.get(stack.name)!;
      for (const queues of [STORE_CONTROL_QUEUES, []] as const) {
        h.inject(queues);
        for (const ambient of AMBIENTS) {
          const bare = await h.observe(call, undefined, ambient);
          expect(bare.runs).toHaveLength(0);
          expect(bare.lanes).toEqual({ shared: [], share: [], publisher: [] });
        }
      }
    },
  );
});
