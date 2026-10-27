/**
 * OT-RFC-73 AC3, share leg: with the control path ON, a control-lane refusal (`queue_full`, `queue_wait_timeout`) of the share queue's
 * own store call is the same retryable, known-not-started refusal as any scheduler shedding, not a hang and not a different error.
 * The real queue runs on a stub-fetch `SparqlHttpStore` built through `createTripleStore`, with the control instance built by
 * P3's `buildStoreControlPath` and injected the way P3's routing test does. The control slot is held by the test, so the queue's
 * own call is the one that is refused, and the refusal travels up through the admission coordinator to the share route:
 *   - conflict phase: the in-lock conflict read is refused -> `not_admitted`, phase `conflict`;
 *   - persist phase: the job write is refused after a successful read -> `not_admitted`, phase `persist` (the busy error is
 *     tagged `not_started` for `replaceSubject`, so persistence is proven not to have happened), and no job exists afterwards;
 *   - the cause is a `StoreSchedulerBusyError` with priority `control`, which P3's mapping answers with a retryable `not_started` 503.
 * The route renders the ADMISSION verdict (`admissionOutcome`), never the nested store outcome; both are asserted.
 * Two controls keep it honest: the same queue succeeds when nothing is held, and a saturated SHARED scheduler refuses the queue
 * with the path off (in the caller's lane) but not with it on.
 * "No job exists" has to be able to fail, so the stub endpoint is stateful: it records every update request that reaches the wire and
 * answers job reads from what those updates wrote. Every refusal then asserts, after the held pressure is released and the scheduler
 * has had time to run anything it wrongly kept, that no job write was dispatched and the queue lists nothing; the admitted control
 * asserts the opposite through the same stub (one job write, and `queue.list()` returns that job).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StorePriorityScheduler,
  buildStoreControlPath,
  createTripleStore,
  isStoreSchedulerBusyError,
  setStoreControlPathForTesting,
  type StoreControlPath,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { PromoteAdmissionError, TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { handleKaShareAsyncEnqueue } from '../src/daemon/routes/knowledge-assets-async-share.js';
import { classifyStoreUnavailable } from '../src/daemon/http-utils.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { daemonState } from '../src/daemon/state.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const WAIT_MS = 40;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } });

/**
 * The stub SPARQL endpoint, stateful so that "no job exists" can fail:
 *   - `updates` is every update request that reached the wire, so a dispatched job write cannot go unnoticed;
 *   - `payloads` is what those updates wrote (graph -> job subject -> payload JSON), and the queue's job reads answer from it, so a
 *     persisted job is visible to `queue.list()` the way it would be on a real endpoint.
 * `onConflictRead` runs while the queue's conflict read is in flight.
 */
const endpoint = {
  onConflictRead: undefined as (() => void) | undefined,
  updates: [] as string[],
  payloads: new Map<string, Map<string, string>>(),
};

/** The queue's job record keeps its whole job in one `urn:dkg:promote-queue:payload` literal (a JSON string literal). */
const PAYLOAD_TRIPLE = /^\s*<([^>]+)> <urn:dkg:promote-queue:payload> ("(?:[^"\\]|\\.)*") \.$/gm;
const SUBJECT_CLEAR = /DELETE WHERE \{ GRAPH <([^>]+)> \{ <([^>]+)> \?p \?o \} \}/g;

