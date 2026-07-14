import { getMetrics, type OperationContext } from '@origintrail-official/dkg-core';
import type { SyncPriorityClass, SyncSchedulerLane } from './policy.js';

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
  | { limit: number; queueLimit: number }
  | { limit: undefined; queueLimit: undefined }
) & { [syncGlobalBackpressurePolicyBrand]: true }>;

type Release = () => void;

interface QueueEntry {
  limit: number;
  contextGraphId?: string;
  lane: SyncSchedulerLane;
  priority: number;
  priorityClass: SyncPriorityClass;
  sequence: number;
  enqueuedAt: number;
  now: () => number;
  agingThresholdMs: number;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SyncBackpressureAdmission {
  status: 'running' | 'queued';
  queuedBefore: number;
  release: Promise<Release>;
}

const queue: QueueEntry[] = [];
let inflight = 0;
let lastLimit: number | null = null;
let lastQueueLimit: number | null = null;
let enqueueSequence = 0;

export const DEFAULT_SYNC_GLOBAL_MAX_INFLIGHT = 2;
export const DEFAULT_SYNC_GLOBAL_QUEUE_LIMIT_MULTIPLIER = 2;
export const DEFAULT_SYNC_PRIORITY_AGING_MS = 30_000;

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

function queueMetricAttributes(entry: Pick<QueueEntry, 'lane' | 'priorityClass'>) {
  return { lane: entry.lane, priority_class: entry.priorityClass };
}

function cleanupQueueEntry(entry: QueueEntry): void {
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
}

function recordQueueDepth(): void {
  getMetrics().syncBackgroundQueueDepth.record(queue.length);
}

function selectNextIndex(): { index: number; aged: boolean } | undefined {
  const runnable = queue
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => inflight < entry.limit);
  if (runnable.length === 0) return undefined;
  const aged = runnable
    .filter(({ entry }) => entry.now() - entry.enqueuedAt >= entry.agingThresholdMs)
    .sort((a, b) => a.entry.sequence - b.entry.sequence)[0];
  if (aged) return { index: aged.index, aged: true };
  const highest = runnable.sort((a, b) => (
    b.entry.priority - a.entry.priority
    || a.entry.sequence - b.entry.sequence
  ))[0];
  return highest ? { index: highest.index, aged: false } : undefined;
}

function drain(): void {
  for (;;) {
    const selected = selectNextIndex();
    if (!selected) return;
    const [next] = queue.splice(selected.index, 1);
    cleanupQueueEntry(next);
    recordQueueDepth();
    inflight += 1;
    getMetrics().syncGlobalInflight.record(inflight);
    const attributes = queueMetricAttributes(next);
    const waitMs = Math.max(0, next.now() - next.enqueuedAt);
    getMetrics().syncSchedulerQueueWaitMs.record(waitMs, attributes);
    getMetrics().syncSchedulerDecisionsTotal.add(1, { ...attributes, outcome: 'started' });
    if (selected.aged) {
      getMetrics().syncSchedulerDecisionsTotal.add(1, { ...attributes, outcome: 'aged' });
    }
    lastLimit = next.limit;
    next.resolve(makeRelease());
  }
}

function makeRelease(): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflight = Math.max(0, inflight - 1);
    getMetrics().syncGlobalInflight.record(inflight);
    drain();
  };
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? 'Sync admission aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

