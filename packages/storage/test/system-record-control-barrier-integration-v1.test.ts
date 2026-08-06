import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Adapter registration is a side effect of importing the module (see
// `system-record-capability-discovery-v1.test.ts`).
import '../src/adapters/sparql-http.js';

import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import {
  __resetSystemRecordControllerRegistrationForTests,
  type SystemRecordLaneActivationV1,
} from '../src/system-record-materializer-v1.js';
import { createTripleStore, type TripleStore } from '../src/triple-store.js';

const ENDPOINT = 'http://oxigraph-barrier.test/query';

const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

const EMPTY_RESULTS = JSON.stringify({ head: { vars: [] }, results: { bindings: [] } });

const originalFetch = globalThis.fetch;

/** Lets the test hold an ordinary store request open for as long as it likes. */
class GatedFetch {
  entered = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  private reachedEntry!: () => void;
  readonly firstEntry = new Promise<void>((resolve) => {
    this.reachedEntry = resolve;
  });

  install(): void {
    globalThis.fetch = (async () => {
      this.entered += 1;
      this.reachedEntry();
      await this.gate;
      return new Response(EMPTY_RESULTS, {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    }) as typeof fetch;
  }

  open(): void {
    this.release();
  }
}

/** Records whether — and when — the supervisor was asked to touch the child. */
class RecordingSupervisor implements ManagedOxigraphSupervisorHandoffV1 {
  readonly calls: string[] = [];
  stopAndProveOwnedChildDead = async (): Promise<void> => {
    this.calls.push('stop');
  };

  startAndProveCleanGeneration = async (): Promise<void> => {
    this.calls.push('start');
  };
}

/** Yield enough turns that anything not actually blocked would have run. */
async function drainTurns(count = 40): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * End-to-end proof that the lane's exclusive section is REAL: a real adapter, the
 * real process-global scheduler, the real handoff composition, and a genuinely
 * in-flight ordinary request.
 *
 * The unit tests above this assert that each transition asks for a barrier. They
 * cannot show that asking for one has any effect, because they inject a
 * pass-through stand-in. This file is the one that would have caught the
 * original defect — a lane that stopped and replaced the owned child while
 * ordinary requests were still on it, because the scheduler's control barrier
 * had zero production callers.
 */
describe('system-record lane control barrier (real adapter + scheduler)', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;
  let supervisor: RecordingSupervisor;
  let gated: GatedFetch;
  let store: TripleStore;

  beforeEach(async () => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1();
    ownership.bindReadyGeneration();
    supervisor = new RecordingSupervisor();
    gated = new GatedFetch();
    store = await createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        // A long transport timeout: the point of the held request is that it is
        // still in flight when the transition asks for the store, so it must not
        // be cut short by the adapter's own deadline.
        { queryEndpoint: ENDPOINT, managedByDkg: true, timeout: 60_000 },
        ownership.lease,
        supervisor,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: false,
    });
  });

  afterEach(async () => {
    gated.open();
    globalThis.fetch = originalFetch;
    await store?.close().catch(() => undefined);
    __resetSystemRecordControllerRegistrationForTests();
  });

  it('does not stop the owned child while an ordinary store request is in flight', async () => {
    const controller = store.getSystemRecordLaneControllerV1?.();
    expect(controller).toBeDefined();

    gated.install();
    // Held OPEN, not merely issued: it holds scheduler admission until released.
    const inflight = store.query('SELECT ?s WHERE { ?s ?p ?o }');
    await gated.firstEntry;
    expect(gated.entered).toBe(1);

    const opening = controller!.open(ACTIVATION);
    await drainTurns();

    // THE assertion. Without the barrier this reads ['stop', 'start'] here: the
    // child is signalled, its port asserted free and a replacement bound, all
    // while a request issued against the old generation is still outstanding.
    expect(supervisor.calls).toEqual([]);

    gated.open();
    await expect(inflight).resolves.toMatchObject({ type: 'bindings' });

    // ...and the transition is not merely deferred forever: once the store has
    // quiesced it proceeds, in order. This half is what makes the assertion
    // above discriminating rather than a test that can only pass.
    const session = await opening;
    expect(supervisor.calls).toEqual(['stop', 'start']);
    expect(session.state).toBe('enabled');
  });

  it('runs the transition immediately when the store is already quiesced', async () => {
    // Positive control for the timing claim: the wait above is caused by the
    // in-flight request, not by the barrier being slow or the open being async.
    const controller = store.getSystemRecordLaneControllerV1?.();
    const session = await controller!.open(ACTIVATION);
    expect(supervisor.calls).toEqual(['stop', 'start']);
    expect(session.state).toBe('enabled');
  });

  it('lets an ordinary request issued during the section proceed after it', async () => {
    // The barrier holds new admission for the duration; it must RELEASE it, not
    // strand it. A transition that quiesced the store and never resumed it would
    // be a silent, permanent store outage.
    const controller = store.getSystemRecordLaneControllerV1?.();

    gated.install();
    const held = store.query('SELECT ?s WHERE { ?s ?p ?o }');
    await gated.firstEntry;

    const opening = controller!.open(ACTIVATION);
    await drainTurns(10);
    const queuedDuringSection = store.query('ASK { ?s ?p ?o }');

    gated.open();
    await held;
    await opening;

    await expect(queuedDuringSection).resolves.toBeDefined();
    expect(supervisor.calls).toEqual(['stop', 'start']);
  });
});
