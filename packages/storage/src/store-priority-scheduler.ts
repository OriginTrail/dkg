import { performance } from 'node:perf_hooks';
import { getMetrics } from '@origintrail-official/dkg-core';
import type { StorePressureSnapshot, StoreWorkPriority } from './triple-store.js';

export interface StorePrioritySchedulerSnapshot extends StorePressureSnapshot {
  ackInflight: number;
  normalInflight: number;
  backgroundInflight: number;
  ackQueued: number;
  normalQueued: number;
  backgroundQueued: number;
  maxConcurrent: number;
  ackReservedSlots: number;
  normalReservedSlots: number;
  backgroundReservedSlots: number;
  ackQueueLimit: number;
  normalQueueLimit: number;
  backgroundQueueLimit: number;
  queueWaitTimeoutMs: number;
}

export type StoreSchedulerBusyReason = 'queue_full' | 'queue_wait_timeout';

/**
 * A retry-safe overload rejection emitted only while work is still queued.
 * Callers may retry because the operation closure has not started.
 */
export class StoreSchedulerBusyError extends Error {
  readonly code = 'STORE_SCHEDULER_BUSY' as const;
  readonly retryable = true as const;

  constructor(
    readonly reason: StoreSchedulerBusyReason,
    readonly priority: StoreWorkPriority,
    readonly operation: string,
  ) {
    super(`Store scheduler ${reason.replaceAll('_', ' ')} (${priority}: ${operation || 'unknown'})`);
    this.name = 'StoreSchedulerBusyError';
  }
}

export type StorePriorityQueueLimits = Record<StoreWorkPriority, number>;

export interface StorePrioritySchedulerOptions {
  maxConcurrent?: number;
  ackReservedSlots?: number;
  normalReservedSlots?: number;
  backgroundReservedSlots?: number;
  queueLimits?: number | Partial<StorePriorityQueueLimits>;
  queueWaitTimeoutMs?: number;
  now?: () => number;
}

interface QueueEntry<T> {
  priority: StoreWorkPriority;
  operation: string;
  queuedAt: number;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  waitTimer?: ReturnType<typeof setTimeout>;
}

interface NonAckLaneCapacity {
  limit: number;
  normalReservedSlots: number;
  backgroundReservedSlots: number;
  backgroundLimit: number;
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_ACK_RESERVED_SLOTS = 1;
const DEFAULT_NORMAL_RESERVED_SLOTS = 1;
const DEFAULT_BACKGROUND_RESERVED_SLOTS = 1;
export const DEFAULT_STORE_QUEUE_LIMIT = 64;
export const DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS = 10_000;

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveQueueLimitsFromEnv(): StorePriorityQueueLimits {
  const common = parsePositiveIntegerEnv('DKG_STORE_QUEUE_LIMIT', DEFAULT_STORE_QUEUE_LIMIT);
  return {
    ack: parsePositiveIntegerEnv('DKG_STORE_ACK_QUEUE_LIMIT', common),
    normal: parsePositiveIntegerEnv('DKG_STORE_NORMAL_QUEUE_LIMIT', common),
    background: parsePositiveIntegerEnv('DKG_STORE_BACKGROUND_QUEUE_LIMIT', common),
  };
}

function normalizeQueueLimits(
  configured: number | Partial<StorePriorityQueueLimits>,
): StorePriorityQueueLimits {
  if (typeof configured === 'number') {
    const limit = Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_STORE_QUEUE_LIMIT;
    return { ack: limit, normal: limit, background: limit };
  }
  return {
    ack: normalizeQueueLimit(configured.ack),
    normal: normalizeQueueLimit(configured.normal),
    background: normalizeQueueLimit(configured.background),
  };
}

function normalizeQueueLimit(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) > 0
    ? value as number
    : DEFAULT_STORE_QUEUE_LIMIT;
}

function metricOperation(operation: string): string {
  const trimmed = operation.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 80) || 'unknown';
}

function priorityRank(priority: StoreWorkPriority): number {
  if (priority === 'ack') return 0;
  if (priority === 'normal') return 1;
  return 2;
}

export class StorePriorityScheduler {
  private readonly queues: Record<StoreWorkPriority, Array<QueueEntry<unknown>>> = {
    ack: [],
    normal: [],
    background: [],
  };

  private ackInflight = 0;
  private normalInflight = 0;
  private backgroundInflight = 0;
  private readonly maxConcurrent: number;
  private readonly ackReservedSlots: number;
  private readonly normalReservedSlots: number;
  private readonly backgroundReservedSlots: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly now: () => number;
  private readonly queueLimits: StorePriorityQueueLimits;

