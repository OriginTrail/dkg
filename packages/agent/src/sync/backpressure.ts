import { performance } from 'node:perf_hooks';
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
  /** Scheduler-native scopes whose exact recovery must retain one slot. */
  selectedRecoveryContextGraphIds?: readonly string[];
}

declare const syncGlobalBackpressurePolicyBrand: unique symbol;

export type SyncGlobalBackpressurePolicy = Readonly<(
  | { limit: number; queueLimit: number }
  | { limit: undefined; queueLimit: undefined }
) & { [syncGlobalBackpressurePolicyBrand]: true }>;

interface GlobalQueuePayload {
  limit: number;
  automaticBackgroundLimit: number;
  label: string;
  contextGraphId?: string;
  source: SyncAdmissionSource;
  capacityClaim: SyncCapacityClaim;
}

type SyncCapacityClaim =
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'automatic-background' }
  | {
    readonly kind: 'ordinary-selected-scope';
    readonly contextGraphId: string;
    readonly automaticBackground: boolean;
  }
  | {
    readonly kind: 'selected-recovery';
    readonly contextGraphId: string;
  };

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
 * closed sets (5 × 8), so the label space stays bounded and free of Context
 * Graph and peer identifiers.
 */
function syncAdmissionOperation(payload: GlobalQueuePayload): string {
  return `${syncOperationClass(payload.label)}:${normalizeSyncAdmissionSource(payload.source)}`;
}

class SyncCapacityTracker {
  private inflight = 0;
  private automaticBackgroundInflight = 0;
  private selectedRecoveryInflight = 0;
  private ordinarySelectedScopeInflightTotal = 0;
  private readonly ordinarySelectedScopeInflight = new Map<string, number>();

  get inflightCount(): number {
    return this.inflight;
  }

  classify(input: {
    contextGraphId?: string;
    source: SyncAdmissionSource;
    selectedSwmPriority: boolean;
    selectedRecoveryScope: boolean;
  }): SyncCapacityClaim {
    const automaticBackground = input.source === 'on-connect'
      || input.source === 'reconcile'
      || input.source === 'vm-recovery'
      || input.source === 'swm-recovery'
      || input.source === 'catchup-background';
    if (
      input.selectedRecoveryScope
      && input.contextGraphId !== undefined
      && (
        input.selectedSwmPriority
        || input.source === 'vm-recovery'
        || input.source === 'swm-recovery'
      )
    ) {
      return { kind: 'selected-recovery', contextGraphId: input.contextGraphId };
    }
    if (input.selectedRecoveryScope && input.contextGraphId !== undefined) {
      return {
        kind: 'ordinary-selected-scope',
        contextGraphId: input.contextGraphId,
        automaticBackground,
      };
    }
    return automaticBackground ? { kind: 'automatic-background' } : { kind: 'unrestricted' };
  }

  canRun(claim: SyncCapacityClaim, limit: number, automaticBackgroundLimit: number): boolean {
    if (this.inflight >= limit) return false;
    if (
      this.isAutomaticBackground(claim)
      && this.automaticBackgroundInflight >= automaticBackgroundLimit
    ) return false;
    if (
      limit > 1
      && claim.kind === 'ordinary-selected-scope'
      && (this.ordinarySelectedScopeInflight.get(claim.contextGraphId) ?? 0) >= limit - 1
    ) return false;

    // As soon as selected-scope fallback is active (or asks to become active),
    // every non-selected claim shares only limit - 1 slots. This keeps the last
    // slot available for exact VM or selected-SWM recovery instead of allowing
    // unrelated foreground/recovery work to consume it. Existing work is never
    // pre-empted; admission simply waits for a safe boundary.
    const selectedReservationActive = this.ordinarySelectedScopeInflightTotal > 0
      || claim.kind === 'ordinary-selected-scope';
    const nonSelectedInflight = this.inflight - this.selectedRecoveryInflight;
    return !(
      limit > 1
      && selectedReservationActive
      && claim.kind !== 'selected-recovery'
      && nonSelectedInflight >= limit - 1
    );
  }

