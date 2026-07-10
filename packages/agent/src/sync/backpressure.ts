import { getMetrics, type OperationContext } from '@origintrail-official/dkg-core';

export interface SyncBackpressureSnapshot {
  inflight: number;
  queued: number;
  limit: number | null;
  queueLimit: number | null;
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
  resolve: (release: Release) => void;
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

export const DEFAULT_SYNC_GLOBAL_MAX_INFLIGHT = 2;
export const DEFAULT_SYNC_GLOBAL_QUEUE_LIMIT_MULTIPLIER = 2;

export class SyncBackpressureBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncBackpressureBusyError';
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

function drain(): void {
  for (;;) {
    const next = queue[0];
    if (!next || inflight >= next.limit) return;
    queue.shift();
    getMetrics().syncBackgroundQueueDepth.record(queue.length);
    inflight += 1;
    getMetrics().syncGlobalInflight.record(inflight);
    lastLimit = next.limit;
    next.resolve(releaseOnce);
  }
}

function releaseOnce(): void {
  inflight = Math.max(0, inflight - 1);
  getMetrics().syncGlobalInflight.record(inflight);
  drain();
}

function acquire(
  policy: SyncGlobalBackpressurePolicy,
  label: string,
): SyncBackpressureAdmission {
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
    return {
      status: 'running',
      queuedBefore,
      release: Promise.resolve(releaseOnce),
    };
  }
  if (queuedBefore >= queueLimit) {
    throw new SyncBackpressureBusyError(
      `Sync backpressure rejected ${label} `
        + `(global inflight=${inflight}/${limit}, queued=${queuedBefore}/${queueLimit})`,
    );
  }

  const release = new Promise<Release>((resolve) => {
    queue.push({ limit, resolve });
    getMetrics().syncBackgroundQueueDepth.record(queue.length);
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
): SyncBackpressureSnapshot {
  return {
    inflight,
    queued: queue.length,
    limit: policy ? policy.limit ?? null : lastLimit,
    queueLimit: policy ? policy.queueLimit ?? null : lastQueueLimit,
  };
}

export async function withGlobalSyncBackpressure<T>(
  options: {
    policy: SyncGlobalBackpressurePolicy;
    ctx: OperationContext;
    label: string;
    logInfo?: (ctx: OperationContext, message: string) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  const { limit, queueLimit } = options.policy;
  let admission: SyncBackpressureAdmission;
  try {
    admission = acquire(options.policy, options.label);
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
