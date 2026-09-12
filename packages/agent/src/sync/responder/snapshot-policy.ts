import { RESOURCE_MAX, resourceInteger, resourceIntegerEnv } from '../../resource-limits.js';
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
export function assertSyncResponderSnapshotLimitsShape(
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

export type SnapshotPolicyDiagnostic =
  | Readonly<{ kind: 'rejected'; setting: string }>
  | Readonly<{
    kind: 'clamped';
    setting: 'syncResponderSnapshotLimits.local.rows' | 'syncResponderSnapshotLimits.local.bytesEstimate';
    configured: number;
    effective: number;
  }>;

export interface ResolvedSyncResponderSnapshotDiagnostics {
  readonly budget: Readonly<SyncResponderSnapshotBudgetOptions>;
  readonly diagnostics: readonly SnapshotPolicyDiagnostic[];
}

/** Resolve each leaf independently: environment, then config, then the compatibility default. */
export function resolveSyncResponderSnapshotDiagnostics(
  config?: SyncResponderSnapshotLimitsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedSyncResponderSnapshotDiagnostics {
  assertSyncResponderSnapshotLimitsShape(config);
  const diagnostics: SnapshotPolicyDiagnostic[] = [];
  const reject = (setting: string) => diagnostics.push(Object.freeze({ kind: 'rejected' as const, setting }));
  const resolve = (key: keyof typeof SNAPSHOT_BUDGET_ENV, configured: number | undefined,
    fallback: number, path: string, maximum: number) => {
    const bounds = { min: 1, max: maximum } as const;
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
  if (maxSnapshotRows !== configuredMaxSnapshotRows) {
    diagnostics.push(Object.freeze({
      kind: 'clamped', setting: 'syncResponderSnapshotLimits.local.rows',
      configured: configuredMaxSnapshotRows, effective: maxRows,
    }));
  }
  if (maxSnapshotBytesEstimate !== configuredMaxSnapshotBytesEstimate) {
    diagnostics.push(Object.freeze({
      kind: 'clamped', setting: 'syncResponderSnapshotLimits.local.bytesEstimate',
      configured: configuredMaxSnapshotBytesEstimate, effective: maxBytesEstimate,
    }));
  }
  return Object.freeze({
    budget: Object.freeze({ maxRows, maxBytesEstimate, maxSnapshotRows, maxSnapshotBytesEstimate }),
    diagnostics: Object.freeze(diagnostics),
  });
}

/** Strict public validation; runtime resolution separately supports per-leaf fallbacks. */
export function validateSyncResponderSnapshotLimitsConfig(
  config: SyncResponderSnapshotLimitsConfig | undefined,
): void {
  assertSyncResponderSnapshotLimitsShape(config);
  for (const scope of ['global', 'local'] as const) {
    for (const [field, maximum] of [['rows', RESOURCE_MAX.rows], ['bytesEstimate', RESOURCE_MAX.bytes]] as const) {
      resourceInteger(config?.[scope]?.[field], { min: 1, max: maximum },
        `syncResponderSnapshotLimits.${scope}.${field}`, (setting) => {
          throw new TypeError(`Invalid ${setting}: expected a positive safe integer at most ${maximum}`);
        });
    }
  }
}

/** Compatibility result retained by the published sync-handler package subpath. */
export interface ResolvedSyncResponderSnapshotPolicy {
  budget: SyncResponderSnapshotBudgetOptions;
  localRowsClamped: boolean;
  localBytesEstimateClamped: boolean;
}

/** Legacy public resolver: strict config validation, callback diagnostics and clamp flags. */
export function resolveSyncResponderSnapshotPolicy(
  config?: SyncResponderSnapshotLimitsConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onWarning: (message: string) => void = () => {},
): ResolvedSyncResponderSnapshotPolicy {
  validateSyncResponderSnapshotLimitsConfig(config);
  const { budget, diagnostics } = resolveSyncResponderSnapshotDiagnostics(config, env);
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === 'rejected') {
      onWarning(`Ignoring invalid resource setting ${diagnostic.setting}; using fallback`);
    } else {
      const globalSetting = diagnostic.setting.replace('syncResponderSnapshotLimits.local.', 'global.');
      onWarning(`Clamped ${diagnostic.setting} from ${diagnostic.configured} to ${globalSetting} ${diagnostic.effective}`);
    }
  }
  return {
    budget: { ...budget },
    localRowsClamped: diagnostics.some((item) => item.kind === 'clamped'
      && item.setting === 'syncResponderSnapshotLimits.local.rows'),
    localBytesEstimateClamped: diagnostics.some((item) => item.kind === 'clamped'
      && item.setting === 'syncResponderSnapshotLimits.local.bytesEstimate'),
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
