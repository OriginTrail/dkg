import { performance } from 'node:perf_hooks';
import {
  backpressureRegistry,
  getMetrics,
  ObservableScheduler,
  type SchedulerPressureThresholds,
  type SchedulerPressureTicket,
} from '@origintrail-official/dkg-core';
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
  agingThresholdMs: number;
}

interface InternalEntry<Payload> extends PriorityAdmissionEntry<Payload> {
  resolve: (release: PriorityAdmissionRelease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  settled: boolean;
  reserveForHandoff: boolean;
  queueLimit: number;
  ownerQueueLimit?: number;
}

export interface PriorityAdmission<Payload> {
  status: 'running' | 'queued';
  queuedBefore: number;
  sequence: number;
  release: Promise<PriorityAdmissionRelease>;
  entry: PriorityAdmissionEntry<Payload>;
  /** Atomically consume this running admission's reserved queue capacity. */
  handoff?: (options: PriorityAdmissionHandoffOptions<Payload>) => PriorityAdmission<Payload>;
}

export interface PriorityAdmissionQueueHooks<Payload> {
  canRun: (entry: PriorityAdmissionEntry<Payload>) => boolean;
  onStart: (entry: PriorityAdmissionEntry<Payload>) => PriorityAdmissionRelease;
  /** Undo capacity claimed by onStart when it throws before returning its release. */
  onStartFailureRollback?: (
    entry: PriorityAdmissionEntry<Payload>,
    error: unknown,
  ) => void;
  onDepthChange?: (depth: number) => void;
  /** Queue-wide elapsed-time source; production defaults to a monotonic clock. */
  now?: () => number;
  observability?: {
    scheduler: string;
    operation: (entry: PriorityAdmissionEntry<Payload>) => string;
    inflightLimit?: (entry: PriorityAdmissionEntry<Payload>) => number | null;
    thresholds?: SchedulerPressureThresholds;
    register?: boolean;
  };
}

export interface PriorityAdmissionAcquireOptions<Payload> extends PriorityAdmissionScheduling {
  payload: Payload;
  ownerKey?: string;
  queueLimit: number;
  ownerQueueLimit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  agingThresholdMs: number;
  /** Reserve one bounded queue slot if this running stage may hand off. */
  reserveForHandoff?: boolean;
  createBusyError: (reason: 'global_queue_full' | 'owner_queue_full') => Error;
  createDisplacedError: (entry: PriorityAdmissionEntry<Payload>) => Error;
  createTimeoutError?: () => Error;
}

export type PriorityAdmissionHandoffOptions<Payload> = Omit<
  PriorityAdmissionAcquireOptions<Payload>,
  'ownerKey' | 'queueLimit' | 'ownerQueueLimit' | 'reserveForHandoff'
>;

interface HandoffReservation {
  sequence: number;
  ownerKey: string;
  queueLimit: number;
  ownerQueueLimit?: number;
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
export class PriorityAdmissionQueue<Payload> extends ObservableScheduler {
  private readonly queue: InternalEntry<Payload>[] = [];
  private readonly handoffReservations = new Map<number, HandoffReservation>();
  private readonly pressureTickets = new WeakMap<PriorityAdmissionEntry<Payload>, SchedulerPressureTicket>();
  private readonly hooks: PriorityAdmissionQueueHooks<Payload>;
  private readonly now: () => number;
  private nextSequence = 0;
  private agedTurnOwed = false;

  constructor(hooks: PriorityAdmissionQueueHooks<Payload>) {
    const now = hooks.now ?? (() => performance.now());
    super({
      scheduler: hooks.observability?.scheduler ?? 'priority-admission',
      thresholds: hooks.observability?.thresholds,
      now,
    });
    this.hooks = hooks;
    this.now = now;
    if (hooks.observability?.register) backpressureRegistry.register(this);
  }

  get length(): number {
    return this.queue.length;
  }

  entries(): readonly PriorityAdmissionEntry<Payload>[] {
    return this.queue;
  }

  countOwner(ownerKey: string): number {
    return this.queue.reduce((count, entry) => count + (entry.ownerKey === ownerKey ? 1 : 0), 0);
  }

  private countReservedOwner(ownerKey: string): number {
    let count = 0;
    for (const reservation of this.handoffReservations.values()) {
      if (reservation.ownerKey === ownerKey) count += 1;
    }
    return count;
  }

