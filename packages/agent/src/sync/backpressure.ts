import { getMetrics, type OperationContext } from '@origintrail-official/dkg-core';
import {
  normalizeSyncAdmissionSource,
  type SyncAdmissionSource,
  type SyncPriorityClass,
  type SyncSchedulerLane,
} from './policy.js';
import {
  PriorityAdmissionQueue,
  type PriorityAdmission,
} from './priority-admission-queue.js';

export interface SyncBackpressureSnapshot {
  inflight: number;
  queued: number;
  limit: number | null;
  queueLimit: number | null;
  queuedByPriorityClass: Record<SyncPriorityClass, number>;
  oldestQueuedAgeMs: number;
}

export interface SyncGlobalBackpressureConfig {
  syncGlobalMaxInflight?: number;
  syncGlobalLimit?: number;
  syncGlobalQueueLimit?: number;
}

declare const syncGlobalBackpressurePolicyBrand: unique symbol;

export type SyncGlobalBackpressurePolicy = Readonly<(
  | {
      limit: number;
      queueLimit: number;
      currentLimit?: SyncBackpressureCurrentLimit;
    }
  | { limit: undefined; queueLimit: undefined }
) & { [syncGlobalBackpressurePolicyBrand]: true }>;

interface GlobalQueuePayload {
  label: string;
  contextGraphId?: string;
  source: SyncAdmissionSource;
}

/** Resolve the current requester-sync capacity. The static policy remains the hard ceiling. */
export type SyncBackpressureCurrentLimit = () => number;

export const DEFAULT_SYNC_GLOBAL_MAX_INFLIGHT = 2;
export const DEFAULT_SYNC_GLOBAL_QUEUE_LIMIT_MULTIPLIER = 2;
export const DEFAULT_SYNC_PRIORITY_AGING_MS = 30_000;

function syncOperationClass(label: string): string {
  const operation = label.split(':', 1)[0];
  switch (operation) {
    case 'durable':
    case 'changelog':
    case 'shared-memory':
    case 'swm-recovery':
      return operation;
    default:
      return 'sync';
  }
}

/**
 * `<work class>:<trigger>` — the operation dimension of node-wide pressure
 * diagnostics. The work class alone duplicates `lane`; pairing it with the
 * admission source is what lets an operator attribute a saturated `sync-global`
 * queue to explicit catch-up versus sync-on-connect versus reconcile, and read
 * per-trigger queue/active ages straight off the snapshot. Both halves are
 * closed sets (5 × 7), so the label space stays bounded and free of Context
 * Graph and peer identifiers.
 */
function syncAdmissionOperation(payload: GlobalQueuePayload): string {
  return `${syncOperationClass(payload.label)}:${normalizeSyncAdmissionSource(payload.source)}`;
}

let inflight = 0;
const globalCapacity: {
  hardLimit: number | null;
  queueLimit: number | null;
  currentLimit?: SyncBackpressureCurrentLimit;
  effectiveLimit: number | null;
} = {
  hardLimit: null,
  queueLimit: null,
  effectiveLimit: null,
};

function clampEffectiveLimit(hardLimit: number, currentLimit: number): number {
  return Math.min(hardLimit, currentLimit);
}

function refreshGlobalCapacity(): number | null {
  const { hardLimit, currentLimit } = globalCapacity;
  if (hardLimit === null) return null;
  if (!currentLimit) {
    globalCapacity.effectiveLimit = hardLimit;
    return hardLimit;
  }
  try {
    const current = positiveInteger(currentLimit());
    if (current !== undefined) {
      globalCapacity.effectiveLimit = clampEffectiveLimit(hardLimit, current);
    }
  } catch {
    // Runtime capacity sampling is advisory. Retain the last valid shared value.
  }
  return globalCapacity.effectiveLimit ?? hardLimit;
}

function activateGlobalCapacity(policy: SyncGlobalBackpressurePolicy): number | null {
  if (policy.limit === undefined) {
    globalCapacity.hardLimit = null;
    globalCapacity.queueLimit = null;
    globalCapacity.currentLimit = undefined;
    globalCapacity.effectiveLimit = null;
    return null;
  }

  const providerChanged = globalCapacity.currentLimit !== policy.currentLimit;
  const hardLimitChanged = globalCapacity.hardLimit !== policy.limit;
  globalCapacity.hardLimit = policy.limit;
  globalCapacity.queueLimit = policy.queueLimit;
  globalCapacity.currentLimit = policy.currentLimit;
  if (!policy.currentLimit) {
    globalCapacity.effectiveLimit = policy.limit;
  } else if (providerChanged || hardLimitChanged) {
    // A new provider starts from the safest valid value already in force. If
    // its first sample fails, never increase concurrency because of the error.
    globalCapacity.effectiveLimit = Math.min(
      policy.limit,
      globalCapacity.effectiveLimit ?? policy.limit,
    );
  }
  return refreshGlobalCapacity();
}

