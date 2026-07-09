import { getMetrics, type OperationContext } from '@origintrail-official/dkg-core';

export interface SyncBackpressureSnapshot {
  inflight: number;
  queued: number;
  limit: number | null;
  queueLimit: number | null;
}

type Release = () => void;

interface QueueEntry {
  limit: number;
  resolve: (release: Release) => void;
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

function acquire(limit: number, queueLimit: number | undefined): Promise<Release> {
  lastLimit = limit;
  lastQueueLimit = queueLimit ?? null;
  if (inflight < limit && queue.length === 0) {
    inflight += 1;
    getMetrics().syncGlobalInflight.record(inflight);
    return Promise.resolve(releaseOnce);
  }
  if (typeof queueLimit === 'number' && queue.length >= queueLimit) {
    throw new SyncBackpressureBusyError(
      `sync backpressure queue full (global inflight=${inflight}/${limit}, queued=${queue.length}/${queueLimit})`,
    );
  }
  return new Promise((resolve) => {
    queue.push({ limit, resolve });
    getMetrics().syncBackgroundQueueDepth.record(queue.length);
    drain();
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

export function resolveSyncGlobalMaxInflight(
  configValue: number | undefined,
  legacyConfigValue?: number,
): number | undefined {
  const value = nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_MAX_INFLIGHT'))
    ?? nonNegativeInteger(parseIntegerEnv('DKG_SYNC_GLOBAL_LIMIT'))
    ?? nonNegativeInteger(configValue)
    ?? nonNegativeInteger(legacyConfigValue)
    ?? DEFAULT_SYNC_GLOBAL_MAX_INFLIGHT;
  return value > 0 ? value : undefined;
}

export function resolveSyncGlobalQueueLimit(
  configValue: number | undefined,
  limit?: number,
): number | undefined {
  const configured = resolveNonNegativeIntegerSwitch(configValue, 'DKG_SYNC_GLOBAL_QUEUE_LIMIT');
  if (configured != null) return configured;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) return undefined;
  return limit * DEFAULT_SYNC_GLOBAL_QUEUE_LIMIT_MULTIPLIER;
}

export function getSyncBackpressureSnapshot(limit?: number, queueLimit?: number): SyncBackpressureSnapshot {
  return {
    inflight,
    queued: queue.length,
    limit: limit ?? lastLimit,
    queueLimit: queueLimit ?? lastQueueLimit,
  };
}

export async function withGlobalSyncBackpressure<T>(
  options: {
    limit?: number;
    queueLimit?: number;
    ctx: OperationContext;
    label: string;
    logInfo?: (ctx: OperationContext, message: string) => void;
  },
  work: () => Promise<T>,
): Promise<T> {
  const limit = options.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    return work();
  }
  const queueLimit = options.queueLimit;

  const queuedBefore = queue.length;
  if (inflight >= limit) {
    if (typeof queueLimit === 'number' && queuedBefore >= queueLimit) {
      const message = `Sync backpressure rejected ${options.label} `
        + `(global inflight=${inflight}/${limit}, queued=${queuedBefore}/${queueLimit})`;
      options.logInfo?.(options.ctx, message);
      throw new SyncBackpressureBusyError(message);
    }
    options.logInfo?.(
      options.ctx,
      `Sync backpressure queued ${options.label} `
        + `(global inflight=${inflight}/${limit}, queued=${queuedBefore}${typeof queueLimit === 'number' ? `/${queueLimit}` : ''})`,
    );
  }
  const release = await acquire(limit, queueLimit);
  try {
    options.logInfo?.(
      options.ctx,
      `Sync backpressure running ${options.label} `
        + `(global inflight=${inflight}/${limit}, queued=${queue.length}${typeof queueLimit === 'number' ? `/${queueLimit}` : ''})`,
    );
    return await work();
  } finally {
    release();
  }
}
