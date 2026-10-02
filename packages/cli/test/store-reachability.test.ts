import {
  SparqlHttpStore,
  StoreOperationTimeoutError,
  StorePriorityScheduler,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeExternalStore } from '../src/daemon/store-reachability.js';

type ProbeAgent = Parameters<typeof probeExternalStore>[0];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function agentAnswering(query: (sparql: string) => Promise<unknown>): {
  agent: ProbeAgent;
  calls: Array<{ sparql: string; options: unknown }>;
} {
  const calls: Array<{ sparql: string; options: unknown }> = [];
  const store = {
    query: (sparql: string, options?: unknown) => {
      calls.push({ sparql, options });
      return query(sparql);
    },
  };
  return { agent: { store } as unknown as ProbeAgent, calls };
}

function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface HeldRequest {
  sparql: string;
  signal: AbortSignal;
  answer: (body: unknown) => void;
  fail: (error: Error) => void;
}

// Stands in for the store's SPARQL endpoint: every request the store sends
// waits until the test answers or fails it, and an aborted one rejects, as
// with the real fetch.
function holdStoreRequests(): HeldRequest[] {
  const requests: HeldRequest[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    requests.push({
      sparql: String(init.body),
      signal,
      answer: (body) => resolve(new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/sparql-results+json' },
      })),
      fail: reject,
    });
  }));
  return requests;
}

function agentWithStore(scheduler: StorePriorityScheduler): { agent: ProbeAgent; store: SparqlHttpStore } {
  const store = new SparqlHttpStore({ queryEndpoint: 'http://store.test/query', scheduler });
  return { agent: { store } as unknown as ProbeAgent, store };
}

// One slot and no reserves: a single running read makes every other wait.
const ONE_SLOT = {
  maxConcurrent: 1,
  ackReservedSlots: 0,
  healthReservedSlots: 0,
  backgroundReservedSlots: 0,
};

describe('probeExternalStore', () => {
  it.each([true, false])('reports a store that answers the ASK with %s as reachable', async (answer) => {
    const { agent, calls } = agentAnswering(async () => ({ type: 'boolean', value: answer }));

    await expect(probeExternalStore(agent)).resolves.toBe('reachable');
    // A health-lane ASK with no abort signal: abandoning a dispatched read
    // could make a managed Oxigraph restart itself.
    expect(calls).toEqual([{
      sparql: 'ASK { ?s ?p ?o }',
      options: { priority: 'health', source: 'daemon.status.storeProbe' },
    }]);
  });

  it('reports a store whose query fails as unreachable', async () => {
    const { agent } = agentAnswering(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7880');
    });

    await expect(probeExternalStore(agent)).resolves.toBe('unreachable');
  });

  it('reports a query that throws synchronously as unreachable instead of rejecting', async () => {
    const { agent } = agentAnswering(() => {
      throw new Error('store closed');
    });

    await expect(probeExternalStore(agent)).resolves.toBe('unreachable');
  });

  // The errors a managed Oxigraph's store raises while the server restarts:
  // the read was refused, or the restart cut it off.
  it.each([
    ['not_started', 'Managed Oxigraph is recovering; query was not started'],
    ['indeterminate', 'Managed Oxigraph recovery interrupted query; outcome is indeterminate'],
  ] as const)('reports a managed Oxigraph that is restarting (%s) as unreachable', async (outcome, message) => {
    const { agent } = agentAnswering(async () => {
      throw new StoreOperationTimeoutError({ backend: 'oxigraph-server', operation: 'query', outcome, message });
    });

    await expect(probeExternalStore(agent)).resolves.toBe('unreachable');
  });

  it.each(['queue_full', 'queue_wait_timeout'] as const)(
    'reports a probe the daemon store scheduler refused (%s) as no answer, not unreachable',
    async (reason) => {
      const { agent } = agentAnswering(async () => {
        throw new StoreSchedulerBusyError(reason, 'health', 'query');
      });

      await expect(probeExternalStore(agent)).resolves.toBe('no-answer');
    },
  );

  it('stops waiting without cancelling the probe, and shares it until it settles', async () => {
    const answer = deferred<unknown>();
    const { agent, calls } = agentAnswering(() => answer.promise);

    await expect(probeExternalStore(agent, 10)).resolves.toBe('no-answer');
    await expect(probeExternalStore(agent, 10)).resolves.toBe('no-answer');
    expect(calls).toHaveLength(1);

    answer.resolve({ type: 'boolean', value: true });
    await expect(probeExternalStore(agent, 10)).resolves.toBe('reachable');
    expect(calls).toHaveLength(1);

    // A settled probe is not reused: the next check asks the store again.
    await nextTick();
    await probeExternalStore(agent, 10);
    expect(calls).toHaveLength(2);
  });

  it('keeps each store\'s probe apart: another store is asked, and answers, on its own', async () => {
    const stalled = deferred<unknown>();
    const first = agentAnswering(() => stalled.promise);
    const second = agentAnswering(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7890');
    });

    await expect(probeExternalStore(first.agent, 10)).resolves.toBe('no-answer');
    // The first store's probe is still running; the second store gets its own.
    await expect(probeExternalStore(second.agent, 10)).resolves.toBe('unreachable');
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);

    // The first store's late answer is its own: the second store still fails.
    stalled.resolve({ type: 'boolean', value: true });
    await expect(probeExternalStore(first.agent, 10)).resolves.toBe('reachable');
    await expect(probeExternalStore(second.agent, 10)).resolves.toBe('unreachable');
  });

  it('runs one probe for concurrent callers', async () => {
    const answer = deferred<unknown>();
    const { agent, calls } = agentAnswering(() => answer.promise);

    const results = Promise.all([probeExternalStore(agent), probeExternalStore(agent)]);
    answer.resolve({ type: 'boolean', value: true });

    await expect(results).resolves.toEqual(['reachable', 'reachable']);
    expect(calls).toHaveLength(1);
  });
});

