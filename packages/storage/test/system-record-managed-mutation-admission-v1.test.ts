import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/internal/managed-oxigraph-ownership-v1.js';
import { __resetSystemRecordControllerRegistrationForTests } from '../src/system-record-materializer-v1.js';
import { externalStorePriorityScheduler } from '../src/store-priority-scheduler.js';

let QUERY_ENDPOINT: string;
let UPDATE_ENDPOINT: string;
let server: Server;
let epoch: string | null;
const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
const UNRELATED_GRAPH =
  'did:dkg:context-graph:0x0000000000000000000000000000000000000001/example';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function drainTurns(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const quad = (graph: string) => ({
  subject: 'urn:test:s',
  predicate: 'urn:test:p',
  object: '"value"',
  graph,
});

describe('managed Oxigraph mutation admission V1', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;
  let store: SparqlHttpStore;
  let fetchCalls: number;
  const originalFetch = globalThis.fetch;

  const handoff: ManagedOxigraphSupervisorHandoffV1 = {
    stopAndProveOwnedChildDead: async () => undefined,
    startAndProveCleanGeneration: async () => undefined,
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (request.url === '/query') {
          response.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
          response.end(JSON.stringify({
            head: { vars: ['epoch'] },
            results: {
              bindings: epoch === null ? [] : [{ epoch: { type: 'literal', value: epoch } }],
            },
          }));
          return;
        }
        epoch = /INSERT[\s\S]*?materialization-epoch> "([0-9]+)"/u.exec(body)?.[1] ?? null;
        response.writeHead(epoch === null ? 400 : 204);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server has no port');
    QUERY_ENDPOINT = `http://127.0.0.1:${address.port}/query`;
    UPDATE_ENDPOINT = `http://127.0.0.1:${address.port}/update`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
    epoch = null;
    ownership = createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT);
    ownership.bindReadyGeneration();
    const options = attachManagedOxigraphLeaseV1(
      { queryEndpoint: QUERY_ENDPOINT, updateEndpoint: UPDATE_ENDPOINT },
      ownership.lease,
      handoff,
    );
    store = new SparqlHttpStore(options);
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await store.close().catch(() => undefined);
    __resetSystemRecordControllerRegistrationForTests();
  });

  async function activate(): Promise<void> {
    const controller = store.getSystemRecordLaneControllerV1?.();
    expect(controller).toBeDefined();
    await controller!.open({ networkId: 'testnet', kinds: ['agents'], mode: 'shadow' });
  }

  function holdAgentsExclusive(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
    readonly work: Promise<void>;
  } {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const generation = ownership.snapshot().childGeneration;
    const work = externalStorePriorityScheduler.run(
      'normal',
      'test.managed-mutation.agents-exclusive',
      async () => {
        entered.resolve(undefined);
        await gate.promise;
      },
      undefined,
      { storeId: store, generation, domain: 'agents', mode: 'exclusive' },
    );
    return { entered: entered.promise, release: () => gate.resolve(undefined), work };
  }

  function holdSchedulerCapacity(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
    readonly work: Promise<void>;
  } {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const capacity = externalStorePriorityScheduler.snapshot.maxConcurrent;
    let enteredCount = 0;
    const blockers = Array.from({ length: capacity }, (_, index) =>
      externalStorePriorityScheduler.run(
        'ack',
        `test.managed-mutation.capacity-${index}`,
        async () => {
          enteredCount += 1;
          if (enteredCount === capacity) entered.resolve(undefined);
          await gate.promise;
        },
      ));
    return {
      entered: entered.promise,
      release: () => gate.resolve(undefined),
      work: Promise.all(blockers).then(() => undefined),
    };
  }

  it('holds system mutations behind an agents exclusive', async () => {
    await activate();
    const exclusive = holdAgentsExclusive();
    await exclusive.entered;

    const systemWrite = store.insert([quad(AGENTS_GRAPH)]);
    await drainTurns();

    expect(fetchCalls).toBe(0);

    exclusive.release();
    await exclusive.work;
    await expect(systemWrite).resolves.toBeUndefined();
    expect(fetchCalls).toBe(1);
  });

  it('refuses opaque updates before dispatch while admission is active', async () => {
    await activate();

    await expect(store.update(
      'INSERT DATA { <urn:test:u> <urn:test:p> "x" }',
      { touchedGraphs: [UNRELATED_GRAPH] },
    )).rejects.toMatchObject({
      code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
    });
    expect(fetchCalls).toBe(0);
  });

  it('refuses a scoped mutation queued before activation when it reaches dispatch', async () => {
    const capacity = holdSchedulerCapacity();
    await capacity.entered;

    const write = store.insert([quad(AGENTS_GRAPH)]);
    await drainTurns();
    const activation = activate();
    await drainTurns();

    capacity.release();
    await capacity.work;
    await activation;

    await expect(write).rejects.toMatchObject({
      code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
    });
    expect(fetchCalls).toBe(0);
  });

  it('refuses an opaque update queued before activation when it reaches dispatch', async () => {
    const capacity = holdSchedulerCapacity();
    await capacity.entered;

    const write = store.update(
      'INSERT DATA { <urn:test:u> <urn:test:p> "x" }',
      { touchedGraphs: [UNRELATED_GRAPH] },
    );
    await drainTurns();
    const activation = activate();
    await drainTurns();

    capacity.release();
    await capacity.work;
    await activation;

    await expect(write).rejects.toMatchObject({
      code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
    });
    expect(fetchCalls).toBe(0);
  });

  it('keeps an explicit unrelated context-graph mutation concurrent with agents apply', async () => {
    await activate();
    const exclusive = holdAgentsExclusive();
    await exclusive.entered;

    await expect(store.insert([quad(UNRELATED_GRAPH)])).resolves.toBeUndefined();
    expect(fetchCalls).toBe(1);

    exclusive.release();
    await exclusive.work;
  });

  it('refuses a queued mutation when its child generation changes before dispatch', async () => {
    await activate();
    const exclusive = holdAgentsExclusive();
    await exclusive.entered;

    const write = store.insert([quad(AGENTS_GRAPH)]);
    await drainTurns();
    expect(fetchCalls).toBe(0);

    ownership.invalidate('child-revive');
    expect(ownership.bindReadyGeneration()).toBe('2');
    exclusive.release();
    await exclusive.work;

    await expect(write).rejects.toMatchObject({
      code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
    });
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ['temporarily unavailable', 'stop'],
    ['terminal', 'port-release-unproven'],
  ] as const)('fails closed before I/O when ownership is %s', async (_label, reason) => {
    await activate();
    ownership.invalidate(reason);

    await expect(store.insert([quad(UNRELATED_GRAPH)])).rejects.toMatchObject({
      code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
    });
    expect(fetchCalls).toBe(0);
  });

  it('keeps default-off mutations on the zero-metadata scheduler fast path', async () => {
    const before = externalStorePriorityScheduler.snapshot;
    await expect(store.insert([quad(UNRELATED_GRAPH)])).resolves.toBeUndefined();
    const after = externalStorePriorityScheduler.snapshot;

    expect(after.admissionEvaluations).toBe(before.admissionEvaluations);
    expect(after.admissionTrackedStores).toBe(before.admissionTrackedStores);
    expect(after.admissionTaggedQueued).toBe(before.admissionTaggedQueued);
    expect(after.admissionTaggedInflight).toBe(before.admissionTaggedInflight);
    expect(after.admissionHeldRuns).toBe(before.admissionHeldRuns);
    expect(fetchCalls).toBe(1);
  });

  it('keeps default-off opaque updates on the legacy dispatch path', async () => {
    const before = externalStorePriorityScheduler.snapshot;
    await expect(store.update(
      'INSERT DATA { <urn:test:u> <urn:test:p> "x" }',
      { touchedGraphs: [UNRELATED_GRAPH] },
    )).resolves.toBeUndefined();
    const after = externalStorePriorityScheduler.snapshot;

    expect(after.admissionEvaluations).toBe(before.admissionEvaluations);
    expect(after.admissionTrackedStores).toBe(before.admissionTrackedStores);
    expect(after.admissionTaggedQueued).toBe(before.admissionTaggedQueued);
    expect(after.admissionTaggedInflight).toBe(before.admissionTaggedInflight);
    expect(after.admissionHeldRuns).toBe(before.admissionHeldRuns);
    expect(fetchCalls).toBe(1);
  });

  it('does not evaluate managed admission state for an unowned endpoint', async () => {
    const unowned = new SparqlHttpStore({
      queryEndpoint: QUERY_ENDPOINT,
      updateEndpoint: UPDATE_ENDPOINT,
    });
    Object.defineProperty(unowned, 'systemRecordAdmissionActive', {
      configurable: true,
      get: () => {
        throw new Error('unowned update evaluated managed admission state');
      },
    });

    try {
      await expect(unowned.insert([quad(UNRELATED_GRAPH)])).resolves.toBeUndefined();
      expect(fetchCalls).toBe(1);
    } finally {
      await unowned.close();
    }
  });

  it('restores the zero-metadata scheduler fast path after a successful disable', async () => {
    const controller = store.getSystemRecordLaneControllerV1?.();
    expect(controller).toBeDefined();
    const session = await controller!.open({
      networkId: 'testnet',
      kinds: ['agents'],
      mode: 'shadow',
    });
    await session.close('disable');

    const before = externalStorePriorityScheduler.snapshot;
    await expect(store.insert([quad(UNRELATED_GRAPH)])).resolves.toBeUndefined();
    const after = externalStorePriorityScheduler.snapshot;

    expect(after.admissionEvaluations).toBe(before.admissionEvaluations);
    expect(after.admissionTrackedStores).toBe(before.admissionTrackedStores);
    expect(after.admissionTaggedQueued).toBe(before.admissionTaggedQueued);
    expect(after.admissionTaggedInflight).toBe(before.admissionTaggedInflight);
    expect(after.admissionHeldRuns).toBe(before.admissionHeldRuns);
    expect(fetchCalls).toBe(1);
  });
});
