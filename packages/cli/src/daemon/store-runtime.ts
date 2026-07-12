import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DkgConfig } from '../config.js';
import { readPersistedStoreBackend } from './chain-reset-wipe.js';
import type { ManagedOxigraphResult } from './oxigraph-managed.js';

type StoreConfig = NonNullable<DkgConfig['store']>;

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
  runtimeStore: StoreConfig;
  /** Config view with runtime store/blob/snapshot values swapped in. */
  runtimeConfig: DkgConfig;
  runtimeLargeLiteralStorage: DkgConfig['largeLiteralStorage'];
  runtimeSnapshotStorage: DkgConfig['sharedMemoryPublicSnapshotStorage'];
}

export function resolveEffectiveDaemonStore(config: Pick<DkgConfig, 'store'>): StoreConfig {
  return config.store ?? { backend: 'oxigraph-server', options: {} };
}

export function resolveDaemonStoreBootPlan(opts: {
  config: DkgConfig;
  dataDir: string;
  acceptStoreReset: boolean;
}): DaemonStoreBootDecision {
  const { config, dataDir, acceptStoreReset } = opts;
  const legacyStorePath = join(dataDir, 'store.nq');
  const legacyStoreExists = existsSync(legacyStorePath);
  const legacyWorkerConfigured = config.store?.backend === 'oxigraph-worker';
  const configuredForManagedServer = !config.store || config.store.backend === 'oxigraph-server';
  const previousBackend = readPersistedStoreBackend(dataDir);
  const legacyCutoverAlreadyRecorded = previousBackend === 'oxigraph-server';
  const legacyCutoverRequired = legacyStoreExists
    && (configuredForManagedServer || legacyWorkerConfigured)
    && !legacyCutoverAlreadyRecorded;
  const migrateAcknowledgedWorker = legacyWorkerConfigured
    && legacyCutoverRequired
    && acceptStoreReset;
  const effectiveStore = migrateAcknowledgedWorker
    ? resolveEffectiveDaemonStore({})
    : resolveEffectiveDaemonStore(config);
  const effectiveConfig = config.store && !migrateAcknowledgedWorker
    ? config
    : { ...config, store: effectiveStore };

  // A retired worker config with no legacy data has no migration decision to
  // make. Keep that state separate so callers cannot accidentally continue to
  // managed startup with an invalid operator config.
  if (legacyWorkerConfigured && !legacyCutoverRequired) {
    return { kind: 'invalid-config', operatorConfig: config };
  }

  if (legacyCutoverRequired && !acceptStoreReset) {
    const legacySource = legacyWorkerConfigured
      ? 'worker backend'
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
    notice = legacyWorkerConfigured
      ? '[STORE] explicit oxigraph-worker is retired; using oxigraph-server after reset acknowledgement. Legacy store.nq is left untouched.'
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
