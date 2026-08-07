import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Adapter registration is a side effect of importing the module.
import '../src/adapters/sparql-http.js';

import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import {
  __resetSystemRecordControllerRegistrationForTests,
  type SystemRecordChildHandoffV1,
} from '../src/system-record-materializer-v1.js';
import { createTripleStore, type TripleStore } from '../src/triple-store.js';

const ENDPOINT = 'http://oxigraph-ownership-dispatch.test/query';

const EMPTY_RESULTS = JSON.stringify({ head: { vars: [] }, results: { bindings: [] } });

const originalFetch = globalThis.fetch;

const QUAD = {
  graph: 'urn:dkg:test:g',
  subject: 'urn:dkg:test:s',
  predicate: 'urn:dkg:test:p',
  object: 'urn:dkg:test:o',
};

/**
 * A managed store must never put bytes on the wire toward a backend it cannot
 * prove it owns.
 *
 * Round 3 of the review reproduced the opposite: the scheduler holds ordinary
 * work while a control barrier is pending and releases it when the barrier
 * settles — identically whether it RESOLVED or REJECTED — and no mutation path
 * consulted ownership at dispatch. A mutation queued before a generation handoff
 * therefore resumed after that handoff had failed, and an `INSERT DATA` went on
 * the wire while the store's own lease already read `terminal: true,
 * port-release-unproven`.
 *
 * Every assertion here is on RECORDED REQUESTS, not on the thrown error: the
 * property is "zero I/O", and an error that arrives after a socket was opened
 * would satisfy a `rejects.toThrow` while failing the actual requirement.
 */
describe('managed backend ownership at mutation dispatch', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;
  let requests: string[];

  const supervisor: ManagedOxigraphSupervisorHandoffV1 = {
    stopAndProveOwnedChildDead: async () => undefined,
    startAndProveCleanGeneration: async () => undefined,
  };

  const recordFetch = (): void => {
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      requests.push(`${String(input)} :: ${String(init?.body ?? '')}`.slice(0, 120));
      return new Response(EMPTY_RESULTS, {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    }) as typeof fetch;
  };

  const managedStore = (): Promise<TripleStore> =>
    createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        { queryEndpoint: ENDPOINT, managedByDkg: true },
        ownership.lease,
        supervisor,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: false,
    });

  beforeEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1();
    ownership.bindReadyGeneration();
    requests = [];
    recordFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetSystemRecordControllerRegistrationForTests();
  });

  it('refuses a mutation with ZERO I/O after a failed port release', async () => {
    // The reviewer's first named regression: "failed port release with a foreign
    // listener plus a queued insert". `port-release-unproven` is terminal — the
    // supervisor could not prove our child released the bind, so whatever is
    // serving it may not be ours.
    const store = await managedStore();
    ownership.invalidate('port-release-unproven');

    await expect(store.insert([QUAD])).rejects.toThrow(/not the proven ready listener/);
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });

  it('refuses a mutation with ZERO I/O after a failed clean-generation start', async () => {
    // The reviewer's second named regression. Here the lease is NOT terminal —
    // the supervisor invalidated with `stop` and will revive — so a check keyed
    // only on terminality would let this through onto a dead port.
    const store = await managedStore();
    ownership.invalidate('stop');

    await expect(store.insert([QUAD])).rejects.toThrow(/not the proven ready listener/);
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });

  it('refuses during an ordinary child-exit revive window, with no lane involved', async () => {
    // The class, not the instance. The lane path has no production caller; this
    // one ships today — on any child exit the supervisor invalidates ownership
    // and revives, and for the whole backoff the adapter was still POSTing to a
    // port the daemon does not own.
    const store = await managedStore();
    ownership.invalidate('child-exit');

    await expect(store.insert([QUAD])).rejects.toThrow(/not the proven ready listener/);
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });

  it('resumes writes once a replacement generation is proven owned', async () => {
    // This is the review's requirement 4 — "clear it only after a replacement
    // generation is proven owned" — and it is why this is a READ rather than a
    // latch. There is no clear path to forget, because there is nothing to
    // clear. A sticky latch would have converted a self-healing respawn into a
    // mandatory node restart.
    const store = await managedStore();
    ownership.invalidate('child-exit');
    await expect(store.insert([QUAD])).rejects.toThrow();
    expect(requests).toEqual([]);

    ownership.bindReadyGeneration();
    await store.insert([QUAD]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('INSERT DATA');

    await store.close().catch(() => undefined);
  });

  it('never refuses a mutation on a store that holds no lease', async () => {
    // The default path. An operator-configured store has no lease and must be
    // untouched by any of this.
    const plain = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: ENDPOINT },
      graphSetIndex: false,
    });

    await plain.insert([QUAD]);
    expect(requests).toHaveLength(1);

    await plain.close().catch(() => undefined);
  });

  it('still serves READS while ownership is not provable', async () => {
    // Deliberate scope limit. Refusing reads too would turn every child respawn
    // into a total store outage — the same reasoning that made a failed lane
    // shutdown leave the child alive rather than kill the daemon's whole store.
    const store = await managedStore();
    ownership.invalidate('child-exit');

    await expect(store.query('ASK { ?s ?p ?o }')).resolves.toBeDefined();
    expect(requests).toHaveLength(1);

    await store.close().catch(() => undefined);
  });

  it('refuses a mutation the BARRIER queued, once the handoff that queued it fails', async () => {
    // THE reported shape, through the real mechanism rather than a stand-in: a
    // real `SparqlHttpStore`, the real process-global scheduler, and a real
    // control barrier that REJECTS.
    //
    // It is also the test that discriminates between checking at CALL time and
    // checking at DISPATCH. The insert is issued while the barrier is pending,
    // so it is held in the scheduler queue; a check at the top of `insert()`
    // would have run and passed before the handoff had even failed. Only a check
    // inside the work function — after the scheduler releases it — can see that
    // ownership was lost in the meantime.
    let stopCalled = false;
    const failing: ManagedOxigraphSupervisorHandoffV1 = {
      stopAndProveOwnedChildDead: async () => {
        stopCalled = true;
        // Exactly what the supervisor does when it cannot prove the port was
        // released: burn the lease terminal, then reject.
        ownership.invalidate('port-release-unproven');
        throw new Error('port release unproven');
      },
      startAndProveCleanGeneration: async () => undefined,
    };

    const store = await createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        { queryEndpoint: ENDPOINT, managedByDkg: true },
        ownership.lease,
        failing,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: false,
    });

    const lane = store.getSystemRecordLaneControllerV1?.();
    expect(lane).toBeDefined();

    const opening = lane!
      .open({ networkId: 'testnet', kinds: ['agents'], mode: 'shadow' })
      .then(() => 'resolved', () => 'rejected');

    // Issued while the barrier is pending: the scheduler holds it off the wire.
    const queued = store.insert([{ ...QUAD, subject: 'urn:dkg:test:queued' }]);

    expect(await opening).toBe('rejected');
    expect(stopCalled).toBe(true);

    await expect(queued).rejects.toThrow(/not the proven ready listener/);
    // The whole property: the barrier released it and it put NOTHING on the wire.
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });
});