  constructor(options?: StorePrioritySchedulerOptions);
  /** @deprecated Use the named options object. Retained for package compatibility. */
  constructor(
    maxConcurrent?: number,
    ackReservedSlots?: number,
    now?: () => number,
    backgroundReservedSlots?: number,
    queueLimits?: number | Partial<StorePriorityQueueLimits>,
    queueWaitTimeoutMs?: number,
  );
  constructor(
    optionsOrMaxConcurrent: StorePrioritySchedulerOptions | number = {},
    legacyAckReservedSlots?: number,
    legacyNow?: () => number,
    legacyBackgroundReservedSlots?: number,
    legacyQueueLimits?: number | Partial<StorePriorityQueueLimits>,
    legacyQueueWaitTimeoutMs?: number,
  ) {
    const legacyCall = typeof optionsOrMaxConcurrent === 'number' || arguments.length > 1;
    const options: StorePrioritySchedulerOptions = legacyCall
      ? {
          maxConcurrent: typeof optionsOrMaxConcurrent === 'number'
            ? optionsOrMaxConcurrent
            : undefined,
          ackReservedSlots: legacyAckReservedSlots,
          now: legacyNow,
          backgroundReservedSlots: legacyBackgroundReservedSlots,
          queueLimits: legacyQueueLimits,
          queueWaitTimeoutMs: legacyQueueWaitTimeoutMs,
        }
      : optionsOrMaxConcurrent;
    this.maxConcurrent = options.maxConcurrent
      ?? parsePositiveIntegerEnv('DKG_STORE_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT);
    this.ackReservedSlots = options.ackReservedSlots
      ?? parsePositiveIntegerEnv('DKG_STORE_ACK_RESERVED_SLOTS', DEFAULT_ACK_RESERVED_SLOTS);
    this.normalReservedSlots = options.normalReservedSlots
      ?? parseNonNegativeIntegerEnv('DKG_STORE_NORMAL_RESERVED_SLOTS', DEFAULT_NORMAL_RESERVED_SLOTS);
    this.backgroundReservedSlots = options.backgroundReservedSlots
      ?? parseNonNegativeIntegerEnv(
        'DKG_STORE_BACKGROUND_RESERVED_SLOTS',
        DEFAULT_BACKGROUND_RESERVED_SLOTS,
      );
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs
      ?? parsePositiveIntegerEnv(
        'DKG_STORE_QUEUE_WAIT_TIMEOUT_MS',
        DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS,
      );
    this.now = options.now ?? (() => performance.now());
    this.queueLimits = normalizeQueueLimits(options.queueLimits ?? resolveQueueLimitsFromEnv());
  }

  get snapshot(): StorePrioritySchedulerSnapshot {
    const laneCapacity = this.nonAckLaneCapacity();
    return {
      ackInflight: this.ackInflight,
      normalInflight: this.normalInflight,
      backgroundInflight: this.backgroundInflight,
      ackQueued: this.queues.ack.length,
      normalQueued: this.queues.normal.length,
      backgroundQueued: this.queues.background.length,
      maxConcurrent: this.maxConcurrent,
      ackReservedSlots: this.effectiveAckReserve(),
      normalReservedSlots: laneCapacity.normalReservedSlots,
      backgroundReservedSlots: laneCapacity.backgroundReservedSlots,
      ackQueueLimit: this.queueLimits.ack,
      normalQueueLimit: this.queueLimits.normal,
      backgroundQueueLimit: this.queueLimits.background,
      queueWaitTimeoutMs: this.queueWaitTimeoutMs,
    };
  }

  async run<T>(
    priority: StoreWorkPriority | undefined,
    operation: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const normalizedPriority = priority ?? 'normal';
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
    }
    if (this.queues[normalizedPriority].length >= this.queueLimits[normalizedPriority]) {
      const error = new StoreSchedulerBusyError('queue_full', normalizedPriority, operation);
      this.observeRejection(error);
      throw error;
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        priority: normalizedPriority,
        operation,
        queuedAt: this.now(),
        work,
        resolve,
        reject,
        signal,
      };
      const onAbort = () => {
        if (this.removeQueued(entry as QueueEntry<unknown>)) {
          this.cleanupQueuedEntry(entry as QueueEntry<unknown>);
          const reason = signal?.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
          this.observeDepths();
          this.drain();
        }
      };
      entry.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.waitTimer = setTimeout(() => {
        entry.waitTimer = undefined;
        if (!this.removeQueued(entry as QueueEntry<unknown>)) return;
        this.cleanupQueuedEntry(entry as QueueEntry<unknown>);
        const error = new StoreSchedulerBusyError(
          'queue_wait_timeout',
          normalizedPriority,
          operation,
        );
        this.observeRejection(error);
        reject(error);
        this.observeDepths();
        this.drain();
      }, this.queueWaitTimeoutMs);
      if (typeof entry.waitTimer.unref === 'function') entry.waitTimer.unref();
      this.queues[normalizedPriority].push(entry as QueueEntry<unknown>);
      this.observeDepths();
      this.drain();
    });
  }

  private drain(): void {
    for (;;) {
      const next = this.nextRunnable();
      if (!next) return;
      this.start(next);
    }
  }

  private nextRunnable(): QueueEntry<unknown> | undefined {
    const priorities: StoreWorkPriority[] = ['ack', 'normal', 'background'];
    priorities.sort((a, b) => priorityRank(a) - priorityRank(b));
    for (const priority of priorities) {
      const queue = this.queues[priority];
      if (queue.length === 0) continue;
      if (!this.canStart(priority)) continue;
      return queue.shift();
    }
    return undefined;
  }

  private canStart(priority: StoreWorkPriority): boolean {
    const totalInflight = this.ackInflight + this.normalInflight + this.backgroundInflight;
    if (totalInflight >= this.maxConcurrent) return false;
    if (priority === 'ack') return true;

    const laneCapacity = this.nonAckLaneCapacity();
    const nonAckInflight = this.normalInflight + this.backgroundInflight;
    if (nonAckInflight >= laneCapacity.limit) return false;
    if (priority === 'background' && this.backgroundInflight >= laneCapacity.backgroundLimit) {
      return false;
    }
    if (
      priority === 'normal' &&
      this.shouldHoldBackgroundFloor(laneCapacity.backgroundReservedSlots)
    ) {
      return false;
    }
    return true;
  }

  private shouldHoldBackgroundFloor(backgroundReservedSlots: number): boolean {
    return backgroundReservedSlots > 0 &&
      this.queues.background.length > 0 &&
      this.backgroundInflight < backgroundReservedSlots;
  }

  private effectiveAckReserve(): number {
    return Math.min(this.ackReservedSlots, Math.max(0, this.maxConcurrent - 1));
  }

  private nonAckLimit(): number {
    return Math.max(1, this.maxConcurrent - this.effectiveAckReserve());
  }

  private nonAckLaneCapacity(): NonAckLaneCapacity {
    const limit = this.nonAckLimit();
    const normalReservedSlots = Math.min(
      Math.max(0, this.normalReservedSlots),
      Math.max(0, limit - 1),
    );
    const backgroundLimit = Math.max(1, limit - normalReservedSlots);
    const backgroundReservedSlots = Math.min(
      Math.max(0, this.backgroundReservedSlots),
      backgroundLimit,
      Math.max(0, limit - 1),
    );
    return { limit, normalReservedSlots, backgroundReservedSlots, backgroundLimit };
  }

  private start(entry: QueueEntry<unknown>): void {
    this.cleanupQueuedEntry(entry);
    this.increment(entry.priority);
    const startedAt = this.now();
    const waitMs = Math.max(0, startedAt - entry.queuedAt);
    this.observeQueueWait(entry, waitMs);
    this.observeDepths();

    let result: Promise<unknown>;
    try {
      result = entry.work();
    } catch (err) {
      result = Promise.reject(err);
    }

    result
      .then((value) => {
        this.observeDuration(entry, startedAt, 'ok');
        entry.resolve(value);
      })
      .catch((err) => {
        this.observeDuration(entry, startedAt, 'error');
        entry.reject(err);
      })
      .finally(() => {
        this.decrement(entry.priority);
        this.observeDepths();
        this.drain();
      });
  }

  private removeQueued(entry: QueueEntry<unknown>): boolean {
    const queue = this.queues[entry.priority];
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    return true;
  }

  private cleanupQueuedEntry(entry: QueueEntry<unknown>): void {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = undefined;
    }
    if (entry.waitTimer) {
      clearTimeout(entry.waitTimer);
      entry.waitTimer = undefined;
    }
  }

  private increment(priority: StoreWorkPriority): void {
    if (priority === 'ack') this.ackInflight += 1;
    else if (priority === 'normal') this.normalInflight += 1;
    else this.backgroundInflight += 1;
  }

  private decrement(priority: StoreWorkPriority): void {
    if (priority === 'ack') this.ackInflight = Math.max(0, this.ackInflight - 1);
    else if (priority === 'normal') this.normalInflight = Math.max(0, this.normalInflight - 1);
    else this.backgroundInflight = Math.max(0, this.backgroundInflight - 1);
  }

  private observeQueueWait(entry: QueueEntry<unknown>, waitMs: number): void {
    if (entry.priority !== 'ack') return;
    getMetrics().storageAckQueueWaitMs.record(waitMs, {
      operation: metricOperation(entry.operation),
    });
  }

  private observeDuration(entry: QueueEntry<unknown>, startedAt: number, outcome: 'ok' | 'error'): void {
    if (entry.priority !== 'ack') return;
    getMetrics().storageAckStoreOpDurationMs.record(Math.max(0, this.now() - startedAt), {
      operation: metricOperation(entry.operation),
      outcome,
    });
  }

  private observeRejection(error: StoreSchedulerBusyError): void {
    getMetrics().storeSchedulerRejectionsTotal.add(1, {
      priority: error.priority,
      reason: error.reason,
    });
  }

  private observeDepths(): void {
    const snapshot = this.snapshot;
    getMetrics().storageAckPriorityQueueDepth.record(snapshot.ackQueued);
    getMetrics().storageAckInflight.record(snapshot.ackInflight);
    getMetrics().syncBackgroundQueueDepth.record(snapshot.normalQueued + snapshot.backgroundQueued);
  }
}

export const externalStorePriorityScheduler = new StorePriorityScheduler();

export function getExternalStorePrioritySchedulerSnapshot(): StorePrioritySchedulerSnapshot {
  return externalStorePriorityScheduler.snapshot;
}