  oldestAgeMs(): number {
    if (this.queue.length === 0) return 0;
    return Math.max(0, this.now() - Math.min(...this.queue.map((entry) => entry.enqueuedAt)));
  }

  acquire(options: PriorityAdmissionAcquireOptions<Payload>): PriorityAdmission<Payload> {
    return this.acquireInternal(options);
  }

  private acquireInternal(
    options: PriorityAdmissionAcquireOptions<Payload>,
    handoffReservation?: HandoffReservation,
  ): PriorityAdmission<Payload> {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    this.reconcileAgedTurnOwed();
    const ownerKey = handoffReservation?.ownerKey ?? options.ownerKey ?? '';
    const queuedBefore = this.queue.length;
    const sequence = handoffReservation?.sequence ?? this.nextSequence++;
    const base: PriorityAdmissionEntry<Payload> = {
      payload: options.payload,
      ownerKey,
      lane: options.lane,
      priority: options.priority,
      priorityClass: options.priorityClass,
      sequence,
      enqueuedAt: this.now(),
      agingThresholdMs: options.agingThresholdMs,
    };
    if (this.hooks.observability) {
      this.updatePressureCapacity({
        queueLimit: options.queueLimit,
        inflightLimit: this.hooks.observability.inflightLimit?.(base) ?? null,
        // Lanes here order one pool by priority, they do not partition it:
        // `queueLimit` bounds the whole queue (`globalFull` below) and `canRun`
        // bounds total inflight, so no lane has a private allocation to
        // publish. Declaring the model is what makes lane `state` classifiable
        // from queue depth at all — without it the depth branches see a null
        // ceiling, and only queue age or an already-taken rejection can move a
        // lane off `healthy`.
        capacityModel: 'shared',
      });
    }

    const reservedGlobal = this.handoffReservations.size;
    const reservedOwner = this.countReservedOwner(ownerKey);
    const reservationGlobalFull = Boolean(
      options.reserveForHandoff
      && queuedBefore + reservedGlobal >= options.queueLimit,
    );
    const reservationOwnerFull = Boolean(
      options.reserveForHandoff
      && options.ownerQueueLimit !== undefined
      && this.countOwner(ownerKey) + reservedOwner >= options.ownerQueueLimit,
    );
    const queuedRunnable = this.queue.some((entry) => (
      !entry.settled && this.hooks.canRun(entry)
    ));

    if (
      !handoffReservation
      && this.hooks.canRun(base)
      && !queuedRunnable
      && !reservationGlobalFull
      && !reservationOwnerFull
    ) {
      this.observePressureEnqueue(base);
      let release: PriorityAdmissionRelease;
      try {
        release = this.start(base, options);
      } catch (error) {
        this.observePressureReject(base, 'start_failed');
        throw error;
      }
      this.recordDecision(base, 'started');
      const admission: PriorityAdmission<Payload> = {
        status: 'running',
        queuedBefore,
        sequence,
        entry: base,
        release: Promise.resolve(release),
      };
      if (options.reserveForHandoff) {
        admission.handoff = (handoffOptions) => this.handoff(base, handoffOptions);
      }
      return admission;
    }

    const globalFull = queuedBefore + reservedGlobal >= options.queueLimit;
    const ownerFull = options.ownerQueueLimit !== undefined
      && this.countOwner(ownerKey) + reservedOwner >= options.ownerQueueLimit;
    if (!handoffReservation && (globalFull || ownerFull)) {
      const victim = this.selectDisplacementVictim(options, ownerKey, ownerFull);
      if (!victim) {
        this.recordDecision(base, 'rejected');
        this.observePressureReject(
          base,
          globalFull ? 'global_queue_full' : 'owner_queue_full',
        );
        throw options.createBusyError(globalFull ? 'global_queue_full' : 'owner_queue_full');
      }
      if (victim) {
        this.observePressureReject(victim, 'displaced');
        this.remove(victim);
        this.recordDecision(victim, 'displaced');
        this.rejectOnce(victim, options.createDisplacedError(victim));
      }
    }

    if (handoffReservation) {
      this.handoffReservations.delete(handoffReservation.sequence);
    }

    let internal!: InternalEntry<Payload>;
    const release = new Promise<PriorityAdmissionRelease>((resolve, reject) => {
      internal = {
        ...base,
        resolve,
        reject,
        signal: options.signal,
        settled: false,
        reserveForHandoff: options.reserveForHandoff ?? false,
        queueLimit: options.queueLimit,
        ownerQueueLimit: options.ownerQueueLimit,
      };
      if (options.timeoutMs !== undefined) {
        internal.timer = setTimeout(() => {
          if (!this.remove(internal)) return;
          this.observePressureReject(internal, 'queue_wait_timeout');
          this.recordDecision(internal, 'rejected');
          this.rejectOnce(
            internal,
            options.createTimeoutError?.() ?? options.createBusyError('global_queue_full'),
          );
        }, options.timeoutMs);
      }
      internal.onAbort = () => {
        if (!this.remove(internal)) return;
        this.observePressureCancel(internal, 'aborted');
        this.recordDecision(internal, 'aborted');
        this.rejectOnce(internal, abortError(options.signal?.reason));
      };
      this.observePressureEnqueue(internal);
      this.queue.push(internal);
      this.queueChanged();
      if (options.signal) {
        options.signal.addEventListener('abort', internal.onAbort, { once: true });
        if (options.signal.aborted) internal.onAbort();
      }
      this.pump();
    });
    const admission: PriorityAdmission<Payload> = {
      status: 'queued',
      queuedBefore,
      sequence,
      entry: base,
      release,
    };
    if (options.reserveForHandoff) {
      admission.handoff = (handoffOptions) => this.handoff(base, handoffOptions);
    }
    return admission;
  }

