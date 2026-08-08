import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Adapter registration is a side effect of importing the module.
import '../src/adapters/sparql-http.js';

import {
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
} from '../src/internal-graph-policy.js';
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

const QUERY_ENDPOINT = 'http://127.0.0.1:7901/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:7901/update';

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
      const body = String(init?.body ?? '');
      requests.push(`${String(input)} :: ${body}`.slice(0, 120));
      // ASK answers must be ASK-shaped; a SELECT-shaped body makes `hasGraph`
      // return `undefined` rather than a boolean and hides what is being tested.
      const payload = /^\s*ASK/i.test(body) ? JSON.stringify({ boolean: false }) : EMPTY_RESULTS;
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    }) as typeof fetch;
  };

  const managedStore = (): Promise<TripleStore> =>
    createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        {
          queryEndpoint: QUERY_ENDPOINT,
          updateEndpoint: UPDATE_ENDPOINT,
          managedByDkg: true,
        },
        ownership.lease,
        supervisor,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: false,
    });

  beforeEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1(
      QUERY_ENDPOINT,
      UPDATE_ENDPOINT,
    );
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
      options: { queryEndpoint: QUERY_ENDPOINT },
      graphSetIndex: false,
    });

    await plain.insert([QUAD]);
    expect(requests).toHaveLength(1);

    await plain.close().catch(() => undefined);
  });

  it('refuses a default-off managed store whose endpoints do not match its lease', async () => {
    const store = await createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        {
          queryEndpoint: 'http://127.0.0.1:7904/query',
          updateEndpoint: 'http://127.0.0.1:7904/update',
          managedByDkg: true,
        },
        ownership.lease,
        supervisor,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: false,
    });

    await expect(store.insert([QUAD])).rejects.toThrow(/not the proven ready listener/);
    await expect(store.query('ASK { ?s ?p ?o }')).rejects.toThrow(
      /not the proven ready listener/,
    );
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });

  it('refuses listGraphs from the adapter cache after ownership is lost', async () => {
    // The adapter keeps its OWN warm list for MANAGED_LIST_GRAPHS_CACHE_MS
    // (30 s), served without touching the endpoint — so it never reached the
    // read check on `query`, and a lost lease kept answering enumeration from
    // it for the whole window. Same defect the graph-set decorator had; found
    // by sweeping the class rather than only the reported instance.
    const store = await managedStore();

    await store.listGraphs(); // warm it
    const afterWarm = requests.length;
    expect(afterWarm).toBeGreaterThan(0);

    ownership.invalidate('port-release-unproven');

    await expect(store.listGraphs()).rejects.toThrow(/not the proven ready listener/);
    // A cached read would have produced no I/O either, so the refusal is the
    // load-bearing assertion here; the request count guards against the fix
    // "working" by accidentally forcing a refresh.
    expect(requests.length).toBe(afterWarm);

    await store.close().catch(() => undefined);
  });

  it('hides reserved internal graphs from adapter-level hasGraph', async () => {
    // The policy module claims reserved state never enumerates and that "no
    // legitimate iterate-and-drop loop can reach one". That held only for the
    // INDEXED composition: `hasGraph` asked the backend directly, so a store
    // built without the graph-set index answered `true` and revealed that
    // reserved state exists. Answered here, before any I/O.
    const store = await managedStore();

    expect(await store.hasGraph(SYSTEM_RECORD_V1_STATE_GRAPH)).toBe(false);
    expect(await store.hasGraph(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH)).toBe(false);
    expect(requests).toEqual([]);

    // An ordinary graph still reaches the backend, so the guard is scoped and
    // not a blanket refusal.
    expect(await store.hasGraph('urn:dkg:test:ordinary')).toBe(false);
    expect(requests).toHaveLength(1);

    await store.close().catch(() => undefined);
  });

  it('refuses a READ with ZERO I/O once ownership is terminal', async () => {
    // The foreign-listener case. `port-release-unproven` means the supervisor
    // could not prove our child released the bind and will never bind another,
    // so whatever answers may not be ours — and a foreign answer does not stay
    // local: assertion authorship puts a merkle root ON-CHAIN and the sync
    // responder serves store reads TO PEERS.
    const store = await managedStore();
    ownership.invalidate('port-release-unproven');

    await expect(store.query('ASK { ?s ?p ?o }')).rejects.toThrow(/not the proven ready listener/);
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });

  for (const reason of ['child-exit', 'child-revive'] as const) {
    it(`refuses a READ with ZERO I/O during a recoverable ${reason} window`, async () => {
      // This test previously asserted the OPPOSITE — that a not-ready read is
      // served — on the argument that it "fails at the transport anyway". That
      // argument was wrong, and this is the counter-example: an unexpected child
      // exit is NON-terminal, and if another process binds the port during the
      // backoff/revive window the read succeeds against a foreign server and its
      // answer is accepted as node state.
      //
      // Refusing here is bounded and self-clearing — it lasts until
      // `bindReadyGeneration()` proves the replacement — which is exactly the
      // transient condition consumers' retry-with-backoff branches exist for.
      const store = await managedStore();
      ownership.invalidate(reason);

      await expect(store.query('ASK { ?s ?p ?o }')).rejects.toThrow(
        /not the proven ready listener/,
      );
      expect(requests).toEqual([]);

      await store.close().catch(() => undefined);
    });
  }

  it('serves reads again once a replacement generation is proven', async () => {
    // The bound on the refusal above, and what makes it transient rather than
    // an outage: there is no state to clear, so recovery is automatic.
    const store = await managedStore();
    ownership.invalidate('child-exit');
    await expect(store.query('ASK { ?s ?p ?o }')).rejects.toThrow();
    expect(requests).toEqual([]);

    ownership.bindReadyGeneration();
    await expect(store.query('ASK { ?s ?p ?o }')).resolves.toBeDefined();
    expect(requests).toHaveLength(1);

    await store.close().catch(() => undefined);
  });

  it('refuses deleteByPattern with ZERO I/O on a merely NOT-READY lease', async () => {
    // This is what makes the pre-count guard load-bearing, and it took a
    // surviving mutant to find: on a TERMINAL lease the read guard already
    // refuses the count, so removing the pre-count guard changed nothing there.
    // Not-ready is the case only it covers — the write will be refused anyway,
    // so counting first is a socket opened to a child that is being replaced.
    const store = await managedStore();
    ownership.invalidate('child-exit');

    await expect(store.deleteByPattern({ subject: 'urn:dkg:test:s' })).rejects.toThrow(
      /not the proven ready listener/,
    );
    expect(requests).toEqual([]);

    await expect(store.deleteBySubjectPrefix('urn:dkg:test:g', 'urn:dkg:test:')).rejects.toThrow(
      /not the proven ready listener/,
    );
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });

  it('refuses the read that deleteByPattern issues BEFORE its update', async () => {
    // `deleteByPattern` and `deleteBySubjectPrefix` count first. That count
    // reached the wire ahead of the mutation guard, so the write was refused
    // while a socket had already been opened and a foreign count consumed —
    // making the "zero I/O" property claimed for mutations false for exactly
    // these two methods.
    const store = await managedStore();
    ownership.invalidate('port-release-unproven');

    await expect(store.deleteByPattern({ subject: 'urn:dkg:test:s' })).rejects.toThrow(
      /not the proven ready listener/,
    );
    expect(requests).toEqual([]);

    await expect(store.deleteBySubjectPrefix('urn:dkg:test:g', 'urn:dkg:test:')).rejects.toThrow(
      /not the proven ready listener/,
    );
    expect(requests).toEqual([]);

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
        {
          queryEndpoint: QUERY_ENDPOINT,
          updateEndpoint: UPDATE_ENDPOINT,
          managedByDkg: true,
        },
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

    await expect(queued).rejects.toThrow(/managed Oxigraph mutation is unavailable/);
    // The whole property: the barrier released it and it put NOTHING on the wire.
    expect(requests).toEqual([]);

    await store.close().catch(() => undefined);
  });
});