/** Record an update and apply what the queue sends: `replaceSubject` is a subject clear followed by an INSERT DATA of its quads. */
function applyUpdate(update: string): void {
  endpoint.updates.push(update);
  for (const [, graph, subject] of update.matchAll(SUBJECT_CLEAR)) endpoint.payloads.get(graph!)?.delete(subject!);
  const graph = /INSERT DATA \{\s*GRAPH <([^>]+)>/.exec(update)?.[1];
  if (graph === undefined) return;
  const records = endpoint.payloads.get(graph) ?? new Map<string, string>();
  endpoint.payloads.set(graph, records);
  for (const [, subject, payload] of update.matchAll(PAYLOAD_TRIPLE)) records.set(subject!, JSON.parse(payload!) as string);
}

/** Answer `SELECT ?payload` from the stored records of the queried graph (a read pinned to one job subject returns only that job). */
function payloadRows(query: string): Response {
  const graph = /GRAPH <([^>]+)>/.exec(query)?.[1] ?? '';
  const pinned = /GRAPH <[^>]+> \{ <([^>]+)> <urn:dkg:promote-queue:payload> \?payload/.exec(query)?.[1];
  const bindings = [...(endpoint.payloads.get(graph) ?? [])]
    .filter(([subject]) => pinned === undefined || subject === pinned)
    .map(([, payload]) => ({ payload: { type: 'literal', value: payload } }));
  return json({ head: { vars: ['payload'] }, results: { bindings } });
}

/** Updates 200 and are recorded, ASK true, job reads answer from the recorded writes: an empty control graph that accepts writes. */
async function stubFetch(_input: unknown, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? init.body : '';
  if (/sparql-update|nquads/i.test(headers.get('content-type') ?? '')) { applyUpdate(body); return new Response('', { status: 200 }); }
  if (/\bASK\b/.test(body)) return json({ head: {}, boolean: true });
  if (/SELECT\s+\?payload/.test(body)) {
    endpoint.onConflictRead?.();
    return payloadRows(body);
  }
  return json({ head: { vars: ['payload'] }, results: { bindings: [] } });
}

interface Harness {
  store: TripleStore;
  shared: StorePriorityScheduler;
  control: StorePriorityScheduler;
  path: StoreControlPath;
  queue: TripleStoreAsyncPromoteQueue;
  graphUri: string;
}

let graphCounter = 0;
const gates: Array<() => void> = [];
const held: Array<Promise<unknown>> = [];
const stores: TripleStore[] = [];

/** Let every operation the test put on a scheduler finish, so the queue is readable again. */
async function releaseAll(): Promise<void> {
  for (const release of gates.splice(0)) release();
  await Promise.all(held.splice(0));
}

/** The job writes that reached the wire for this queue: the updates addressed to its control graph. */
const jobWrites = (h: Harness): string[] => endpoint.updates.filter((update) => update.includes(`<${h.graphUri}>`));

/**
 * The refusal left no job behind. Releases the held pressure first and then gives the scheduler longer than its queue wait to run
 * anything it wrongly kept, so a refused write that executes late is caught here; then checks both views of the same stub: no job
 * write was dispatched, and the queue (read through the same endpoint) lists nothing.
 */
async function expectNoJobPersisted(h: Harness): Promise<void> {
  await releaseAll();
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 2));
  expect(jobWrites(h)).toEqual([]);
  expect(await h.queue.list()).toEqual([]);
}

/** A shared scheduler with `sharedMaxConcurrent` slots (1 lets a test saturate it with one holder and one waiter). */
async function harness(sharedMaxConcurrent = 4): Promise<Harness> {
  const shared = new StorePriorityScheduler({
    maxConcurrent: sharedMaxConcurrent,
    ackReservedSlots: sharedMaxConcurrent > 1 ? 1 : 0,
    healthReservedSlots: sharedMaxConcurrent > 1 ? 1 : 0,
    normalReservedSlots: 0,
    backgroundReservedSlots: 0,
    queueLimits: 1,
    queueWaitTimeoutMs: WAIT_MS,
  });
  // The real builder: the control instance takes the shared scheduler's queue limit (1) and wait (WAIT_MS) as values.
  const path = buildStoreControlPath({ share: 1, publisher: 0 }, shared);
  const store = await createTripleStore({
    backend: 'sparql-http',
    options: {
      queryEndpoint: 'http://stub.test/query',
      updateEndpoint: 'http://stub.test/update',
      consistencyProfile: 'atomic-update',
      scheduler: shared,
    },
  });
  stores.push(store);
  const graphUri = `urn:test:share-control-busy:${graphCounter++}`;
  const queue = new TripleStoreAsyncPromoteQueue(store, { graphUri });
  return { store, shared, control: path.share!, path, queue, graphUri };
}

/** Occupy `scheduler`'s only slot until the test ends; resolves once the holder is running. */
async function holdSlot(scheduler: StorePriorityScheduler, operation: string): Promise<void> {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const release = new Promise<void>((resolve) => { gates.push(resolve); });
  held.push(scheduler.run(undefined, operation, async () => { started(); await release; }).catch(() => undefined));
  await running;
}

/** Put one more operation behind the holder, so the scheduler's queue (limit 1) is full. */
function fillQueue(scheduler: StorePriorityScheduler, operation: string): void {
  const release = new Promise<void>((resolve) => { gates.push(resolve); });
  held.push(scheduler.run(undefined, operation, () => release).catch(() => undefined));
}

const startedLanes = (scheduler: StorePriorityScheduler): string[] =>
  scheduler.stats.takeIntervalQueueWaits().flatMap((wait) => Array<string>(wait.queueWaitCount).fill(wait.lane)).sort();

