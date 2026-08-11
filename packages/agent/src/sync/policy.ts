import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';

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
  | 'responder'
  | 'fast'
  | 'slow';

/**
 * Optional node-wide sync admission partitions. Omitting this block preserves
 * the legacy shared limiter (`syncGlobalMaxInflight` / `syncGlobalQueueLimit`).
 *
 * A partitioned scheduler protects short changelog/control-plane work from
 * snapshot transfers, and reserves part of the slow partition for explicit
 * foreground recovery. Automatic work is non-queueing by default: the
 * on-connect/reconcile drivers already retry it, so retaining duplicate bulk
 * jobs here can convert transient pressure into a permanent backlog.
 */
export interface SyncAdmissionConfig {
  mode?: 'shared' | 'partitioned';
  globalMaxInflight?: number;
  fast?: {
    maxInflight?: number;
    queueLimit?: number;
    queueTimeoutMs?: number;
  };
  slow?: {
    maxInflight?: number;
    foregroundReserved?: number;
    foregroundQueueLimit?: number;
    backgroundMaxInflight?: number;
    backgroundQueueLimit?: number;
  };
}

/**
 * Which trigger enqueued a `sync-global` admission.
 *
 * The lane says WHAT kind of work is queued; every trigger funnels into the same
 * few lanes, so lane alone cannot tell an operator whether a saturated queue is
 * an explicit user-driven catch-up, routine sync-on-connect, or a background
 * reconcile. Issue #2006 had to reconstruct that from daemon logs.
 *
 * The set is deliberately closed and small: these values become metric and log
 * dimensions, so cardinality is a contract, not an implementation detail.
 *
 * The rule is TRIGGER attribution, with a base case: a sync operation is
 * attributed to whatever triggered it, and work with no triggering sync
 * operation is triggered by the control plane. `control-plane` is that base
 * case — node-internal metadata work (curator meta refresh, on both the
 * requester and responder sides) that no sync trigger is responsible for.
 * It exists so `unspecified` can keep meaning "we do not know", which is what
 * makes an unclassified sample able to invalidate an observation window.
 */
export const SYNC_ADMISSION_SOURCES = [
  'catchup-foreground',
  'catchup-background',
  'on-connect',
  'reconcile',
  'vm-recovery',
  'swm-recovery',
  'control-plane',
  'unspecified',
] as const;

export type SyncAdmissionSource = typeof SYNC_ADMISSION_SOURCES[number];

const SYNC_ADMISSION_SOURCE_SET: ReadonlySet<string> = new Set(SYNC_ADMISSION_SOURCES);

/**
 * Clamp an admission origin to the closed set before it becomes a diagnostic
 * label. The union is compile-time only; a value crossing a worker/RPC boundary
 * or arriving through a cast must never be able to widen the label space or
 * smuggle a Context Graph / peer identifier into node-wide diagnostics.
 */
export function normalizeSyncAdmissionSource(
  source: string | undefined,
): SyncAdmissionSource {
  return source !== undefined && SYNC_ADMISSION_SOURCE_SET.has(source)
    ? source as SyncAdmissionSource
    : 'unspecified';
}

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

/**
 * System Context Graphs are broadcast directories: every peer replicates them,
 * they grow with the network (tens of thousands of triples), and any connected
 * peer can serve them. A user Context Graph has none of those properties — its
 * one reachable curator may be the only source in a fanout that stops on the
 * first failure, so a system graph failing mid-transfer ahead of user work
 * starves every user graph behind it on every cycle. Running system graphs
 * LAST bounds that blast radius to the graphs that can afford it. Operators
 * override by naming the graph in `syncContextGraphPriorities`; an explicit 0
 * restores ordinary scheduling.
 */
export const DEFAULT_SYSTEM_CONTEXT_GRAPH_PRIORITY = -100;

const SYSTEM_CONTEXT_GRAPH_IDS: ReadonlySet<string> = new Set(
  Object.values(SYSTEM_CONTEXT_GRAPHS),
);

/**
 * Normalize the operator config and fill in the system-graph defaults. Applied
 * where the config is normalized (agent construction) so every consumer —
 * fanout ordering, admission scheduling, responder scheduling, and the
 * "Resolved sync policy" boot log's class counts — acts on and reports the
 * same effective map.
 */
export function resolveSyncContextGraphPriorities(
  config: SyncContextGraphPriorityConfig | undefined,
): Readonly<SyncContextGraphPriorityConfig> {
  const resolved: SyncContextGraphPriorityConfig = {
    ...normalizeSyncContextGraphPriorities(config),
  };
  for (const contextGraphId of SYSTEM_CONTEXT_GRAPH_IDS) {
    resolved[contextGraphId] ??= DEFAULT_SYSTEM_CONTEXT_GRAPH_PRIORITY;
  }
  return Object.freeze(resolved);
}

export function contextGraphPriority(
  priorities: Readonly<SyncContextGraphPriorityConfig> | undefined,
  contextGraphId: string,
): number {
  const configured = priorities?.[contextGraphId];
  if (configured !== undefined) return configured;
  // Read-side backstop for maps that never passed through
  // resolveSyncContextGraphPriorities (a raw config object, or none at all):
  // system graphs sorting last must not depend on every caller remembering
  // the resolve step. A resolved map already carries the same value, so the
  // two layers can never disagree.
  return SYSTEM_CONTEXT_GRAPH_IDS.has(contextGraphId)
    ? DEFAULT_SYSTEM_CONTEXT_GRAPH_PRIORITY
    : 0;
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
