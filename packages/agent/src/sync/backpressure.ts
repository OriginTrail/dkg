import { getMetrics, type OperationContext } from '@origintrail-official/dkg-core';

export interface SyncBackpressureSnapshot {
  inflight: number;
  queued: number;
  limit: number | null;
}

type Release = () => void;

interface QueueEntry {
  limit: number;
  resolve: (release: Release) => void;
}

const queue: QueueEntry[] = [];
let inflight = 0;
let lastLimit: number | null = null;

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

function acquire(limit: number): Promise<Release> {
  lastLimit = limit;
  if (inflight < limit && queue.length === 0) {
    inflight += 1;
    getMetrics().syncGlobalInflight.record(inflight);
    return Promise.resolve(releaseOnce);
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

export function resolvePositiveIntegerSwitch(
  configValue: number | undefined,
  envName: string,
): number | undefined {
  const value = parseIntegerEnv(envName) ?? configValue;
  if (value == null) return undefined;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveNonNegativeIntegerSwitch(
  configValue: number | undefined,
  envName: string,
): number | undefined {
  const value = parseIntegerEnv(envName) ?? configValue;
  if (value == null) return undefined;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function resolveSyncGlobalMaxInflight(configValue: number | undefined): number | undefined {
  return resolvePositiveIntegerSwitch(configValue, 'DKG_SYNC_GLOBAL_MAX_INFLIGHT');
}

export function getSyncBackpressureSnapshot(limit?: number): SyncBackpressureSnapshot {
  return {
    inflight,
    queued: queue.length,
    limit: limit ?? lastLimit,
  };
}

export async function withGlobalSyncBackpressure<T>(
  options: {
    limit?: number;
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

  const queuedBefore = queue.length;
  if (inflight >= limit) {
    options.logInfo?.(
      options.ctx,
      `Sync backpressure queued ${options.label} (global inflight=${inflight}/${limit}, queued=${queuedBefore})`,
    );
  }
  const release = await acquire(limit);
  try {
    options.logInfo?.(
      options.ctx,
      `Sync backpressure running ${options.label} (global inflight=${inflight}/${limit}, queued=${queue.length})`,
    );
    return await work();
  } finally {
    release();
  }
}
