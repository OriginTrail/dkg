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

export interface SyncContextGraphPriorityConfig {
  [contextGraphId: string]: number;
}

export type SyncPriorityClass = 'elevated' | 'default' | 'deprioritized';

export type SyncSchedulerLane =
  | 'durable'
  | 'changelog'
  | 'shared_memory'
  | 'swm_recovery'
  | 'pre_authorization'
  | 'responder';

const SNAPSHOT_LIMIT_PATHS = [
  ['global', 'rows'],
  ['global', 'bytesEstimate'],
  ['local', 'rows'],
  ['local', 'bytesEstimate'],
] as const;

export function validateSyncResponderSnapshotLimitsConfig(
  config: SyncResponderSnapshotLimitsConfig | undefined,
): void {
  if (config === undefined) return;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Invalid syncResponderSnapshotLimits: expected an object');
  }
  for (const [scope, leaf] of SNAPSHOT_LIMIT_PATHS) {
    const nested = config[scope];
    if (nested === undefined) continue;
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new TypeError(`Invalid syncResponderSnapshotLimits.${scope}: expected an object`);
    }
    const value = nested[leaf];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(
        `Invalid syncResponderSnapshotLimits.${scope}.${leaf}: expected a positive safe integer`,
      );
    }
  }
}

export function normalizeSyncContextGraphPriorities(
  config: SyncContextGraphPriorityConfig | undefined,
): Readonly<SyncContextGraphPriorityConfig> {
  if (config === undefined) return Object.freeze({});
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Invalid syncContextGraphPriorities: expected an object');
  }
  const normalized: SyncContextGraphPriorityConfig = {};
  for (const [contextGraphId, value] of Object.entries(config)) {
    if (contextGraphId.trim().length === 0) {
      throw new TypeError('Invalid syncContextGraphPriorities: Context Graph IDs must be non-empty');
    }
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `Invalid syncContextGraphPriorities.${contextGraphId}: expected a safe integer`,
      );
    }
    normalized[contextGraphId] = value;
  }
  return Object.freeze(normalized);
}

export function contextGraphPriority(
  priorities: Readonly<SyncContextGraphPriorityConfig> | undefined,
  contextGraphId: string,
): number {
  return priorities?.[contextGraphId] ?? 0;
}

export function syncPriorityClass(priority: number): SyncPriorityClass {
  if (priority > 0) return 'elevated';
  if (priority < 0) return 'deprioritized';
  return 'default';
}

/** Deduplicate and stably order by descending local priority. */
export function orderContextGraphIdsByPriority(
  contextGraphIds: readonly string[],
  priorities: Readonly<SyncContextGraphPriorityConfig> | undefined,
): string[] {
  const seen = new Set<string>();
  return contextGraphIds
    .map((contextGraphId, index) => ({ contextGraphId, index }))
    .filter(({ contextGraphId }) => {
      if (seen.has(contextGraphId)) return false;
      seen.add(contextGraphId);
      return true;
    })
    .sort((a, b) => (
      contextGraphPriority(priorities, b.contextGraphId)
      - contextGraphPriority(priorities, a.contextGraphId)
      || a.index - b.index
    ))
    .map(({ contextGraphId }) => contextGraphId);
}

export function countSyncPriorityClasses(
  priorities: Readonly<SyncContextGraphPriorityConfig> | undefined,
): Record<SyncPriorityClass, number> {
  const counts: Record<SyncPriorityClass, number> = {
    elevated: 0,
    default: 0,
    deprioritized: 0,
  };
  for (const priority of Object.values(priorities ?? {})) {
    counts[syncPriorityClass(priority)] += 1;
  }
  return counts;
}