  start(claim: SyncCapacityClaim): () => void {
    this.increment(claim);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.decrement(claim);
    };
  }

  rollback(claim: SyncCapacityClaim): void {
    this.decrement(claim);
  }

  private isAutomaticBackground(claim: SyncCapacityClaim): boolean {
    return claim.kind === 'automatic-background'
      || (claim.kind === 'ordinary-selected-scope' && claim.automaticBackground);
  }

  private increment(claim: SyncCapacityClaim): void {
    this.inflight += 1;
    if (this.isAutomaticBackground(claim)) this.automaticBackgroundInflight += 1;
    if (claim.kind === 'selected-recovery') this.selectedRecoveryInflight += 1;
    if (claim.kind === 'ordinary-selected-scope') {
      this.ordinarySelectedScopeInflightTotal += 1;
      this.ordinarySelectedScopeInflight.set(
        claim.contextGraphId,
        (this.ordinarySelectedScopeInflight.get(claim.contextGraphId) ?? 0) + 1,
      );
    }
  }

  private decrement(claim: SyncCapacityClaim): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.isAutomaticBackground(claim)) {
      this.automaticBackgroundInflight = Math.max(0, this.automaticBackgroundInflight - 1);
    }
    if (claim.kind === 'selected-recovery') {
      this.selectedRecoveryInflight = Math.max(0, this.selectedRecoveryInflight - 1);
    }
    if (claim.kind === 'ordinary-selected-scope') {
      this.ordinarySelectedScopeInflightTotal = Math.max(
        0,
        this.ordinarySelectedScopeInflightTotal - 1,
      );
      const next = Math.max(
        0,
        (this.ordinarySelectedScopeInflight.get(claim.contextGraphId) ?? 0) - 1,
      );
      if (next === 0) this.ordinarySelectedScopeInflight.delete(claim.contextGraphId);
      else this.ordinarySelectedScopeInflight.set(claim.contextGraphId, next);
    }
  }
}