function acquire(
  policy: SyncGlobalBackpressurePolicy,
  options: {
    label: string;
    contextGraphId?: string;
    lane: SyncSchedulerLane;
    priority: number;
    priorityClass: SyncPriorityClass;
    signal?: AbortSignal;
    agingThresholdMs: number;
    now: () => number;
  },
): SyncBackpressureAdmission {
  if (options.signal?.aborted) throw abortError(options.signal.reason);
  const { limit } = policy;
  const queuedBefore = queue.length;
  if (limit === undefined) {
    lastLimit = null;
    lastQueueLimit = null;
    return {
      status: 'running',
      queuedBefore,
      release: Promise.resolve(() => {}),
    };
  }

  const { queueLimit } = policy;
  lastLimit = limit;
  lastQueueLimit = queueLimit ?? null;
  if (inflight < limit && queuedBefore === 0) {
    inflight += 1;
    getMetrics().syncGlobalInflight.record(inflight);
    getMetrics().syncSchedulerDecisionsTotal.add(1, {
      lane: options.lane,
      priority_class: options.priorityClass,
      outcome: 'started',
    });
    return {
      status: 'running',
      queuedBefore,
      release: Promise.resolve(makeRelease()),
    };
  }
  if (queuedBefore >= queueLimit) {
    const displaced = queue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.priority < options.priority)
      .sort((a, b) => a.entry.priority - b.entry.priority || b.entry.sequence - a.entry.sequence)[0];
    if (displaced) {
      const [victim] = queue.splice(displaced.index, 1);
      cleanupQueueEntry(victim);
      getMetrics().syncSchedulerDecisionsTotal.add(1, {
        ...queueMetricAttributes(victim),
        outcome: 'displaced',
      });
      victim.reject(new SyncBackpressureBusyError(
        `Sync backpressure displaced ${victim.contextGraphId ?? 'queued work'} for higher-priority ${options.label}`,
        'displaced',
      ));
    } else {
      getMetrics().syncSchedulerDecisionsTotal.add(1, {
        lane: options.lane,
        priority_class: options.priorityClass,
        outcome: 'rejected',
      });
      throw new SyncBackpressureBusyError(
        `Sync backpressure rejected ${options.label} `
          + `(global inflight=${inflight}/${limit}, queued=${queuedBefore}/${queueLimit})`,
      );
    }
  }

  const release = new Promise<Release>((resolve, reject) => {
    const entry: QueueEntry = {
      limit,
      contextGraphId: options.contextGraphId,
      lane: options.lane,
      priority: options.priority,
      priorityClass: options.priorityClass,
      sequence: enqueueSequence++,
      enqueuedAt: options.now(),
      now: options.now,
      agingThresholdMs: options.agingThresholdMs,
      resolve,
      reject,
      signal: options.signal,
    };
    entry.onAbort = () => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      cleanupQueueEntry(entry);
      recordQueueDepth();
      getMetrics().syncSchedulerDecisionsTotal.add(1, {
        ...queueMetricAttributes(entry),
        outcome: 'aborted',
      });
      reject(abortError(options.signal?.reason));
    };
    queue.push(entry);
    recordQueueDepth();
    if (options.signal) {
      options.signal.addEventListener('abort', entry.onAbort, { once: true });
      if (options.signal.aborted) entry.onAbort();
    }
    drain();
  });
  return { status: 'queued', queuedBefore, release };
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
  return Object.freeze({
    limit,
    queueLimit,
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
  for (const entry of queue) queuedByPriorityClass[entry.priorityClass] += 1;
  return {
    inflight,
    queued: queue.length,
    limit: policy ? policy.limit ?? null : lastLimit,
    queueLimit: policy ? policy.queueLimit ?? null : lastQueueLimit,
    queuedByPriorityClass,
    oldestQueuedAgeMs: queue.length === 0
      ? 0
      : Math.max(0, now - Math.min(...queue.map((entry) => entry.enqueuedAt))),
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
    signal?: AbortSignal;
    /** Deterministic scheduler injection; not operator configuration. */
    agingThresholdMs?: number;
    now?: () => number;
    logInfo?: (ctx: OperationContext, message: string) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  const { limit, queueLimit } = options.policy;
  let admission: SyncBackpressureAdmission;
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

  if (limit !== undefined && admission.status === 'queued') {
    options.logInfo?.(
      options.ctx,
      `Sync backpressure queued ${options.label} `
        + `(global inflight=${inflight}/${limit}, queued=${admission.queuedBefore}/${queueLimit})`,
    );
  }
  const release = await admission.release;
  try {
    if (limit !== undefined) {
      options.logInfo?.(
        options.ctx,
        `Sync backpressure running ${options.label} `
          + `(global inflight=${inflight}/${limit}, queued=${queue.length}/${queueLimit})`,
      );
    }
    return await work();
  } finally {
    release();
  }
}
