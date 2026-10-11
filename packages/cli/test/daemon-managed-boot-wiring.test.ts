import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  SyncSemanticStoreV1, SyncSharedProjectionStoreV1, asChangelogReader,
  createManagedOxigraphRuntimeStoreConfigV1,
} from '@origintrail-official/dkg-storage';
import { daemonWiringMocks as mocks, installDaemonLifecycleWiringFixture } from './helpers/daemon-lifecycle-wiring.js';

const { DKGAgent: RealDKGAgent } = await vi.importActual<
  typeof import('@origintrail-official/dkg-agent')
>('@origintrail-official/dkg-agent');

describe('runDaemonInner managed store boot/runtime wiring', () => {
  const fixture = installDaemonLifecycleWiringFixture();
  const { captureCreateArg } = fixture;

  it.each([false, true])(
    'fences direct managed-store boot work and preserves RFC-64 authority when changelog=%s',
    async (changelog) => {
      let bootActivity = false;
      const reportBootActivity = vi.fn((busy: boolean) => { bootActivity = busy; });
      const disposeBootActivity = vi.fn(() => { bootActivity = false; });
      const observeBootActivity = () => {
        expect(bootActivity).toBe(true);
      };
      mocks.checkExternalStoreReachable.mockImplementationOnce(async () => {
        observeBootActivity();
        return {
          ok: true,
          backend: 'sparql-http',
          endpoint: 'http://127.0.0.1:7878/query',
        };
      });
      mocks.checkOrSetStoreIdentity.mockImplementationOnce(async () => {
        observeBootActivity();
        return {
          ok: true,
          action: 'matched',
          nodeName: 'storage-ack-timing-core-test',
        };
      });
      mocks.chainResetWipe.mockImplementationOnce(async () => {
        observeBootActivity();
        return {
          status: 'inactive',
          attempted: false,
          requiresStoreRetag: false,
          prevMarker: null,
          removedFiles: [],
          backedUpFiles: [],
          failedFiles: [],
        };
      });
      const managedStore = createManagedOxigraphRuntimeStoreConfigV1({
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:7878/query',
          updateEndpoint: 'http://127.0.0.1:7878/update',
          managedByDkg: true,
        },
        graphSetIndex: true,
      });
      mocks.startManagedOxigraph.mockResolvedValue({
        handle: {
          queryEndpoint: 'http://127.0.0.1:7878/query',
          updateEndpoint: 'http://127.0.0.1:7878/update',
          getRecoveryState: () => ({ recovering: false }),
          registerStoreActivity: () => ({
            report: reportBootActivity,
            dispose: disposeBootActivity,
          }),
          killSync: vi.fn(),
        },
        storeConfig: managedStore,
        largeLiteralStorage: {
          enabled: true,
          directory: join(fixture.tempHome!, 'literal-blobs'),
        },
      });

      await captureCreateArg({
        store: {
          backend: 'oxigraph-server',
          options: {},
          changelog,
        },
      }, async (createArg) => {
        expect(bootActivity).toBe(false);
        expect(reportBootActivity).toHaveBeenCalledExactlyOnceWith(true);
        expect(disposeBootActivity).toHaveBeenCalledOnce();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (_input, init) => {
          const body = String(init?.body ?? '');
          if (/\bSELECT\b/iu.test(body)) {
            return new Response(JSON.stringify({
              head: { vars: ['network'] },
              results: { bindings: [] },
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/sparql-results+json' },
            });
          }
          return new Response(null, { status: 204 });
        }) as typeof fetch;
        let agent: Awaited<ReturnType<typeof RealDKGAgent.create>> | undefined;
        try {
          agent = await RealDKGAgent.create(createArg);
          const store = agent.store;
          expect(() => new SyncSharedProjectionStoreV1(store)).not.toThrow();
          expect(() => new SyncSemanticStoreV1(store)).not.toThrow();
          expect(asChangelogReader(agent.store) !== null).toBe(changelog);
        } finally {
          await agent?.stop().catch(() => {});
          globalThis.fetch = originalFetch;
        }
      });
    },
  );

});
