import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1, SparqlHttpStore } from '../src/adapters/sparql-http.js';

// A read's work deadline on a SPARQL HTTP store. A managed Oxigraph server is
// stopped by a supervised restart, which the store requests when abandoned
// work outlives its deadline: the work deadline moves that moment to the read's
// own limit. A generic endpoint can only be hung up on.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** An endpoint that answers nothing until the request is aborted. */
function hangingEndpoint() {
  const aborted: AbortSignal[] = [];
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted.push(init.signal!); reject(init.signal!.reason); }, { once: true });
  })) as typeof fetch;
  return aborted;
}

function managedStore() {
  const recover = vi.fn();
  const store = createManagedOxigraphSparqlStoreV1(
    { queryEndpoint: 'http://127.0.0.1:7878/query', timeout: 10_000 },
    { getRecoveryState: () => ({ recovering: false, generation: 0 }), onClientTimeout: recover },
  );
  return { store, recover };
}

describe('SPARQL HTTP read with a work deadline', () => {
  it('managed: reclaims the read with a restart at its limit, not at the store timeout', async () => {
    hangingEndpoint();
    const { store, recover } = managedStore();
    const startedAt = performance.now();
    await expect(store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 150 }))
      .rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped', backend: 'oxigraph-server' });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(recover).toHaveBeenCalled();
    await store.close();
  });

  it('managed: a caller that leaves early has its read reclaimed at the limit', async () => {
    hangingEndpoint();
    const { store, recover } = managedStore();
    const controller = new AbortController();
    const reason = new Error('caller left');
    const startedAt = performance.now();
    const pending = store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 400, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(reason);
    await expect(pending).rejects.toMatchObject({ code: 'QUERY_WORK_STOPPED', outcome: 'stopped', cause: reason });
    expect(recover).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recover).toHaveBeenCalled(), { timeout: 5_000, interval: 20 });
    const reclaimedAfter = performance.now() - startedAt;
    expect(reclaimedAfter).toBeGreaterThanOrEqual(350);
    expect(reclaimedAfter).toBeLessThan(5_000);
    await store.close();
  });

  it('generic: hangs up at the limit and does not claim the endpoint stopped', async () => {
    const aborted = hangingEndpoint();
    const store = new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:7878/query', timeout: 10_000 });
    const error = await store.query('SELECT ?s WHERE { ?s ?p ?o }', { workDeadline: performance.now() + 100 })
      .then(() => null, (cause: unknown) => cause as { code?: string; timeoutMs?: number });
    expect(error).toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
    expect(error?.timeoutMs).toBeLessThanOrEqual(100);
    expect(aborted).toHaveLength(1);
    await store.close();
  });
});
