import { RESOURCE_MAX, resourceInteger, resourceIntegerEnv, type RejectedResourceSetting } from '../../resource-limits.js';
import type { SyncResponderSnapshotBudgetOptions } from './snapshot-budget.js';

export interface SyncResponderSnapshotLimitsConfig {
  global?: {
    rows?: number;
    bytesEstimate?: number;
  };
  /** Per retained responder snapshot (peer/session/phase/Context Graph). */
  local?: {
    rows?: number;
    bytesEstimate?: number;
  };
}

/** Validate container shape; numeric leaves resolve through the bounded snapshot policy. */
export function validateSyncResponderSnapshotLimitsConfig(
  config: SyncResponderSnapshotLimitsConfig | undefined,
): void {
  if (config === undefined) return;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Invalid syncResponderSnapshotLimits: expected an object');
  }
  for (const scope of ['global', 'local'] as const) {
    const nested = config[scope];
    if (nested === undefined) continue;
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new TypeError(`Invalid syncResponderSnapshotLimits.${scope}: expected an object`);
    }
    // Numeric leaves resolve independently through the bounded policy parser.
    // This boundary still rejects malformed object/container shapes.
  }
}

export const SYNC_RESPONDER_GLOBAL_CONCURRENCY = 3;
export const SYNC_RESPONDER_DURABLE_DATA_SNAPSHOT_LIMIT = 128;
export const SYNC_RESPONDER_DURABLE_META_SNAPSHOT_LIMIT = 64;
export const SYNC_RESPONDER_SHARED_MEMORY_SNAPSHOT_LIMIT = 64;
export const SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT = 250_000;
export const SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT = 128 * 1024 * 1024;
// Keep enough retained capacity for every admitted responder computation. The
// budget pins active page sessions, so this avoids cross-peer eviction/thrash
// while preserving a finite process-wide ceiling.
export const SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT =
  SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT * SYNC_RESPONDER_GLOBAL_CONCURRENCY;
export const SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT =
  SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT * SYNC_RESPONDER_GLOBAL_CONCURRENCY;

const SNAPSHOT_BUDGET_ENV = {
  maxRows: 'DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT',
  maxBytesEstimate: 'DKG_SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT',
  maxSnapshotRows: 'DKG_SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT',
  maxSnapshotBytesEstimate: 'DKG_SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT',
} as const;

export interface ResolvedSyncResponderSnapshotPolicy {
  budget: SyncResponderSnapshotBudgetOptions;
  localRowsClamped: boolean;
  localBytesEstimateClamped: boolean;
}

/** Resolve each leaf independently: environment, then config, then the compatibility default. */
export function resolveSyncResponderSnapshotPolicy(
  config?: SyncResponderSnapshotLimitsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onWarning: (message: string) => void = () => {},
  onRejected?: RejectedResourceSetting,
): ResolvedSyncResponderSnapshotPolicy {
  validateSyncResponderSnapshotLimitsConfig(config);
  const warnings = new Set<string>();
  const warnOnce = (message: string) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    onWarning(message);
  };
  const resolve = (key: keyof typeof SNAPSHOT_BUDGET_ENV, configured: number | undefined,
    fallback: number, path: string, maximum: number) => {
    const bounds = { min: 1, max: maximum } as const;
    const reject = onRejected ?? ((name: string) => warnOnce(`Ignoring invalid resource setting ${name}; using fallback`));
    return resourceIntegerEnv(env[SNAPSHOT_BUDGET_ENV[key]], bounds, SNAPSHOT_BUDGET_ENV[key], reject)
      ?? resourceInteger(configured, bounds, path, reject) ?? fallback;
  };
  const maxRows = resolve('maxRows', config?.global?.rows, SYNC_RESPONDER_GLOBAL_SNAPSHOT_ROW_LIMIT,
    'syncResponderSnapshotLimits.global.rows', RESOURCE_MAX.rows);
  const maxBytesEstimate = resolve('maxBytesEstimate', config?.global?.bytesEstimate,
    SYNC_RESPONDER_GLOBAL_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
    'syncResponderSnapshotLimits.global.bytesEstimate', RESOURCE_MAX.bytes);
  const configuredMaxSnapshotRows = resolve('maxSnapshotRows', config?.local?.rows,
    SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT, 'syncResponderSnapshotLimits.local.rows', RESOURCE_MAX.rows);
  const configuredMaxSnapshotBytesEstimate = resolve('maxSnapshotBytesEstimate', config?.local?.bytesEstimate,
    SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT,
    'syncResponderSnapshotLimits.local.bytesEstimate', RESOURCE_MAX.bytes);
  const maxSnapshotRows = Math.min(configuredMaxSnapshotRows, maxRows);
  const maxSnapshotBytesEstimate = Math.min(configuredMaxSnapshotBytesEstimate, maxBytesEstimate);
  const localRowsClamped = maxSnapshotRows !== configuredMaxSnapshotRows;
  const localBytesEstimateClamped = maxSnapshotBytesEstimate !== configuredMaxSnapshotBytesEstimate;
  if (localRowsClamped) {
    warnOnce(
      `Clamped syncResponderSnapshotLimits.local.rows from ${configuredMaxSnapshotRows} to global.rows ${maxRows}`,
    );
  }
  if (localBytesEstimateClamped) {
    warnOnce(
      `Clamped syncResponderSnapshotLimits.local.bytesEstimate from ${configuredMaxSnapshotBytesEstimate} to global.bytesEstimate ${maxBytesEstimate}`,
    );
  }
  return {
    budget: {
      maxRows,
      maxBytesEstimate,
      maxSnapshotRows,
      maxSnapshotBytesEstimate,
    },
    localRowsClamped,
    localBytesEstimateClamped,
  };
}

/** Production snapshot limits, with explicit config and environment overrides in rows/bytes. */
export function resolveSyncResponderSnapshotBudgetOptions(
  config?: SyncResponderSnapshotLimitsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onWarning?: (message: string) => void,
): SyncResponderSnapshotBudgetOptions {
  return resolveSyncResponderSnapshotPolicy(config, env, onWarning).budget;
}