const capacityTracker = new SyncCapacityTracker();
let lastLimit: number | null = null;
let lastQueueLimit: number | null = null;
const queue = new PriorityAdmissionQueue<GlobalQueuePayload>({
  now: () => performance.now(),
  canRun: (entry) => capacityTracker.canRun(
    entry.payload.capacityClaim,
    entry.payload.limit,
    entry.payload.automaticBackgroundLimit,
  ),
  onStart: (entry) => {
    const { capacityClaim } = entry.payload;
    const releaseCapacity = capacityTracker.start(capacityClaim);
    lastLimit = entry.payload.limit;
    getMetrics().syncGlobalInflight.record(capacityTracker.inflightCount);
    return () => {
      releaseCapacity();
      getMetrics().syncGlobalInflight.record(capacityTracker.inflightCount);
    };
  },
  onStartFailureRollback: (entry) => {
    capacityTracker.rollback(entry.payload.capacityClaim);
    getMetrics().syncGlobalInflight.record(capacityTracker.inflightCount);
  },
  onDepthChange: (depth) => getMetrics().syncBackgroundQueueDepth.record(depth),
  observability: {
    scheduler: 'sync-global',
    // Admission labels also carry CG/peer correlation identifiers. Collapse
    // them to a fixed operation class, paired with the bounded admission
    // source, before node-wide diagnostics/logging.
    operation: (entry) => syncAdmissionOperation(entry.payload),
    inflightLimit: (entry) => entry.payload.limit,
    thresholds: {
      degradedQueueAgeMs: DEFAULT_SYNC_PRIORITY_AGING_MS / 2,
      stalledActiveAgeMs: 120_000,
    },
    register: true,
  },
});
const automaticBackgroundLimits = new WeakMap<object, number>();
const selectedRecoveryScopeIds = new WeakMap<object, ReadonlySet<string>>();

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
    selectedSwmPriority: boolean;
    signal?: AbortSignal;
    agingThresholdMs: number;
  },
): PriorityAdmission<GlobalQueuePayload> {
  const { limit } = policy;
  if (limit === undefined) throw new Error('disabled sync backpressure policy cannot acquire');
  const { queueLimit } = policy;
  lastLimit = limit;
  lastQueueLimit = queueLimit;
  const queuedBefore = queue.length;
  const selectedRecoveryScope = options.contextGraphId !== undefined
    && (selectedRecoveryScopeIds.get(policy)?.has(options.contextGraphId) ?? false);
  return queue.acquire({
    payload: {
      limit,
      automaticBackgroundLimit: automaticBackgroundLimits.get(policy) ?? limit,
      label: options.label,
      contextGraphId: options.contextGraphId,
      source: options.source,
      capacityClaim: capacityTracker.classify({
        contextGraphId: options.contextGraphId,
        source: options.source,
        selectedSwmPriority: options.selectedSwmPriority,
        selectedRecoveryScope,
      }),
    },
    ownerKey: 'global',
    lane: options.lane,
    priority: options.priority,
    priorityClass: options.priorityClass,
    signal: options.signal,
    agingThresholdMs: options.agingThresholdMs,
    queueLimit,
    createBusyError: () => new SyncBackpressureBusyError(
      `Sync backpressure rejected ${options.label} `
        + `(global inflight=${capacityTracker.inflightCount}/${limit}, queued=${queuedBefore}/${queueLimit})`,
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

/** Effective VM/SWM background reconciler activation. Kept as one public
 * resolver so runtime gates and operator-facing status cannot disagree about
 * config/default/environment precedence. */
export function resolveSyncReconcilerEnabled(configValue?: boolean): boolean {
  return resolveBooleanSwitch(
    configValue,
    'DKG_SYNC_RECONCILER_ENABLED',
    true,
  );
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

export function resolveSyncGlobalBackpressure(
  config: SyncGlobalBackpressureConfig,
): SyncGlobalBackpressurePolicy {
  const limit = nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT'))
    ?? nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_LIMIT'))
    ?? nonNegativeInteger(config.syncGlobalMaxInflight)
    ?? nonNegativeInteger(config.syncGlobalLimit)
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
  const selectedRecoveryIds = new Set(
    config.selectedRecoveryContextGraphIds?.filter(
      (contextGraphId) => typeof contextGraphId === 'string' && contextGraphId.length > 0,
    ) ?? [],
  );
  const policy = Object.freeze({
    limit,
    queueLimit,
  }) as SyncGlobalBackpressurePolicy;
  // A selected complete SWM provider is useful only if its transfer can enter
  // the scheduler. Keep one slot out of every automatic background source
  // because those sources can start during daemon bootstrap before the
  // selected Edge provider becomes dialable. For the selected CG itself, the
  // scope-aware guard above also prevents explicit fallback fanout from
  // consuming that slot before exact VM or selected-SWM recovery arrives.
  automaticBackgroundLimits.set(policy, selectedRecoveryIds.size > 0 && limit > 1 ? limit - 1 : limit);
  selectedRecoveryScopeIds.set(policy, selectedRecoveryIds);
  return policy;
}

export function getSyncBackpressureSnapshot(
  policy?: SyncGlobalBackpressurePolicy,
): SyncBackpressureSnapshot {
  const queuedByPriorityClass: Record<SyncPriorityClass, number> = {
    elevated: 0,
    default: 0,
    deprioritized: 0,
  };
  for (const entry of queue.entries()) queuedByPriorityClass[entry.priorityClass] += 1;
  return {
    inflight: capacityTracker.inflightCount,
    queued: queue.length,
    limit: policy ? policy.limit ?? null : lastLimit,
    queueLimit: policy ? policy.queueLimit ?? null : lastQueueLimit,
    queuedByPriorityClass,
    oldestQueuedAgeMs: queue.oldestAgeMs(),
  };
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
    /** The selected graph-complete RFC-64 SWM transfer may use the reserved slot. */
    selectedSwmPriority?: boolean;
    signal?: AbortSignal;
    agingThresholdMs?: number;
    logInfo?: (ctx: OperationContext, message: string) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  const { limit, queueLimit } = options.policy;
  if (limit === undefined) {
    lastLimit = null;
    lastQueueLimit = null;
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
      selectedSwmPriority: options.selectedSwmPriority === true,
      signal: options.signal,
      agingThresholdMs: options.agingThresholdMs ?? DEFAULT_SYNC_PRIORITY_AGING_MS,
    });
  } catch (error) {
    if (error instanceof SyncBackpressureBusyError) {
      options.logInfo?.(options.ctx, error.message);
    }
    throw error;
  }

  if (admission.status === 'queued') {
    options.logInfo?.(
      options.ctx,
      `Sync backpressure queued ${options.label} `
        + `(global inflight=${capacityTracker.inflightCount}/${limit}, queued=${admission.queuedBefore}/${queueLimit})`,
    );
  }
  const release = await admission.release;
  try {
    options.logInfo?.(
      options.ctx,
      `Sync backpressure running ${options.label} `
        + `(global inflight=${capacityTracker.inflightCount}/${limit}, queued=${queue.length}/${queueLimit})`,
    );
    return await work();
  } finally {
    release();
  }
}
