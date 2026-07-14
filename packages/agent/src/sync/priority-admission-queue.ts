import { getMetrics } from '@origintrail-official/dkg-core';
import type { SyncPriorityClass, SyncSchedulerLane } from './policy.js';

export type PriorityAdmissionRelease = () => void;

export interface PriorityAdmissionScheduling {
  lane: SyncSchedulerLane;
  priority: number;
  priorityClass: SyncPriorityClass;
}

export interface PriorityAdmissionEntry<Payload> extends PriorityAdmissionScheduling {
  payload: Payload;
  ownerKey: string;
  sequence: number;
  enqueuedAt: number;
  now: () => number;
  agingThresholdMs: number;
}

interface InternalEntry<Payload> extends PriorityAdmissionEntry<Payload> {
  resolve: (release: PriorityAdmissionRelease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  settled: boolean;
}

export interface PriorityAdmission<Payload> {
  status: 'running' | 'queued';
  queuedBefore: number;
  sequence: number;
  release: Promise<PriorityAdmissionRelease>;
  entry: PriorityAdmissionEntry<Payload>;
}

export interface PriorityAdmissionQueueHooks<Payload> {
  canRun: (entry: PriorityAdmissionEntry<Payload>) => boolean;
  onStart: (entry: PriorityAdmissionEntry<Payload>) => PriorityAdmissionRelease;
  onDepthChange?: (depth: number) => void;
}

export interface PriorityAdmissionAcquireOptions<Payload> extends PriorityAdmissionScheduling {
  payload: Payload;
  ownerKey?: string;
  queueLimit: number;
  ownerQueueLimit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  agingThresholdMs: number;
  now?: () => number;
  /** Reuse an arrival sequence when a running stage hands off to a queued stage. */
  sequence?: number;
  /** A running-to-queued handoff may append before releasing its current slot. */
  allowQueueOverflow?: boolean;
  createBusyError: (reason: 'global_queue_full' | 'owner_queue_full') => Error;
  createDisplacedError: (entry: PriorityAdmissionEntry<Payload>) => Error;
  createTimeoutError?: () => Error;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? 'Sync admission aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

/**
 * Shared priority/FIFO admission queue. Scheduler decision metrics are events:
 * an aged start emits both `started` and `aged` intentionally.
 */
export class PriorityAdmissionQueue<Payload> {
  private readonly queue: InternalEntry<Payload>[] = [];
  private nextSequence = 0;

  constructor(private readonly hooks: PriorityAdmissionQueueHooks<Payload>) {}

  get length(): number {
    return this.queue.length;
  }

  entries(): readonly PriorityAdmissionEntry<Payload>[] {
    return this.queue;
  }

  countOwner(ownerKey: string): number {
    return this.queue.reduce((count, entry) => count + (entry.ownerKey === ownerKey ? 1 : 0), 0);
  }

  oldestAgeMs(now = Date.now()): number {
    if (this.queue.length === 0) return 0;
    return Math.max(0, now - Math.min(...this.queue.map((entry) => entry.enqueuedAt)));
  }

  acquire(options: PriorityAdmissionAcquireOptions<Payload>): PriorityAdmission<Payload> {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    const now = options.now ?? Date.now;
    const ownerKey = options.ownerKey ?? '';
    const queuedBefore = this.queue.length;
    const sequence = options.sequence ?? this.nextSequence++;
    const base: PriorityAdmissionEntry<Payload> = {
      payload: options.payload,
      ownerKey,
      lane: options.lane,
      priority: options.priority,
      priorityClass: options.priorityClass,
      sequence,
      enqueuedAt: now(),
      now,
      agingThresholdMs: options.agingThresholdMs,
    };

    if (this.hooks.canRun(base) && queuedBefore === 0) {
      this.recordDecision(base, 'started');
      return {
        status: 'running',
        queuedBefore,
        sequence,
        entry: base,
        release: Promise.resolve(this.start(base)),
      };
    }

    const globalFull = queuedBefore >= options.queueLimit;
    const ownerFull = options.ownerQueueLimit !== undefined
      && this.countOwner(ownerKey) >= options.ownerQueueLimit;
    if (globalFull || ownerFull) {
      const victim = this.queue
        .filter((entry) => (
          entry.priority < options.priority
          && (!ownerFull || entry.ownerKey === ownerKey)
        ))
        .sort((a, b) => a.priority - b.priority || b.sequence - a.sequence)[0];
      if (!victim && !options.allowQueueOverflow) {
        this.recordDecision(base, 'rejected');
        throw options.createBusyError(globalFull ? 'global_queue_full' : 'owner_queue_full');
      }
      if (victim) {
        this.remove(victim);
        this.recordDecision(victim, 'displaced');
        this.rejectOnce(victim, options.createDisplacedError(victim));
      }
    }

    let internal!: InternalEntry<Payload>;
    const release = new Promise<PriorityAdmissionRelease>((resolve, reject) => {
      internal = {
        ...base,
        resolve,
        reject,
        signal: options.signal,
        settled: false,
      };
      if (options.timeoutMs !== undefined) {
        internal.timer = setTimeout(() => {
          if (!this.remove(internal)) return;
          this.rejectOnce(
            internal,
            options.createTimeoutError?.() ?? options.createBusyError('global_queue_full'),
          );
        }, options.timeoutMs);
      }
      internal.onAbort = () => {
        if (!this.remove(internal)) return;
        this.recordDecision(internal, 'aborted');
        this.rejectOnce(internal, abortError(options.signal?.reason));
      };
      this.queue.push(internal);
      this.depthChanged();
      if (options.signal) {
        options.signal.addEventListener('abort', internal.onAbort, { once: true });
        if (options.signal.aborted) internal.onAbort();
      }
      this.pump();
    });
    return { status: 'queued', queuedBefore, sequence, entry: base, release };
  }

  pump(): void {
    for (;;) {
      const selected = this.selectNext();
      if (!selected) return;
      const [entry] = this.queue.splice(selected.index, 1);
      this.cleanup(entry);
      this.depthChanged();
      if (entry.settled) continue;
      entry.settled = true;
      const waitMs = Math.max(0, entry.now() - entry.enqueuedAt);
      getMetrics().syncSchedulerQueueWaitMs.record(waitMs, this.metricAttributes(entry));
      this.recordDecision(entry, 'started');
      if (selected.aged) this.recordDecision(entry, 'aged');
      entry.resolve(this.start(entry));
    }
  }

  private selectNext(): { index: number; aged: boolean } | undefined {
    const runnable = this.queue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.settled && this.hooks.canRun(entry));
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

  private start(entry: PriorityAdmissionEntry<Payload>): PriorityAdmissionRelease {
    const release = this.hooks.onStart(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      this.pump();
    };
  }

  private remove(entry: InternalEntry<Payload>): boolean {
    const index = this.queue.indexOf(entry);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.cleanup(entry);
    this.depthChanged();
    return true;
  }

  private rejectOnce(entry: InternalEntry<Payload>, error: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.reject(error);
  }

  private cleanup(entry: InternalEntry<Payload>): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  private depthChanged(): void {
    this.hooks.onDepthChange?.(this.queue.length);
  }

  private metricAttributes(entry: PriorityAdmissionScheduling) {
    return { lane: entry.lane, priority_class: entry.priorityClass };
  }

  private recordDecision(entry: PriorityAdmissionScheduling, outcome: string): void {
    getMetrics().syncSchedulerDecisionsTotal.add(1, {
      ...this.metricAttributes(entry),
      outcome,
    });
  }
}
