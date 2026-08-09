import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The capability probe swallowed EVERY construction failure.
 *
 * Absence is the correct answer to one of them — another managed store in this
 * process already holds the lane — and that one is typed. Everything else is a
 * wiring bug, and turning it into a capability that is silently and permanently
 * missing is how such a bug survives.
 *
 * Stated plainly, because it decides how this file is written: nothing inside
 * the probe's `try` can throw anything other than the registration refusal
 * TODAY. The narrowed branch therefore has no reachable production trigger, and
 * its value is a failure it stops MASKING later rather than one it catches now.
 * That is exactly why the failure is INJECTED here — a test that waited for a
 * natural trigger would be a test that can never fail.
 */
const injected: { error: Error | null } = { error: null };

vi.mock('../src/system-record-materializer-v1.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/system-record-materializer-v1.js')
  >();
  return {
    ...actual,
    createSystemRecordLaneControllerV1: (deps: never) => {
      if (injected.error) throw injected.error;
      return actual.createSystemRecordLaneControllerV1(deps);
    },
  };
});

import '../src/adapters/sparql-http.js';

import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/internal/managed-oxigraph-ownership-v1.js';
import { SystemRecordControllerRegistrationError } from '../src/system-record-materializer-v1.js';
import { createTripleStore, type TripleStore } from '../src/triple-store.js';

const QUERY_ENDPOINT = 'http://127.0.0.1:7903/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:7903/update';

const supervisor: ManagedOxigraphSupervisorHandoffV1 = {
  stopAndProveOwnedChildDead: async () => undefined,
  startAndProveCleanGeneration: async () => undefined,
};

describe('capability probe error handling', () => {
  let stores: TripleStore[];

  const managedStore = async (): Promise<TripleStore> => {
    const ownership = createManagedOxigraphOwnershipControllerV1(
      QUERY_ENDPOINT,
      UPDATE_ENDPOINT,
    );
    ownership.bindReadyGeneration();
    const store = await createTripleStore({
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
    stores.push(store);
    return store;
  };

  beforeEach(() => {
    stores = [];
    injected.error = null;
  });

  afterEach(async () => {
    injected.error = null;
    for (const store of stores) await store.close().catch(() => undefined);
  });

  it('lets an UNEXPECTED construction failure surface', async () => {
    // The only test that fails if the catch is widened back. A wiring bug must
    // be loud, not a permanently missing capability with nothing logged.
    injected.error = new TypeError('wiring bug');
    const store = await managedStore();

    expect(() => store.getSystemRecordLaneControllerV1?.()).toThrow(TypeError);
  });

  it('still answers ABSENCE for the registration refusal', async () => {
    // The one failure where absence is correct: another store owns the lane.
    injected.error = new SystemRecordControllerRegistrationError();
    const store = await managedStore();

    expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
  });

  it('does not latch absence after a refusal clears', async () => {
    // The refusal is transient now that the holder releases on close, so
    // memoizing it as permanent absence would contradict the decorators above,
    // which re-probe for exactly that reason.
    injected.error = new SystemRecordControllerRegistrationError();
    const store = await managedStore();
    expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();

    injected.error = null;
    expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
  });

  it('does not latch after an unexpected failure clears either', async () => {
    injected.error = new TypeError('transient wiring bug');
    const store = await managedStore();
    expect(() => store.getSystemRecordLaneControllerV1?.()).toThrow(TypeError);

    injected.error = null;
    expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
  });
});