function snapshotPolicyLimit(policy: SyncGlobalBackpressurePolicy): number | null {
  if (policy.limit === undefined) return null;
  if (
    globalCapacity.hardLimit === policy.limit
    && globalCapacity.queueLimit === policy.queueLimit
    && globalCapacity.currentLimit === policy.currentLimit
  ) {
    return refreshGlobalCapacity();
  }
  if (!policy.currentLimit) return policy.limit;
  try {
    const current = positiveInteger(policy.currentLimit());
    return current === undefined
      ? policy.limit
      : clampEffectiveLimit(policy.limit, current);
  } catch {
    return policy.limit;
  }
}

const queue = new PriorityAdmissionQueue<GlobalQueuePayload>({
  canRun: () => inflight < (refreshGlobalCapacity() ?? 0),
  onStart: () => {
    inflight += 1;
    refreshGlobalCapacity();
    getMetrics().syncGlobalInflight.record(inflight);
    return () => {
      inflight = Math.max(0, inflight - 1);
      getMetrics().syncGlobalInflight.record(inflight);
    };
  },
  onDepthChange: (depth) => getMetrics().syncBackgroundQueueDepth.record(depth),
  observability: {
    scheduler: 'sync-global',
    // Admission labels also carry CG/peer correlation identifiers. Collapse
    // them to a fixed operation class, paired with the bounded admission
    // source, before node-wide diagnostics/logging.
    operation: (entry) => syncAdmissionOperation(entry.payload),
    inflightLimit: () => refreshGlobalCapacity(),
    thresholds: {
      degradedQueueAgeMs: DEFAULT_SYNC_PRIORITY_AGING_MS / 2,
      stalledActiveAgeMs: 120_000,
    },
    register: true,
  },
});

export type SyncBackpressureBusyReason = 'queue_full' | 'displaced';

export class SyncBackpressureBusyError extends Error {
  readonly reason: SyncBackpressureBusyReason;

  constructor(message: string, reason: SyncBackpressureBusyReason = 'queue_full') {
    super(message);
    this.name = 'SyncBackpressureBusyError';
    this.reason = reason;
  }
}

/** Return local admission pressure through the standard Error.cause chain. */
export function getSyncBackpressureBusyError(
  error: unknown,
): SyncBackpressureBusyError | undefined {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof SyncBackpressureBusyError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

function acquire(
  policy: SyncGlobalBackpressurePolicy,
  options: {
    label: string;
    contextGraphId?: string;
    lane: SyncSchedulerLane;
    priority: number;
    priorityClass: SyncPriorityClass;
    source: SyncAdmissionSource;
    signal?: AbortSignal;
    agingThresholdMs: number;
    now: () => number;
  },
): PriorityAdmission<GlobalQueuePayload> {
  const { limit } = policy;
  if (limit === undefined) throw new Error('disabled sync backpressure policy cannot acquire');
  const { queueLimit } = policy;
  const payload: GlobalQueuePayload = {
    label: options.label,
    contextGraphId: options.contextGraphId,
    source: options.source,
  };
  const currentLimit = activateGlobalCapacity(policy) ?? limit;
  const queuedBefore = queue.length;
  return queue.acquire({
    payload,
    ownerKey: 'global',
    lane: options.lane,
    priority: options.priority,
    priorityClass: options.priorityClass,
    signal: options.signal,
    agingThresholdMs: options.agingThresholdMs,
    now: options.now,
    queueLimit,
    createBusyError: () => new SyncBackpressureBusyError(
      `Sync backpressure rejected ${options.label} `
        + `(global inflight=${inflight}/${currentLimit}, queued=${queuedBefore}/${queueLimit})`,
    ),
    createDisplacedError: (victim) => new SyncBackpressureBusyError(
        `Sync backpressure displaced ${victim.payload.contextGraphId ?? 'queued work'} for higher-priority ${options.label}`,
        'displaced',
      ),
  });
}

export function parseBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on' || raw === 'enabled') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off' || raw === 'disabled') return false;
  return undefined;
}

export function resolveBooleanSwitch(
  configValue: boolean | undefined,
  envName: string,
  defaultValue: boolean,
): boolean {
  return parseBooleanEnv(envName) ?? configValue ?? defaultValue;
}

function parseIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 ? value : undefined;
}

export function resolvePositiveIntegerSwitch(
  configValue: number | undefined,
  envName: string,
): number | undefined {
  const value = parseIntegerEnv(envName) ?? configValue;
  if (value == null) return undefined;
  return positiveInteger(value);
}

export function resolveNonNegativeIntegerSwitch(
  configValue: number | undefined,
  envName: string,
): number | undefined {
  const value = parseIntegerEnv(envName) ?? configValue;
  if (value == null) return undefined;
  return nonNegativeInteger(value);
}

/** Resolve only an explicitly configured global limit, using runtime policy precedence. */
export function resolveExplicitSyncGlobalLimit(
  config: SyncGlobalBackpressureConfig,
): number | undefined {
  return nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT'))
    ?? nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_LIMIT'))
    ?? nonNegativeInteger(config.syncGlobalMaxInflight)
    ?? nonNegativeInteger(config.syncGlobalLimit);
}

