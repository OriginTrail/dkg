import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STORE_BACKEND,
  MANAGED_LOCAL_STORE_BACKEND,
  STORE_BACKENDS,
  isExternalBackend,
  isManagedLocalBackend,
  isRetiredStoreBackend,
  storeBackendNames,
  type StoreBackend,
} from '@origintrail-official/dkg-storage';
import { validateStoreConfig, type DkgConfig } from '../src/config.js';
import {
  menuBackendChoices,
  supportedBackendNames,
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
    const supported = supportedBackendNames();
    const menu = menuBackendChoices();

    for (const backend of storeBackendNames()) {
      const policy = STORE_BACKENDS[backend];
      const errors = validateStoreConfig(configForBackend(backend));

      expect((supported as readonly StoreBackend[]).includes(backend), backend).toBe(!policy.retired);
      expect((menu as readonly StoreBackend[]).includes(backend), backend).toBe(!policy.retired && policy.menu);
      expect(errors.some((error) => error.field === 'store.backend'), backend).toBe(policy.retired);
      if (!policy.retired) expect(errors, backend).toEqual([]);
      if (policy.menu) expect('label' in policy && policy.label.length > 0, backend).toBe(true);
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
    expect(DEFAULT_STORE_BACKEND).toBe(MANAGED_LOCAL_STORE_BACKEND);
    expect(STORE_BACKENDS[DEFAULT_STORE_BACKEND]).toMatchObject({
      default: true,
      kind: 'managed-local',
      retired: false,
    });
  });
});
