import { performance } from 'node:perf_hooks';
import { getMetrics } from '@origintrail-official/dkg-core';
import { abortReason, throwIfAborted } from './abort-utils.js';
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
  backgroundReservedSlots: number;
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
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_ACK_RESERVED_SLOTS = 1;
const DEFAULT_BACKGROUND_RESERVED_SLOTS = 1;

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

  constructor(
    private readonly maxConcurrent = parsePositiveIntegerEnv('DKG_STORE_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT),
    private readonly ackReservedSlots = parsePositiveIntegerEnv(
      'DKG_STORE_ACK_RESERVED_SLOTS',
      DEFAULT_ACK_RESERVED_SLOTS,
    ),
    private readonly now = () => performance.now(),
    private readonly backgroundReservedSlots = parseNonNegativeIntegerEnv(
      'DKG_STORE_BACKGROUND_RESERVED_SLOTS',
      DEFAULT_BACKGROUND_RESERVED_SLOTS,
    ),
  ) {}

  get snapshot(): StorePrioritySchedulerSnapshot {
    return {
      ackInflight: this.ackInflight,
      normalInflight: this.normalInflight,
      backgroundInflight: this.backgroundInflight,
      ackQueued: this.queues.ack.length,
      normalQueued: this.queues.normal.length,
      backgroundQueued: this.queues.background.length,
      maxConcurrent: this.maxConcurrent,
      ackReservedSlots: this.effectiveAckReserve(),
      backgroundReservedSlots: this.effectiveBackgroundReserve(),
    };
  }

  async run<T>(
    priority: StoreWorkPriority | undefined,
    operation: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const normalizedPriority = priority ?? 'normal';
    throwIfAborted(signal);
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
          reject(abortReason(signal));
          this.observeDepths();
        }
      };
      entry.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
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

    const nonAckLimit = this.nonAckLimit();
    const nonAckInflight = this.normalInflight + this.backgroundInflight;
    if (nonAckInflight >= nonAckLimit) return false;
    if (priority === 'normal' && this.shouldHoldBackgroundFloor()) return false;
    return true;
  }

  private shouldHoldBackgroundFloor(): boolean {
    const backgroundReserve = this.effectiveBackgroundReserve();
    return backgroundReserve > 0 &&
      this.queues.background.length > 0 &&
      this.backgroundInflight < backgroundReserve;
  }

  private effectiveAckReserve(): number {
    return Math.min(this.ackReservedSlots, Math.max(0, this.maxConcurrent - 1));
  }

  private nonAckLimit(): number {
    return Math.max(1, this.maxConcurrent - this.effectiveAckReserve());
  }

  private effectiveBackgroundReserve(): number {
    return Math.min(this.backgroundReservedSlots, Math.max(0, this.nonAckLimit() - 1));
  }

  private start(entry: QueueEntry<unknown>): void {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
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