/** Resolve one node-wide policy; the optional live limit is shared by every admission. */
export function resolveSyncGlobalBackpressure(
  config: SyncGlobalBackpressureConfig,
  currentLimit?: SyncBackpressureCurrentLimit,
): SyncGlobalBackpressurePolicy {
  const limit = resolveExplicitSyncGlobalLimit(config)
    ?? DEFAULT_SYNC_GLOBAL_MAX_INFLIGHT;
  if (limit === 0) {
    return Object.freeze({
      limit: undefined,
      queueLimit: undefined,
    }) as SyncGlobalBackpressurePolicy;
  }

  const queueLimit = nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_QUEUE_LIMIT'))
    ?? nonNegativeInteger(config.syncGlobalQueueLimit)
    ?? limit * DEFAULT_SYNC_GLOBAL_QUEUE_LIMIT_MULTIPLIER;
  return Object.freeze({
    limit,
    queueLimit,
    ...(currentLimit ? { currentLimit } : {}),
  }) as SyncGlobalBackpressurePolicy;
}

export function getSyncBackpressureSnapshot(
  policy?: SyncGlobalBackpressurePolicy,
  now = Date.now(),
): SyncBackpressureSnapshot {
  const queuedByPriorityClass: Record<SyncPriorityClass, number> = {
    elevated: 0,
    default: 0,
    deprioritized: 0,
  };
  for (const entry of queue.entries()) queuedByPriorityClass[entry.priorityClass] += 1;
  return {
    inflight,
    queued: queue.length,
    limit: policy ? snapshotPolicyLimit(policy) : globalCapacity.effectiveLimit,
    queueLimit: policy ? policy.queueLimit ?? null : globalCapacity.queueLimit,
    queuedByPriorityClass,
    oldestQueuedAgeMs: queue.oldestAgeMs(now),
  };
}

/**
 * Re-evaluate dynamic requester capacity and start newly admissible queued work.
 * Downshifts are drain-only because the queue never revokes running admissions.
 */
export function notifyGlobalSyncBackpressureCapacityChanged(): void {
  const effectiveLimit = refreshGlobalCapacity();
  if (effectiveLimit !== null && globalCapacity.queueLimit !== null) {
    queue.refreshPressureCapacity({
      inflightLimit: effectiveLimit,
      queueLimit: globalCapacity.queueLimit,
    });
  }
  queue.pump();
}

export async function withGlobalSyncBackpressure<T>(
  options: {
    policy: SyncGlobalBackpressurePolicy;
    ctx: OperationContext;
    label: string;
    contextGraphId?: string;
    lane?: SyncSchedulerLane;
    priority?: number;
    priorityClass?: SyncPriorityClass;
    /**
     * Which trigger enqueued this admission. Callers normalize at the boundary
     * where the value enters (`runContextGraphSyncWithBackpressure`); the clamp
     * below is defence in depth for anything that reaches the scheduler by
     * another route, so a bad cast can still only widen the label space to
     * `unspecified`.
     */
    source?: SyncAdmissionSource;
    signal?: AbortSignal;
    /** Deterministic scheduler injection; not operator configuration. */
    agingThresholdMs?: number;
    now?: () => number;
    logInfo?: (ctx: OperationContext, message: string) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  const { limit, queueLimit } = options.policy;
  if (limit === undefined) {
    if (inflight === 0 && queue.length === 0) activateGlobalCapacity(options.policy);
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error(String(options.signal.reason ?? 'Sync admission aborted'));
    }
    return work();
  }
  let admission: PriorityAdmission<GlobalQueuePayload>;
  const lane = options.lane ?? 'durable';
  const priority = options.priority ?? 0;
  const priorityClass = options.priorityClass ?? 'default';
  try {
    admission = acquire(options.policy, {
      label: options.label,
      contextGraphId: options.contextGraphId,
      lane,
      priority,
      priorityClass,
      source: normalizeSyncAdmissionSource(options.source),
      signal: options.signal,
      agingThresholdMs: options.agingThresholdMs ?? DEFAULT_SYNC_PRIORITY_AGING_MS,
      now: options.now ?? Date.now,
    });
  } catch (error) {
    if (error instanceof SyncBackpressureBusyError) {
      options.logInfo?.(options.ctx, error.message);
    }
    throw error;
  }

  if (admission.status === 'queued') {
    const currentLimit = refreshGlobalCapacity() ?? limit;
    options.logInfo?.(
      options.ctx,
      `Sync backpressure queued ${options.label} `
        + `(global inflight=${inflight}/${currentLimit}, queued=${admission.queuedBefore}/${queueLimit})`,
    );
  }
  const release = await admission.release;
  try {
    const currentLimit = refreshGlobalCapacity() ?? limit;
    options.logInfo?.(
      options.ctx,
      `Sync backpressure running ${options.label} `
        + `(global inflight=${inflight}/${currentLimit}, queued=${queue.length}/${queueLimit})`,
    );
    return await work();
  } finally {
    release();
  }
}
