import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DAEMON_STORE_BACKEND,
  isManagedLocalBackend,
  isRetiredStoreBackend,
  requireStorageAdapterBackend,
  type StorageAdapterBackend,
} from '../store-backends.js';
import type { DkgConfig } from '../config.js';
import { readPersistedStoreBackend } from './daemon-state.js';
import type { ManagedOxigraphResult } from './oxigraph-managed.js';

type StoreConfig = NonNullable<DkgConfig['store']>;
export type RuntimeStoreConfig = Omit<StoreConfig, 'backend'> & {
  backend: StorageAdapterBackend;
};

interface DaemonStoreOperatorContext {
  /** Operator-facing config exactly as loaded from disk / CLI. */
  operatorConfig: DkgConfig;
}

export interface InvalidDaemonStoreConfig extends DaemonStoreOperatorContext {
  kind: 'invalid-config';
}

export interface BlockedLegacyStoreCutover extends DaemonStoreOperatorContext {
  kind: 'blocked-legacy-cutover';
  message: string;
}

export interface DaemonStoreBootPlan extends DaemonStoreOperatorContext {
  kind: 'bootable';
  /** Config with the implicit daemon default materialized for boot steps. */
  effectiveConfig: DkgConfig;
  /** Store backend used for backend-switch detection and managed startup. */
  effectiveStore: StoreConfig;
  /** Non-fatal startup notice, e.g. acknowledged legacy default cutover. */
  notice?: string;
}

export type DaemonStoreBootDecision =
  | InvalidDaemonStoreConfig
  | BlockedLegacyStoreCutover
  | DaemonStoreBootPlan;

export interface DaemonStoreRuntimePlan extends DaemonStoreBootPlan {
  /** Store config consumed by validation, health probes, wipe, and the agent. */
  runtimeStore: RuntimeStoreConfig;
  /** Config view with runtime store/blob/snapshot values swapped in. */
  runtimeConfig: DkgConfig;
  runtimeLargeLiteralStorage: DkgConfig['largeLiteralStorage'];
  runtimeSnapshotStorage: DkgConfig['sharedMemoryPublicSnapshotStorage'];
}

/** Explicit store views threaded into request routing after startup. */
export interface StoreRuntimeContext {
  /** Persisted/operator intent. Routes that save config must use this view. */
  operatorConfig: DkgConfig;
  /** Daemon-facing backend after defaults and acknowledged migrations. */
  effectiveStore: StoreConfig;
  /** Constructible live adapter config after managed-store materialization. */
  runtimeStore: RuntimeStoreConfig;
}

export function resolveEffectiveDaemonStore(config: Pick<DkgConfig, 'store'>): StoreConfig {
  return config.store ?? { backend: DEFAULT_DAEMON_STORE_BACKEND, options: {} };
}

export function resolveDaemonStoreBootPlan(opts: {
  config: DkgConfig;
  dataDir: string;
  acceptStoreReset: boolean;
}): DaemonStoreBootDecision {
  const { config, dataDir, acceptStoreReset } = opts;
  const legacyStorePath = join(dataDir, 'store.nq');
  const legacyStoreExists = existsSync(legacyStorePath);
  const retiredStoreConfigured = isRetiredStoreBackend(config.store?.backend);
  const configuredForManagedServer = !config.store || isManagedLocalBackend(config.store.backend);
  const previousBackend = readPersistedStoreBackend(dataDir);
  const legacyCutoverAlreadyRecorded = isManagedLocalBackend(previousBackend);
  const legacyCutoverRequired = legacyStoreExists
    && (configuredForManagedServer || retiredStoreConfigured)
    && !legacyCutoverAlreadyRecorded;
  const migrateAcknowledgedRetiredStore = retiredStoreConfigured
    && legacyCutoverRequired
    && acceptStoreReset;
  const effectiveStore = migrateAcknowledgedRetiredStore
    ? resolveEffectiveDaemonStore({})
    : resolveEffectiveDaemonStore(config);
  const effectiveConfig = config.store && !migrateAcknowledgedRetiredStore
    ? config
    : { ...config, store: effectiveStore };

  // A retired worker config with no legacy data has no migration decision to
  // make. Keep that state separate so callers cannot accidentally continue to
  // managed startup with an invalid operator config.
  if (retiredStoreConfigured && !legacyCutoverRequired) {
    return { kind: 'invalid-config', operatorConfig: config };
  }

  if (legacyCutoverRequired && !acceptStoreReset) {
    const legacySource = retiredStoreConfigured
      ? `${config.store?.backend} backend`
      : config.store
        ? 'worker-backed store'
        : 'implicit worker default';
    return {
      kind: 'blocked-legacy-cutover',
      operatorConfig: config,
      message:
        `[STORE] oxigraph-worker support has been removed, but this node has a legacy ` +
        `store.nq from the old ${legacySource}.\n` +
        `Set store.backend to "oxigraph-server" (or an external SPARQL backend) and ` +
        `restart with DKG_ACCEPT_STORE_RESET=1 to acknowledge the fresh-store cutover. ` +
        `The legacy store.nq file is left untouched for manual backup or migration.`,
    };
  }

  let notice: string | undefined;
  if (legacyCutoverRequired && acceptStoreReset) {
    notice = retiredStoreConfigured
      ? `[STORE] explicit ${config.store?.backend} is retired; using oxigraph-server after reset acknowledgement. Legacy store.nq is left untouched.`
      : '[STORE] using oxigraph-server after reset acknowledgement. Legacy store.nq is left untouched.';
  } else if (!config.store && acceptStoreReset) {
    notice =
      '[STORE] no store block found; using oxigraph-server. Legacy store.nq, if present, is left untouched.';
  }

  return {
    kind: 'bootable',
    operatorConfig: config,
    effectiveConfig,
    effectiveStore,
    ...(notice ? { notice } : {}),
  };
}

export function resolveDaemonStoreRuntime(
  bootPlan: DaemonStoreBootPlan,
  managed: ManagedOxigraphResult | null,
): DaemonStoreRuntimePlan {
  if (isManagedLocalBackend(bootPlan.effectiveStore.backend) && !managed) {
    throw new Error(
      `Managed daemon store "${bootPlan.effectiveStore.backend}" was not materialized to a storage adapter`,
    );
  }
  const candidateStore = managed?.storeConfig ?? bootPlan.effectiveStore;
  const runtimeStore: RuntimeStoreConfig = {
    ...candidateStore,
    backend: requireStorageAdapterBackend(candidateStore.backend),
  };
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
