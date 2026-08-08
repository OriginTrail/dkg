import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Adapter registration is a side effect of importing the module.
import '../src/adapters/sparql-http.js';

import {
  ManagedOxigraphBackendUnownedError,
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import { __resetSystemRecordControllerRegistrationForTests } from '../src/system-record-materializer-v1.js';
import { createTripleStore, type TripleStore } from '../src/triple-store.js';

/**
 * The warm-read ownership guard must survive REAL decorator compositions.
 *
 * `GraphSetIndexStore` used to call `this.inner.assertManagedBackendReadableV1?.(…)`,
 * and optional chaining treats an absent method as PERMISSION. Production
 * composes `GraphSetIndexStore(ChangelogStore(SharedMemoryLiteralBlobStore(
 * SparqlHttpStore)))`, so with either middle wrapper present the call lands on
 * a decorator that does not implement it, evaporates, and the warm cache is
 * served for the whole revalidation window after the lease is lost.
 *
 * The single-decorator tests in `managed-terminal-read-through-index-v1` cannot
 * see this: they wrap a fake that answers the capability directly.
 */
const QUERY_ENDPOINT = 'http://127.0.0.1:7931/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:7931/update';

const EMPTY_SELECT = JSON.stringify({ head: { vars: [] }, results: { bindings: [] } });

const originalFetch = globalThis.fetch;

describe('warm-read ownership refusal through production compositions', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;
  let blobDir: string;
  let requests: number;

  const supervisor: ManagedOxigraphSupervisorHandoffV1 = {
    stopAndProveOwnedChildDead: async () => undefined,
    startAndProveCleanGeneration: async () => undefined,
  };

  beforeEach(async () => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT);
    ownership.bindReadyGeneration();
    blobDir = await mkdtemp(join(tmpdir(), 'dkg-warm-read-'));
    requests = 0;
    globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      requests += 1;
      const body = String(init?.body ?? '');
      const payload = /^\s*ASK/i.test(body) ? JSON.stringify({ boolean: false }) : EMPTY_SELECT;
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    __resetSystemRecordControllerRegistrationForTests();
    await rm(blobDir, { recursive: true, force: true }).catch(() => undefined);
  });

  /** The composition under test, built by the PRODUCTION factory. */
  const composedStore = (largeLiteralStorage: boolean): Promise<TripleStore> =>
    createTripleStore({
      backend: 'sparql-http',
      options: attachManagedOxigraphLeaseV1(
        { queryEndpoint: QUERY_ENDPOINT, updateEndpoint: UPDATE_ENDPOINT, managedByDkg: true },
        ownership.lease,
        supervisor,
      ) as unknown as Record<string, unknown>,
      graphSetIndex: true,
      ...(largeLiteralStorage
        ? { largeLiteralStorage: { enabled: true, directory: blobDir } }
        : {}),
    });

  for (const largeLiteralStorage of [false, true]) {
    const shape = largeLiteralStorage
      ? 'graphSetIndex + largeLiteralStorage'
      : 'graphSetIndex only';

    it(`refuses a warm listGraphs after ownership loss — ${shape}`, async () => {
      const store = await composedStore(largeLiteralStorage);

      await store.listGraphs(); // warm the index
      const afterWarm = requests;
      expect(afterWarm).toBeGreaterThan(0);

      ownership.invalidate('port-release-unproven');

      await expect(store.listGraphs()).rejects.toThrow(ManagedOxigraphBackendUnownedError);
      // No I/O: the refusal must come from the lease snapshot, not from a
      // refresh that happened to fail at the endpoint.
      expect(requests).toBe(afterWarm);

      await store.close().catch(() => undefined);
    });

    it(`refuses a warm listGraphsByPrefix after ownership loss — ${shape}`, async () => {
      const store = await composedStore(largeLiteralStorage);

      await store.listGraphs();
      const afterWarm = requests;

      ownership.invalidate('port-release-unproven');

      await expect(store.listGraphsByPrefix('urn:')).rejects.toThrow(
        ManagedOxigraphBackendUnownedError,
      );
      expect(requests).toBe(afterWarm);

      await store.close().catch(() => undefined);
    });

    it(`still serves a warm read while ownership is live — ${shape}`, async () => {
      // Positive control. Without it, "always refuse on the warm path" would
      // satisfy every assertion above.
      const store = await composedStore(largeLiteralStorage);

      await store.listGraphs();
      const afterWarm = requests;

      await expect(store.listGraphs()).resolves.toEqual([]);
      expect(requests).toBe(afterWarm); // served warm, no refresh

      await store.close().catch(() => undefined);
    });
  }

  it('leaves an UNLEASED store untouched through the same composition', async () => {
    // The capability must stay absent-and-harmless where there is no lease:
    // forwarding it through decorators must not invent a refusal.
    const plain = await createTripleStore({
      backend: 'sparql-http',
      options: { queryEndpoint: QUERY_ENDPOINT, updateEndpoint: UPDATE_ENDPOINT },
      graphSetIndex: true,
      largeLiteralStorage: { enabled: true, directory: blobDir },
    });

    await plain.listGraphs();
    await expect(plain.listGraphs()).resolves.toEqual([]);

    await plain.close().catch(() => undefined);
  });
});