function route(queue: TripleStoreAsyncPromoteQueue) {
  daemonState.promoteWorkerAvailable = true;
  const record = { status: 0, body: '', headers: {} as Record<string, string> };
  const thrown: { error?: unknown } = {};
  const url = new URL('http://localhost/api/knowledge-assets/asset/swm/share-async');
  const ctx = {
    req: { method: 'POST', __dkgPrebufferedBody: Buffer.from(JSON.stringify({ contextGraphId: 'busy-cg' })) },
    res: {
      writeHead(status: number, headers: Record<string, string>) { record.status = status; Object.assign(record.headers, headers); },
      end(body: string) { record.body = body; },
    },
    url, path: url.pathname, authentication: requestAuthentication({ kind: 'nodeOperator' }),
    agent: {
      probeContextGraphWritePreflight: vi.fn(async () => ({
        storeAvailable: true, exists: true, hasLocalContent: true, declarationFound: true, accessPolicy: 'public', callerAuthorized: true,
      })),
      assertion: {
        promoteAsync: async (contextGraphId: string, assertionName: string) => {
          try { return { jobId: await queue.enqueue({ contextGraphId, assertionName, entities: 'all' }) }; }
          catch (error) { thrown.error = error; throw error; }
        },
      },
    },
  } as unknown as RequestContext;
  return { ctx, record, thrown };
}

const body = (record: { body: string }) => JSON.parse(record.body) as Record<string, unknown>;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  endpoint.updates.length = 0;
  endpoint.payloads.clear();
  vi.stubGlobal('fetch', stubFetch);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);   // the scheduler's queue-wait-timeout diagnostic
});