describe('probeExternalStore over a real SPARQL HTTP store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports a store that answers the ASK as reachable', async () => {
    const requests = holdStoreRequests();
    const { agent } = agentWithStore(new StorePriorityScheduler({ maxConcurrent: 4 }));

    const probe = probeExternalStore(agent);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].sparql).toBe('ASK { ?s ?p ?o }');
    requests[0].answer({ head: {}, boolean: true });

    await expect(probe).resolves.toBe('reachable');
  });

  it('reports a store whose endpoint refuses the connection as unreachable', async () => {
    const requests = holdStoreRequests();
    const { agent } = agentWithStore(new StorePriorityScheduler({ maxConcurrent: 4 }));

    const probe = probeExternalStore(agent);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0].fail(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }));

    await expect(probe).resolves.toBe('unreachable');
  });

  // The probe waits ten seconds and the test fails after five: only the
  // scheduler's own refusal can answer these in time.
  it('reports a probe the scheduler refuses, its health queue full, as no answer without sending it', async () => {
    const requests = holdStoreRequests();
    const scheduler = new StorePriorityScheduler({
      ...ONE_SLOT,
      queueLimits: { ack: 1, health: 1, normal: 1, background: 1 },
    });
    const { agent } = agentWithStore(scheduler);
    const release = deferred<void>();
    const running = scheduler.run('health', 'test.running', () => release.promise);
    const queued = scheduler.run('health', 'test.queued', async () => {});

    try {
      await expect(probeExternalStore(agent, 10_000)).resolves.toBe('no-answer');
      expect(requests).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all([running, queued]);
    }
  }, 5_000);

  it('reports a probe that times out in the scheduler queue behind a running COUNT as no answer', async () => {
    const requests = holdStoreRequests();
    const { agent, store } = agentWithStore(new StorePriorityScheduler({
      ...ONE_SLOT,
      queueWaitTimeoutMs: 20,
    }));
    // A status count holds the only slot on the same health lane.
    const count = store.query(
      'SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }',
      { priority: 'health' },
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    try {
      await expect(probeExternalStore(agent, 10_000)).resolves.toBe('no-answer');
      expect(requests).toHaveLength(1);
    } finally {
      requests[0].fail(new Error('test finished'));
      await expect(count).rejects.toThrow('test finished');
    }
  }, 5_000);

  it('stops waiting for an ASK the store holds without aborting it, and the read completes', async () => {
    const requests = holdStoreRequests();
    const { agent, store } = agentWithStore(new StorePriorityScheduler({ maxConcurrent: 4 }));
    const query = vi.spyOn(store, 'query');

    await expect(probeExternalStore(agent, 20)).resolves.toBe('no-answer');
    // Well after the caller gave up, the request is still open: aborting a
    // read Oxigraph is evaluating makes a managed store restart itself.
    await sleep(100);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(false);

    requests[0].answer({ head: {}, boolean: true });
    await expect(query.mock.results[0].value).resolves.toEqual({ type: 'boolean', value: true });
  });
});