  pump(): void {
    for (;;) {
      const selected = this.selectNext();
      if (!selected) return;
      const [entry] = this.queue.splice(selected.index, 1);
      this.cleanup(entry);
      this.depthChanged();
      if (entry.settled) continue;
      let release: PriorityAdmissionRelease;
      try {
        release = this.start(entry, entry);
      } catch (error) {
        this.observePressureReject(entry, 'start_failed');
        this.recordDecision(entry, 'rejected');
        this.rejectOnce(entry, error instanceof Error ? error : new Error(String(error)));
        this.reconcileAgedTurnOwed();
        continue;
      }
      entry.settled = true;
      if (selected.servesDebt) this.agedTurnOwed = false;
      else if (selected.createsDebt) this.agedTurnOwed = true;
      this.reconcileAgedTurnOwed();
      const waitMs = Math.max(0, this.now() - entry.enqueuedAt);
      getMetrics().syncSchedulerQueueWaitMs.record(waitMs, this.metricAttributes(entry));
      this.recordDecision(entry, 'started');
      if (selected.aged) this.recordDecision(entry, 'aged');
      entry.resolve(release);
    }
  }

  private selectNext(): {
    index: number;
    aged: boolean;
    createsDebt: boolean;
    servesDebt: boolean;
  } | undefined {
    this.reconcileAgedTurnOwed();
    const now = this.now();
    const runnable = this.queue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !entry.settled && this.hooks.canRun(entry));
    if (runnable.length === 0) return undefined;
    const aged = runnable
      .filter(({ entry }) => this.isAged(entry, now))
      .sort((a, b) => a.entry.sequence - b.entry.sequence)[0];
    if (this.agedTurnOwed && aged) {
      return {
        index: aged.index,
        aged: true,
        createsDebt: false,
        servesDebt: true,
      };
    }
    const highest = runnable.sort((a, b) => (
      b.entry.priority - a.entry.priority
      || a.entry.sequence - b.entry.sequence
    ))[0];
    if (!highest) return undefined;
    const createsDebt = !this.agedTurnOwed && this.queue.some((entry) => (
      !entry.settled
      && entry !== highest.entry
      && entry.priority < highest.entry.priority
      && this.isAged(entry, now)
    ));
    return {
      index: highest.index,
      aged: this.isAged(highest.entry, now),
      createsDebt,
      servesDebt: false,
    };
  }

  private isAged(entry: PriorityAdmissionEntry<Payload>, now = this.now()): boolean {
    return now - entry.enqueuedAt >= entry.agingThresholdMs;
  }

  private reconcileAgedTurnOwed(): void {
    if (!this.agedTurnOwed) return;
    const now = this.now();
    if (!this.queue.some((entry) => !entry.settled && this.isAged(entry, now))) {
      this.agedTurnOwed = false;
    }
  }

