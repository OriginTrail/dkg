import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DkgConfig } from '../config.js';
import type { ManagedOxigraphResult } from './oxigraph-managed.js';

type StoreConfig = NonNullable<DkgConfig['store']>;

export interface DaemonStoreBootPlan {
  /** Operator-facing config exactly as loaded from disk / CLI. */
  operatorConfig: DkgConfig;
  /** Config with the implicit daemon default materialized for boot steps. */
  effectiveConfig: DkgConfig;
  /** Store backend used for backend-switch detection and managed startup. */
  effectiveStore: StoreConfig;
  /** True when explicit validation should run before migration gates. */
  validateOperatorConfigFirst: boolean;
  /** Fatal startup message; caller logs and exits before touching runtime store. */
  abortMessage?: string;
  /** Non-fatal startup notice, e.g. acknowledged legacy default cutover. */
  notice?: string;
}

export interface DaemonStoreRuntimePlan extends DaemonStoreBootPlan {
  /** Store config consumed by validation, health probes, wipe, and the agent. */
  runtimeStore: StoreConfig;
  /** Config view with runtime store/blob/snapshot values swapped in. */
  runtimeConfig: DkgConfig;
  runtimeLargeLiteralStorage: DkgConfig['largeLiteralStorage'];
  runtimeSnapshotStorage: DkgConfig['sharedMemoryPublicSnapshotStorage'];
}

function defaultDaemonStore(): StoreConfig {
  return { backend: 'oxigraph-server', options: {} };
}

export function resolveDaemonStoreBootPlan(opts: {
  config: DkgConfig;
  dataDir: string;
  acceptStoreReset: boolean;
}): DaemonStoreBootPlan {
  const { config, dataDir, acceptStoreReset } = opts;
  const effectiveStore = config.store ?? defaultDaemonStore();
  const effectiveConfig = config.store ? config : { ...config, store: effectiveStore };
  const legacyStorePath = join(dataDir, 'store.nq');

  const plan: DaemonStoreBootPlan = {
    operatorConfig: config,
    effectiveConfig,
    effectiveStore,
    validateOperatorConfigFirst: config.store?.backend === 'oxigraph-worker',
  };

  if (!config.store && existsSync(legacyStorePath) && !acceptStoreReset) {
    plan.abortMessage =
      `[STORE] oxigraph-worker support has been removed, but this node has a legacy ` +
      `store.nq from the old implicit worker default.\n` +
      `Set store.backend to "oxigraph-server" (or an external SPARQL backend) and ` +
      `restart with DKG_ACCEPT_STORE_RESET=1 to acknowledge the fresh-store cutover. ` +
      `The legacy store.nq file is left untouched for manual backup or migration.`;
  } else if (!config.store && acceptStoreReset) {
    plan.notice =
      '[STORE] no store block found; using oxigraph-server. Legacy store.nq, if present, is left untouched.';
  }

  return plan;
}

export function resolveDaemonStoreRuntime(
  bootPlan: DaemonStoreBootPlan,
  managed: ManagedOxigraphResult | null,
): DaemonStoreRuntimePlan {
  const runtimeStore = managed?.storeConfig ?? bootPlan.effectiveStore;
  const runtimeLargeLiteralStorage =
    managed?.largeLiteralStorage ?? bootPlan.operatorConfig.largeLiteralStorage;
  const runtimeSnapshotStorage =
    managed?.sharedMemoryPublicSnapshotStorage ?? bootPlan.operatorConfig.sharedMemoryPublicSnapshotStorage;
  const runtimeConfig: DkgConfig = managed
    ? {
        ...bootPlan.effectiveConfig,
        store: runtimeStore,
        largeLiteralStorage: runtimeLargeLiteralStorage,
        sharedMemoryPublicSnapshotStorage: runtimeSnapshotStorage,
      }
    : bootPlan.effectiveConfig;

  return {
    ...bootPlan,
    runtimeStore,
    runtimeConfig,
    runtimeLargeLiteralStorage,
    runtimeSnapshotStorage,
  };
}
