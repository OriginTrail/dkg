import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GraphSetIndexStore,
  createTripleStore,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  ManagedOxigraphBackendUnownedError,
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '@origintrail-official/dkg-storage/internal/managed-oxigraph-ownership-v1';

import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

/**
 * The daemon's store is wrapped by this hand-rolled forwarder, and the forwarder
 * drives an external read cache through its `invalidate()` callback — so reads
 * genuinely can be answered above it without delegating downward.
 *
 * An earlier design made the managed read gate an optional method every wrapper
 * had to re-declare; this one, in a different package, did not, so the gate
 * silently vanished here and warm reads went fail-open. A source-scanning test
 * inside packages/storage could never have seen it, which is why the coverage
 * lives here.
 *
 * Everything below uses the REAL managed adapter rather than a hand-built fake:
 * the gate is symbol-keyed and storage-internal, so a fake would have to import
 * that symbol, and widening the published API to make a test compile is the
 * trade this PR already had to undo once.
 */
const QUERY_ENDPOINT = 'http://127.0.0.1:7941/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:7941/update';

const EMPTY_SELECT = JSON.stringify({ head: { vars: [] }, results: { bindings: [] } });
const originalFetch = globalThis.fetch;

describe('managed read gate survives the agent store wrapper', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;

  const supervisor: ManagedOxigraphSupervisorHandoffV1 = {
    stopAndProveOwnedChildDead: async () => undefined,
    startAndProveCleanGeneration: async () => undefined,
  };

  beforeEach(() => {
    ownership = createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT);
    ownership.bindReadyGeneration();
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = String(init?.body ?? '');
      const payload = /^\s*ASK/i.test(body) ? JSON.stringify({ boolean: false }) : EMPTY_SELECT;
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** index -> agent forwarder -> real managed adapter. */
  const composed = async (managed: boolean): Promise<TripleStore> => {
    const adapter = await createTripleStore({
      backend: 'sparql-http',
      options: managed
        ? (attachManagedOxigraphLeaseV1(
            { queryEndpoint: QUERY_ENDPOINT, updateEndpoint: UPDATE_ENDPOINT, managedByDkg: true },
            ownership.lease,
            supervisor,
          ) as unknown as Record<string, unknown>)
        : { queryEndpoint: QUERY_ENDPOINT, updateEndpoint: UPDATE_ENDPOINT },
      graphSetIndex: false,
    });

    return new GraphSetIndexStore(
      createListContextGraphsCacheInvalidatingStore(adapter, () => undefined),
    );
  };

  it('refuses a WARM listGraphs once ownership is lost', async () => {
    const index = await composed(true);
    await index.listGraphs(); // warm the index

    ownership.invalidate('port-release-unproven');

    await expect(index.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);
    await index.close().catch(() => undefined);
  });

  it('refuses a WARM listGraphsByPrefix once ownership is lost', async () => {
    const index = await composed(true);
    await index.listGraphs();

    ownership.invalidate('port-release-unproven');

    await expect(index.listGraphsByPrefix('urn:')).rejects.toThrow(
      ManagedOxigraphBackendUnownedError,
    );
    await index.close().catch(() => undefined);
  });

  it('still serves a warm read while ownership is live', async () => {
    // Positive control: without it, "always refuse" would satisfy both cases
    // above and the wrapper could be breaking reads rather than gating them.
    const index = await composed(true);

    await index.listGraphs();
    await expect(index.listGraphs()).resolves.toEqual([]);

    await index.close().catch(() => undefined);
  });

  it('leaves an unleased store behind the same wrapper untouched', async () => {
    // No managed backend anywhere in the chain must mean no refusal invented.
    const index = await composed(false);

    await index.listGraphs();
    await expect(index.listGraphs()).resolves.toEqual([]);

    await index.close().catch(() => undefined);
  });
});
