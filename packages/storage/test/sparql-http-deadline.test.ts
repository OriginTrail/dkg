import { describe, it, expect, vi } from 'vitest';
import {
  SparqlHttpStore,
  getExternalStorePrioritySchedulerSnapshot,
} from '../src/index.js';
import { waitForCondition } from './sparql-http-test-utils.js';

function emptySelectResponse(): Response {
  return new Response(JSON.stringify({
    head: { vars: [] },
    results: { bindings: [] },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/sparql-results+json' },
  });
}

async function saturateNormalStoreLanes(label: string): Promise<{
  normalSlots: number;
  fetchCalls: () => number;
  cleanup: (additional?: Array<Promise<unknown>>) => Promise<void>;
}> {
  const originalFetch = globalThis.fetch;
  const before = getExternalStorePrioritySchedulerSnapshot();
  const normalSlots = before.maxConcurrent - before.ackReservedSlots;
  const releaseFetches: Array<(response: Response) => void> = [];
  const blockers: Array<Promise<unknown>> = [];
  let fetchCalls = 0;

  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls++;
    return new Promise<Response>((resolve, reject) => {
      releaseFetches.push(resolve);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;

  const cleanup = async (additional: Array<Promise<unknown>> = []) => {
    for (const release of releaseFetches.splice(0)) release(emptySelectResponse());
    await Promise.allSettled([...blockers, ...additional]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    globalThis.fetch = originalFetch;
  };

  try {
    const blockingStore = new SparqlHttpStore({
      queryEndpoint: 'http://deadline.test/query',
      timeout: 30_000,
    });
    for (let i = 0; i < normalSlots; i++) {
      blockers.push(blockingStore.query(
        `SELECT ?s WHERE { # ${label}-blocker-${i}\n?s ?p ?o }`,
        { priority: 'normal' },
      ));
    }
    await waitForCondition(
      () => fetchCalls === normalSlots,
      `normal store lanes did not fill; fetchCalls=${fetchCalls}, slots=${normalSlots}`,
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    normalSlots,
    fetchCalls: () => fetchCalls,
    cleanup,
  };
}

async function outcomeWithin(work: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => {
        timer = setTimeout(() => resolve('still-pending'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('SparqlHttpStore deadlines and cancellation', () => {
  it('expires a SELECT while it is queued without dispatching it later', async () => {
    const saturation = await saturateNormalStoreLanes('select-deadline');
    const queuedBefore = getExternalStorePrioritySchedulerSnapshot().normalQueued;
    let queuedQuery: Promise<unknown> | undefined;
    let fetchCallsAfterRelease = 0;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 30,
      });
      const startedAt = Date.now();
      queuedQuery = deadlineStore.query(
        'SELECT ?s WHERE { # must-expire-in-queue\n?s ?p ?o }',
        { priority: 'normal' },
      );
      expect(getExternalStorePrioritySchedulerSnapshot().normalQueued).toBe(queuedBefore + 1);
      const outcome = await outcomeWithin(queuedQuery, 200);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(getExternalStorePrioritySchedulerSnapshot().normalQueued).toBe(queuedBefore);
    } finally {
      await saturation.cleanup(queuedQuery ? [queuedQuery] : []);
      fetchCallsAfterRelease = saturation.fetchCalls();
    }
    expect(fetchCallsAfterRelease).toBe(saturation.normalSlots);
  });

  it('removes a caller-cancelled SELECT from the queue without dispatching it later', async () => {
    const saturation = await saturateNormalStoreLanes('select-caller-abort');
    const queuedBefore = getExternalStorePrioritySchedulerSnapshot().normalQueued;
    const caller = new AbortController();
    const reason = new Error('caller cancelled while queued');
    let queuedQuery: Promise<unknown> | undefined;
    let fetchCallsAfterRelease = 0;

    try {
      const store = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 30_000,
      });
      queuedQuery = store.query(
        'SELECT ?s WHERE { # caller-cancelled-in-queue\n?s ?p ?o }',
        { priority: 'normal', signal: caller.signal },
      );

      expect(getExternalStorePrioritySchedulerSnapshot().normalQueued).toBe(queuedBefore + 1);
      caller.abort(reason);
      const outcome = await outcomeWithin(queuedQuery, 100);

      expect(outcome).toBe(reason);
      expect(getExternalStorePrioritySchedulerSnapshot().normalQueued).toBe(queuedBefore);
    } finally {
      await saturation.cleanup(queuedQuery ? [queuedQuery] : []);
      fetchCallsAfterRelease = saturation.fetchCalls();
    }
    expect(fetchCallsAfterRelease).toBe(saturation.normalSlots);
  });

  it('expires an UPDATE while it is queued without dispatching it later', async () => {
    const saturation = await saturateNormalStoreLanes('update-deadline');
    const queuedBefore = getExternalStorePrioritySchedulerSnapshot().normalQueued;
    let queuedUpdate: Promise<unknown> | undefined;
    let fetchCallsAfterRelease = 0;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        updateEndpoint: 'http://deadline.test/update',
        timeout: 30,
      });
      const startedAt = Date.now();
      queuedUpdate = deadlineStore.update(
        'INSERT DATA { <http://ex.org/s> <http://ex.org/p> "value" }',
        { priority: 'normal' },
      );
      expect(getExternalStorePrioritySchedulerSnapshot().normalQueued).toBe(queuedBefore + 1);
      const outcome = await outcomeWithin(queuedUpdate, 200);

      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(getExternalStorePrioritySchedulerSnapshot().normalQueued).toBe(queuedBefore);
    } finally {
      await saturation.cleanup(queuedUpdate ? [queuedUpdate] : []);
      fetchCallsAfterRelease = saturation.fetchCalls();
    }
    expect(fetchCallsAfterRelease).toBe(saturation.normalSlots);
  });

  it('keeps the UPDATE deadline active while reading an error response body', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        updateEndpoint: 'http://deadline.test/update',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.update(
        'INSERT DATA { <http://ex.org/s> <http://ex.org/p> "value" }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late body failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the SELECT deadline active while reading an error response body', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late body failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects promptly when SELECT JSON decoding ignores fetch abort', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<unknown>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late JSON failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects promptly when CONSTRUCT N-Quads decoding ignores fetch abort', async () => {
    const originalFetch = globalThis.fetch;
    let rejectBody!: (reason?: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: () => body,
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 10,
      });

      const startedAt = Date.now();
      const outcome = await outcomeWithin(deadlineStore.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      ), 100);
      expect(outcome).toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - startedAt).toBeLessThan(100);
    } finally {
      rejectBody(new Error('late N-Quads failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.fetch = originalFetch;
    }
  });

  it('checks the SELECT deadline after synchronous result mapping', async () => {
    const originalFetch = globalThis.fetch;
    const vars = ['name'];
    const originalIterator = vars[Symbol.iterator].bind(vars);
    vars[Symbol.iterator] = () => {
      const busyUntil = Date.now() + 25;
      while (Date.now() < busyUntil) {
        // Model CPU-bound result mapping, during which a timeout callback
        // cannot run because JavaScript is still on the same event-loop turn.
      }
      return originalIterator();
    };
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        head: { vars },
        results: {
          bindings: [{ name: { type: 'literal', value: 'Alice' } }],
        },
      }),
    }) as Response) as typeof fetch;

    try {
      const deadlineStore = new SparqlHttpStore({
        queryEndpoint: 'http://deadline.test/query',
        timeout: 5,
      });

      await expect(deadlineStore.query(
        'SELECT ?name WHERE { ?s ?p ?name }',
      )).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('composes caller abort signals into in-flight SELECT and CONSTRUCT fetches', async () => {
    const originalFetch = globalThis.fetch;
    const seenSignals: AbortSignal[] = [];
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal instanceof AbortSignal) seenSignals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    try {
      const signalController = new AbortController();
      const signalStore = new SparqlHttpStore({ queryEndpoint: 'http://example.test/query', timeout: 30_000 });
      const reason = new Error('caller aborted');

      const select = signalStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        { signal: signalController.signal },
      );
      const construct = signalStore.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
        { signal: signalController.signal },
      );
      await waitForCondition(
        () => seenSignals.length === 2,
        `caller signals did not reach both fetches; seen=${seenSignals.length}`,
      );

      expect(seenSignals).toHaveLength(2);
      expect(seenSignals.every((signal) => !signal.aborted)).toBe(true);
      signalController.abort(reason);
      expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
      await expect(select).rejects.toBe(reason);
      await expect(construct).rejects.toBe(reason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('detaches its caller abort listener after a completed operation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      head: { vars: [] },
      results: { bindings: [] },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    })) as typeof fetch;
    const caller = new AbortController();
    const addListener = vi.spyOn(caller.signal, 'addEventListener');
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');

    try {
      const signalStore = new SparqlHttpStore({
        queryEndpoint: 'http://example.test/query',
        timeout: 30_000,
      });
      await signalStore.query(
        'SELECT ?s WHERE { ?s ?p ?o }',
        { signal: caller.signal },
      );

      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
    } finally {
      addListener.mockRestore();
      removeListener.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects in-flight queries when the caller aborts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    try {
      const signalController = new AbortController();
      const signalStore = new SparqlHttpStore({ queryEndpoint: 'http://example.test/query', timeout: 30_000 });
      const query = signalStore.query('SELECT ?s WHERE { ?s ?p ?o }', { signal: signalController.signal });

      await new Promise((resolve) => setTimeout(resolve, 0));
      signalController.abort(new Error('caller aborted'));

      await expect(query).rejects.toThrow(/caller aborted/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
