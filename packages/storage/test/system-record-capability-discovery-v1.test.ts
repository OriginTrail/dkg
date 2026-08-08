import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Adapter registration is a side effect of importing the module; `index.ts`
// does this in production. Importing `triple-store.js` alone leaves the
// registry empty.
import '../src/adapters/sparql-http.js';

import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphSupervisorHandoffV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import { __resetSystemRecordControllerRegistrationForTests } from '../src/system-record-materializer-v1.js';
import { createTripleStore, type TripleStore } from '../src/triple-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const QUERY_ENDPOINT = 'http://127.0.0.1:1/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:1/update';

const noopHandoff: ManagedOxigraphSupervisorHandoffV1 = {
  stopAndProveOwnedChildDead: async () => undefined,
  startAndProveCleanGeneration: async () => undefined,
};

describe('system-record V1 capability discovery', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;

  const managedOptions = (opts: { handoff?: boolean } = {}) =>
    attachManagedOxigraphLeaseV1(
      {
        queryEndpoint: QUERY_ENDPOINT,
        updateEndpoint: UPDATE_ENDPOINT,
        managedByDkg: true,
      },
      ownership.lease,
      opts.handoff === false ? undefined : noopHandoff,
    );

  const build = (
    options: Record<string | symbol, unknown>,
    extra: { graphSetIndex?: boolean; changelog?: boolean } = {},
  ): Promise<TripleStore> =>
    createTripleStore({
      backend: 'sparql-http',
      options: options as Record<string, unknown>,
      graphSetIndex: extra.graphSetIndex ?? false,
      ...(extra.changelog === undefined ? {} : { changelog: extra.changelog }),
    });

  beforeEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT);
    ownership.bindReadyGeneration();
  });

  afterEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
  });

  describe('fail-closed preconditions', () => {
    it('is absent on an ordinary operator-configured endpoint', async () => {
      const store = await build({ queryEndpoint: QUERY_ENDPOINT });
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });

    it('is absent for config booleans alone, however generous', async () => {
      const store = await build({
        queryEndpoint: QUERY_ENDPOINT,
        managedByDkg: true,
        atomicUpdates: true,
      });
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });

    it('is absent with a live lease but NO supervisor handoff', async () => {
      // A lease proves ownership but nothing could prove the retired child dead
      // before a replacement binds, so the lane must not be advertised at all.
      const store = await build(managedOptions({ handoff: false }));
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });

    it('is absent once ownership is terminal', async () => {
      ownership.invalidate('port-release-unproven');
      const store = await build(managedOptions());
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });

    it('is present with a live lease AND a handoff', async () => {
      const store = await build(managedOptions());
      expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
      await store.close().catch(() => undefined);
    });

    it.each([
      ['wrong query path', UPDATE_ENDPOINT, UPDATE_ENDPOINT, undefined],
      ['wrong update path', QUERY_ENDPOINT, QUERY_ENDPOINT, undefined],
      ['different port', QUERY_ENDPOINT, 'http://127.0.0.1:2/update', undefined],
      ['localhost alias', 'http://localhost:1/query', UPDATE_ENDPOINT, undefined],
      ['credentials in URL', 'http://user:pass@127.0.0.1:1/query', UPDATE_ENDPOINT, undefined],
      ['query string', `${QUERY_ENDPOINT}?x=1`, UPDATE_ENDPOINT, undefined],
      ['fragment', `${QUERY_ENDPOINT}#x`, UPDATE_ENDPOINT, undefined],
      ['trailing slash', `${QUERY_ENDPOINT}/`, UPDATE_ENDPOINT, undefined],
      ['authorization option', QUERY_ENDPOINT, UPDATE_ENDPOINT, 'Bearer secret'],
    ])('is absent when adapter identity has %s', async (_label, queryEndpoint, updateEndpoint, auth) => {
      const options = attachManagedOxigraphLeaseV1(
        {
          queryEndpoint,
          updateEndpoint,
          ...(auth === undefined ? {} : { auth }),
        },
        ownership.lease,
        noopHandoff,
      );
      const store = await build(options);
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });
  });

  describe('through the production decorator stack', () => {
    it('survives the factory rewrite that erases managedByDkg', async () => {
      // resolveAdapterOptions() spreads into a NEW object and sets
      // managedByDkg:false / atomicUpdates:true. Capability must ride through
      // on symbol identity, not on either boolean.
      const store = await build(managedOptions(), { graphSetIndex: true });
      expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
      await store.close().catch(() => undefined);
    });

    it('is forwarded through the graph-set index', async () => {
      const store = await build(managedOptions(), { graphSetIndex: true });
      expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
      await store.close().catch(() => undefined);
    });

    it('memoizes so repeated probes return the same controller', async () => {
      const store = await build(managedOptions(), { graphSetIndex: true });
      const first = store.getSystemRecordLaneControllerV1?.();
      const second = store.getSystemRecordLaneControllerV1?.();
      expect(first).toBe(second);
      await store.close().catch(() => undefined);
    });

    for (const graphSetIndex of [true, false]) {
      it(`stops advertising once ownership is lost (graphSetIndex: ${graphSetIndex})`, async () => {
        // Memoization must preserve wrapper IDENTITY, never answer the
        // capability question. Absence was already re-probed, but PRESENCE was
        // latched — so a decorator that had cached a wrapper kept advertising a
        // lane after the lease went terminal, while the adapter underneath would
        // have denied it. Discovery is the safety gate callers use, so a stale
        // "yes" is the dangerous direction of the two.
        //
        // Both compositions, because the two decorators cached differently: the
        // graph-set index wraps the controller, the blob store forwards it.
        const store = await build(managedOptions(), { graphSetIndex });
        expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();

        ownership.invalidate('port-release-unproven');
        expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();

        await store.close().catch(() => undefined);
      });
    }

    it('is forwarded LIVE by the literal blob store', async () => {
      // Constructed directly, because this decorator only joins the composition
      // when large-literal storage is configured — so `createTripleStore` alone
      // never exercises it, and its forwarding had no coverage at all.
      //
      // It used to memoize a present controller, which could only go stale: it
      // wraps nothing, so caching bought no identity stability and could only
      // keep advertising a lane the adapter would now deny.
      const inner = await build(managedOptions());
      const blobStore = new SharedMemoryLiteralBlobStore(inner, {
        blobDir: join(tmpdir(), `dkg-blobstore-probe-${process.pid}`),
        thresholdBytes: 1_000_000,
      });

      expect(blobStore.getSystemRecordLaneControllerV1?.()).toBeDefined();
      ownership.invalidate('port-release-unproven');
      expect(blobStore.getSystemRecordLaneControllerV1?.()).toBeUndefined();

      await inner.close().catch(() => undefined);
    });

    it('is DENIED by an enabled changelog', async () => {
      // Its marker append is a second transaction, so it cannot represent the
      // lane's single-durability-unit contract.
      const store = await build(managedOptions(), { graphSetIndex: true, changelog: true });
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });

    it('is forwarded again when the changelog is explicitly disabled', async () => {
      const store = await build(managedOptions(), { graphSetIndex: true, changelog: false });
      expect(store.getSystemRecordLaneControllerV1?.()).toBeDefined();
      await store.close().catch(() => undefined);
    });
  });

  describe('no structural leak', () => {
    it('does not expose the lane by walking innerStore past a wrapper', async () => {
      const store = await build(managedOptions(), { graphSetIndex: true, changelog: true });
      // The changelog denies. A consumer that unwrapped `.innerStore` would
      // reach the adapter and get a controller anyway, silently bypassing the
      // denial — which is exactly why discovery is explicit per decorator.
      expect(store.getSystemRecordLaneControllerV1?.()).toBeUndefined();
      await store.close().catch(() => undefined);
    });
  });
});