afterEach(async () => {
  endpoint.onConflictRead = undefined;
  setStoreControlPathForTesting(undefined);
  daemonState.promoteWorkerAvailable = false;
  await releaseAll();
  await Promise.all(stores.splice(0).map((store) => store.close?.()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the share queue under control-lane pressure, control path on', () => {
  it('admits the job when nothing is held, on the control instance and not on the shared scheduler (the control for the cases below)', async () => {
    const h = await harness();
    setStoreControlPathForTesting(h.path);
    const { ctx, record } = route(h.queue);
    await handleKaShareAsyncEnqueue(ctx, 'asset');
    expect(record.status).toBe(200);
    expect(body(record)).toMatchObject({ state: 'queued', jobId: expect.any(String) });
    const lanes = startedLanes(h.control);
    expect(lanes.length).toBeGreaterThanOrEqual(2);              // the conflict read and the job write
    expect(lanes.every((lane) => lane === 'control')).toBe(true);
    expect(startedLanes(h.shared)).toEqual([]);
    // The job really was persisted, and the stub shows it both ways: exactly one job write reached the wire, and the queue reads
    // that job back through the same endpoint. This is what makes "no job" in the refusal cases below able to fail.
    const { jobId } = body(record) as { jobId: string };
    expect(jobWrites(h)).toHaveLength(1);
    expect(jobWrites(h)[0]).toContain(`urn:dkg:promote-queue:job:${jobId}`);
    expect(await h.queue.list()).toMatchObject([
      { jobId, state: 'queued', request: { contextGraphId: 'busy-cg', assertionName: 'asset' } },
    ]);
  });

  it('refuses the conflict read with queue_full: control-lane busy cause, not_admitted at the conflict phase, 503 retryable, no job', async () => {
    const h = await harness();
    setStoreControlPathForTesting(h.path);
    await holdSlot(h.control, 'test.hold');
    fillQueue(h.control, 'test.fill');

    const { ctx, record, thrown } = route(h.queue);
    await handleKaShareAsyncEnqueue(ctx, 'asset');

    expect(thrown.error).toBeInstanceOf(PromoteAdmissionError);
    const cause = (thrown.error as PromoteAdmissionError).cause;
    expect(isStoreSchedulerBusyError(cause)).toBe(true);
    expect(cause).toMatchObject({ reason: 'queue_full', priority: 'control', operation: 'publisher.asyncPromote.findActiveConflict' });
    // P3's mapping of that cause: retryable, known not to have started, naming the control lane.
    expect(classifyStoreUnavailable(cause)).toMatchObject({
      outcome: 'not_started',
      body: { code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full', priority: 'control', retryable: true, outcome: 'not_started' },
    });
    // The share route's own answer is about job admission: nothing admitted, retry the same selector.
    expect(record.status).toBe(503);
    expect(record.headers['Retry-After']).toBe('1');
    expect(body(record)).toMatchObject({
      code: 'PROMOTE_ADMISSION_UNAVAILABLE', retryable: true, admissionScope: 'async_promote_job', admissionOutcome: 'not_admitted', phase: 'conflict',
    });
    expect(body(record)).not.toHaveProperty('jobId');
    expect(body(record)).not.toHaveProperty('outcome');

    await expectNoJobPersisted(h);
  });

  it('refuses the conflict read with queue_wait_timeout after the control wait, the same way', async () => {
    const h = await harness();
    setStoreControlPathForTesting(h.path);
    await holdSlot(h.control, 'test.hold');

    const { ctx, record, thrown } = route(h.queue);
    const started = Date.now();
    await handleKaShareAsyncEnqueue(ctx, 'asset');

    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 5);
    const cause = (thrown.error as PromoteAdmissionError).cause;
    expect(isStoreSchedulerBusyError(cause)).toBe(true);
    expect(cause).toMatchObject({ reason: 'queue_wait_timeout', priority: 'control' });
    expect(record.status).toBe(503);
    expect(body(record)).toMatchObject({ retryable: true, admissionOutcome: 'not_admitted', phase: 'conflict' });
    expect(classifyStoreUnavailable(cause)?.outcome).toBe('not_started');
    await expectNoJobPersisted(h);
  });

  it('refuses the job write with queue_wait_timeout after a successful read: not_admitted at the persist phase, and no job exists', async () => {
    const h = await harness();
    setStoreControlPathForTesting(h.path);
    // While the conflict read holds the slot, queue a holder behind it: it starts the moment the read finishes, ahead of the write.
    endpoint.onConflictRead = () => {
      endpoint.onConflictRead = undefined;
      fillQueue(h.control, 'test.hold-after-read');
    };

    const { ctx, record, thrown } = route(h.queue);
    await handleKaShareAsyncEnqueue(ctx, 'asset');

    const cause = (thrown.error as PromoteAdmissionError).cause;
    expect(isStoreSchedulerBusyError(cause)).toBe(true);
    expect(cause).toMatchObject({ reason: 'queue_wait_timeout', priority: 'control', operation: 'publisher.asyncPromote.writeJob' });
    expect(warn).toHaveBeenCalledWith('[store scheduler] queue wait timeout',
      expect.objectContaining({ waiting: { priority: 'control', operation: 'publisher.asyncPromote.writeJob' } }));
    expect(record.status).toBe(503);
    expect(record.headers['Retry-After']).toBe('1');
    expect(body(record)).toMatchObject({
      retryable: true, admissionScope: 'async_promote_job', admissionOutcome: 'not_admitted', phase: 'persist',
    });
    expect(body(record)).not.toHaveProperty('jobId');
    expect(body(record)).not.toHaveProperty('statusPath');

    await expectNoJobPersisted(h);
  });
});

describe('what a saturated shared scheduler does to the share queue', () => {
  // One slot and a full queue on the SHARED scheduler: any call that resolves to it is refused.
  async function saturatedShared(): Promise<Harness> {
    const h = await harness(1);
    await holdSlot(h.shared, 'test.client-read');
    fillQueue(h.shared, 'test.client-read-2');
    return h;
  }

  it('does not touch the queue with the path on: the control instance has its own slot', async () => {
    const h = await saturatedShared();
    setStoreControlPathForTesting(h.path);
    const { ctx, record } = route(h.queue);
    await handleKaShareAsyncEnqueue(ctx, 'asset');
    expect(record.status).toBe(200);
    expect(body(record)).toMatchObject({ state: 'queued' });
    expect(jobWrites(h)).toHaveLength(1);
  });

  it('refuses the queue with the path off, in the caller\'s lane and not the control lane', async () => {
    const h = await saturatedShared();
    setStoreControlPathForTesting({});
    const { ctx, record, thrown } = route(h.queue);
    await handleKaShareAsyncEnqueue(ctx, 'asset');
    expect(record.status).toBe(503);
    expect(body(record)).toMatchObject({ admissionOutcome: 'not_admitted', phase: 'conflict' });
    const cause = (thrown.error as PromoteAdmissionError).cause;
    expect(isStoreSchedulerBusyError(cause)).toBe(true);
    expect(cause).toMatchObject({ reason: 'queue_full', priority: 'normal' });
    await expectNoJobPersisted(h);
  });
});