  private selectDisplacementVictim(
    options: PriorityAdmissionAcquireOptions<Payload>,
    ownerKey: string,
    ownerFull: boolean,
  ): InternalEntry<Payload> | undefined {
    const candidates = this.queue.filter((entry) => (
      entry.priority < options.priority
      && (!ownerFull || entry.ownerKey === ownerKey)
    ));
    const now = this.now();
    const protectedAged = candidates
      .filter((entry) => this.isAged(entry, now))
      .sort((a, b) => a.sequence - b.sequence)[0];
    return candidates
      .filter((entry) => entry !== protectedAged)
      .sort((a, b) => a.priority - b.priority || b.sequence - a.sequence)[0];
  }

  private start(
    entry: PriorityAdmissionEntry<Payload>,
    options: Pick<PriorityAdmissionAcquireOptions<Payload>, 'reserveForHandoff' | 'queueLimit' | 'ownerQueueLimit'>,
  ): PriorityAdmissionRelease {
    let release: PriorityAdmissionRelease | undefined;
    try {
      release = this.hooks.onStart(entry);
      if (options.reserveForHandoff) {
        this.handoffReservations.set(entry.sequence, {
          sequence: entry.sequence,
          ownerKey: entry.ownerKey,
          queueLimit: options.queueLimit,
          ownerQueueLimit: options.ownerQueueLimit,
        });
      }
      this.observePressureStart(entry);
    } catch (error) {
      this.handoffReservations.delete(entry.sequence);
      try {
        if (release) release();
        else this.hooks.onStartFailureRollback?.(entry, error);
      } catch {
        // Preserve the admission failure; release is best-effort rollback here.
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handoffReservations.delete(entry.sequence);
      release();
      this.observePressureFinish(entry);
      this.pump();
    };
  }

  private handoff(
    entry: PriorityAdmissionEntry<Payload>,
    options: PriorityAdmissionHandoffOptions<Payload>,
  ): PriorityAdmission<Payload> {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    const reservation = this.handoffReservations.get(entry.sequence);
    if (!reservation || reservation.ownerKey !== entry.ownerKey) {
      throw new Error('Priority admission handoff requires an active reservation');
    }
    return this.acquireInternal({
      ...options,
      ownerKey: reservation.ownerKey,
      queueLimit: reservation.queueLimit,
      ownerQueueLimit: reservation.ownerQueueLimit,
      reserveForHandoff: false,
    }, reservation);
  }

  private remove(entry: InternalEntry<Payload>): boolean {
    const index = this.queue.indexOf(entry);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.cleanup(entry);
    this.queueChanged();
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

  private queueChanged(): void {
    this.reconcileAgedTurnOwed();
    this.depthChanged();
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

  private pressureWork(entry: PriorityAdmissionEntry<Payload>) {
    return {
      lane: entry.lane,
      operation: this.hooks.observability?.operation(entry) ?? entry.lane,
    };
  }

  private observePressureEnqueue(entry: PriorityAdmissionEntry<Payload>): void {
    if (!this.hooks.observability) return;
    this.pressureTickets.set(entry, this.pressureEnqueue(this.pressureWork(entry)));
  }

  private observePressureStart(entry: PriorityAdmissionEntry<Payload>): void {
    const ticket = this.pressureTickets.get(entry);
    if (ticket) this.pressureStart(ticket);
  }

  private observePressureReject(entry: PriorityAdmissionEntry<Payload>, reason: string): void {
    if (!this.hooks.observability) return;
    const ticket = this.pressureTickets.get(entry);
    if (ticket) {
      this.pressureRejectQueued(ticket, reason);
      this.pressureTickets.delete(entry);
      return;
    }
    this.pressureReject(this.pressureWork(entry), reason);
  }

  private observePressureCancel(entry: PriorityAdmissionEntry<Payload>, reason: string): void {
    const ticket = this.pressureTickets.get(entry);
    if (!ticket) return;
    this.pressureCancelQueued(ticket, reason);
    this.pressureTickets.delete(entry);
  }

  private observePressureFinish(entry: PriorityAdmissionEntry<Payload>): void {
    const ticket = this.pressureTickets.get(entry);
    if (!ticket) return;
    this.pressureFinish(ticket, 'released');
    this.pressureTickets.delete(entry);
  }
}
