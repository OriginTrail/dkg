import { describe, expect, it, vi } from 'vitest';
import {
  STORAGE_ADAPTERS,
  classifyTripleStoreBackend,
  customTripleStoreBackend,
  isExternalBackend,
  isStorageAdapterBackend,
  storageAdapterNames,
} from '@origintrail-official/dkg-storage';
import { validateStoreConfig, type DkgConfig } from '../src/config.js';
import {
  DEFAULT_DAEMON_STORE_BACKEND,
  MANAGED_DAEMON_STORE_BACKEND,
  STORE_BACKENDS,
  configBackendNames,
  isManagedLocalBackend,
  isRetiredStoreBackend,
  requireStorageAdapterBackend,
  storeFlagBackendNames,
  storeBackendNames,
  wizardBackendChoices,
  type StoreBackend,
} from '../src/store-backends.js';
import { checkExternalStoreReachable } from '../src/daemon/store-health-check.js';
import { planManagedOxigraph } from '../src/daemon/oxigraph-managed.js';
import { storeBackendHasStatusHealth } from '../src/daemon/routes/status.js';

function configForBackend(backend: StoreBackend): DkgConfig {
  const policy = STORE_BACKENDS[backend];
  const options = policy.kind === 'external'
    ? { [policy.queryEndpointOption]: 'http://store.test/query' }
    : {};
  return {
    name: 'taxonomy-test',
    apiPort: 9200,
    listenPort: 4001,
    nodeRole: 'edge',
    store: { backend, options },
  } as DkgConfig;
}

describe('canonical store backend taxonomy', () => {
  it('drives config validation and wizard discovery for every registered backend', () => {
    const configBackends = configBackendNames();
    const wizardBackends = wizardBackendChoices();
    const flagBackends = storeFlagBackendNames();

    for (const backend of storeBackendNames()) {
      const policy = STORE_BACKENDS[backend];
      const errors = validateStoreConfig(configForBackend(backend));

      expect((configBackends as readonly StoreBackend[]).includes(backend), backend).toBe(!policy.retired);
      expect((wizardBackends as readonly StoreBackend[]).includes(backend), backend).toBe(!policy.retired && policy.wizard);
      expect((flagBackends as readonly StoreBackend[]).includes(backend), backend).toBe(!policy.retired && policy.storeFlag);
      expect(errors.some((error) => error.field === 'store.backend'), backend).toBe(policy.retired);
      if (!policy.retired) expect(errors, backend).toEqual([]);
      if (policy.wizard) expect('label' in policy && policy.label.length > 0, backend).toBe(true);
    }
  });

  it('keeps daemon health, managed startup, and status routing aligned for every backend', async () => {
    for (const backend of storeBackendNames()) {
      const policy = STORE_BACKENDS[backend];
      const external = policy.kind === 'external';
      const managed = policy.kind === 'managed-local';

      expect(isExternalBackend(backend), backend).toBe(external);
      expect(isManagedLocalBackend(backend), backend).toBe(managed);
      expect(isRetiredStoreBackend(backend), backend).toBe(policy.retired);
      expect(isStorageAdapterBackend(backend), backend).toBe(policy.adapter);
      expect(classifyTripleStoreBackend(backend).kind, backend).toBe(
        policy.adapter ? 'adapter' : 'custom',
      );
      expect(storeBackendHasStatusHealth(backend), backend).toBe(external || managed);
      expect(planManagedOxigraph(configForBackend(backend), '/data') !== null, backend).toBe(managed);

      const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
      const health = await checkExternalStoreReachable({
        storeConfig: configForBackend(backend).store,
        fetch,
      });
      expect(health.ok, backend).toBe(true);
      expect(fetch.mock.calls.length > 0, backend).toBe(external);
    }
  });

  it('derives the daemon default and managed-local constant from the registry', () => {
    expect(DEFAULT_DAEMON_STORE_BACKEND).toBe(MANAGED_DAEMON_STORE_BACKEND);
    expect(STORE_BACKENDS[DEFAULT_DAEMON_STORE_BACKEND]).toMatchObject({
      default: true,
      kind: 'managed-local',
      retired: false,
    });
  });

  it('composes daemon policy over the storage-owned adapter registry', () => {
    expect(storageAdapterNames()).toEqual([
      'oxigraph',
      'oxigraph-persistent',
      'blazegraph',
      'sparql-http',
    ]);
    expect(storageAdapterNames()).not.toContain('oxigraph-server');
    expect(storageAdapterNames()).not.toContain('oxigraph-worker');
    for (const backend of storageAdapterNames()) {
      expect(STORE_BACKENDS[backend]).toMatchObject(STORAGE_ADAPTERS[backend]);
      expect(requireStorageAdapterBackend(backend)).toBe(backend);
    }
    expect(() => requireStorageAdapterBackend('oxigraph-server')).toThrow(
      /not a constructible storage adapter/,
    );
  });

  it('requires an explicit custom-backend escape hatch outside the known registry', () => {
    const backend = customTripleStoreBackend('vendor-plugin-store');
    expect(classifyTripleStoreBackend(backend)).toEqual({
      kind: 'custom',
      backend: 'vendor-plugin-store',
    });
    expect(() => customTripleStoreBackend('oxigraph')).toThrow(/known triple-store adapter/i);
  });
});
