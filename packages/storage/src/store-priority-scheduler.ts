import { performance } from 'node:perf_hooks';
import {
  backpressureRegistry,
  getMetrics,
  ObservableScheduler,
  type SchedulerPressureOutcome,
  type SchedulerPressureTicket,
} from '@origintrail-official/dkg-core';
import type { StorePressureSnapshot, StoreWorkPriority } from './triple-store.js';

export interface StorePrioritySchedulerSnapshot extends StorePressureSnapshot {
  ackInflight: number;
  healthInflight: number;
  normalInflight: number;
  backgroundInflight: number;
  ackQueued: number;
  healthQueued: number;
  normalQueued: number;
  backgroundQueued: number;
  maxConcurrent: number;
  ackReservedSlots: number;
  normalReservedSlots: number;
  healthReservedSlots: number;
  backgroundReservedSlots: number;
  ackQueueLimit: number;
  healthQueueLimit: number;
  normalQueueLimit: number;
  backgroundQueueLimit: number;
  queueWaitTimeoutMs: number;
  /**
   * Admission (V1) diagnostics. Every one of these is zero on the untagged
   * default path, which is exactly what the fast-path invariance test asserts:
   * a scheduler that never sees admission metadata never allocates per-store
   * state and never evaluates a single per-entry rule.
   */
  admissionTaggedQueued: number;
  admissionTaggedInflight: number;
  admissionTrackedStores: number;
  /** Cumulative per-entry admission evaluations. 0 ⇒ the fast path was taken. */
  admissionEvaluations: number;
  /** Cumulative same-domain shared bypasses granted ahead of a queued exclusive. */
  admissionBypassesGranted: number;
  /** Cumulative times the bounded bypass held shared work back for an exclusive. */
  admissionBoundHolds: number;
  /**
   * `run()` calls parked by a seal. Bounded: a held call has been ADMITTED, so
   * it counts against its lane's queue limit exactly like a queued one, which
   * is what guarantees every held call still fits when the seal commits.
   */
  admissionHeldRuns: number;
  admissionSealedStores: number;
  /**
   * Distinct generations with live execution permits. Operational answer to
   * "why is this restart still waiting" — a barrier that cannot start is
   * waiting on the work these permits represent.
   */
  admissionGenerationsInflight: number;
  /** Control barriers awaiting quiescence (they occupy no execution slot). */
  barrierPending: number;
  /** The single reserved controller slot: 0 or 1, and OUTSIDE `maxConcurrent`. */
  barrierInflight: number;
  /** Cumulative same-purpose barriers folded into an already-pending one. */
  barrierCoalesced: number;
  /**
   * Cumulative transitions that exceeded their bound. Non-zero is always a bug
   * worth alerting on — most often a transition issuing store work through the
   * scheduler, which deadlocks against its own barrier.
   */
  barrierTimeouts: number;
  /** Cumulative barrier wait. Proves a measured wait actually happened. */
  barrierWaitMs: number;
  /**
   * Execution-slot·milliseconds consumed by barriers while they were WAITING.
   * Structurally 0: a waiting barrier increments no inflight counter. Kept as a
   * live product of two measured quantities so that regressing the barrier into
   * an ordinary queued entry (which would pin a slot for the whole drain) makes
   * this non-zero instead of silently starving the lane it borrowed from.
   */
  barrierWaitOccupiedSlotMs: number;
}

/**
 * Exclusion mode of an admission-tagged entry.
 *
 * - `shared` — ordinary concurrent work inside its ordering domain.
 * - `exclusive` — serializes against every other entry of the same
 *   `(storeId, domain)`, e.g. an agent profile apply that rewrites a system
 *   record which other writers in that domain read back.
 * - `control-barrier` — an out-of-band control transition. It never enters an
 *   ordinary priority queue, cannot be rejected, and runs in the single
 *   reserved controller slot that sits OUTSIDE `maxConcurrent`.
 * - `store-wide-exclusive` — reset/restore/import. Blocks every tagged entry of
 *   that `storeId`, in every domain.
 */
export type StoreAdmissionMode =
  | 'shared'
  | 'exclusive'
  | 'control-barrier'
  | 'store-wide-exclusive';

/**
 * Opt-in admission metadata (V1).
 *
 * Entries without it are "untagged"/legacy and are NEVER gated by any of the
 * machinery below. That is not a courtesy: this scheduler is process-global and
 * sits in front of every store operation in the daemon, so the untagged path
 * must stay the pre-#2052 four-integer comparison it has always been.
 */
export interface StoreAdmissionV1 {
  /**
   * Opaque store-instance identity, compared by reference and never
   * serialized. Entries without one are untagged/legacy.
   */
  readonly storeId: object;
  /**
   * Child-generation permit this entry belongs to. The permit is acquired when
   * the entry STARTS and released when it finishes — never while it is merely
   * queued, because a seal blocks starts and a generation drain that also
   * waited on queued permits could never reach zero.
   */
  readonly generation: string;
  /**
   * Ordering domain. V1 uses `agents` (the default) for system-record and
   * agents/unknown-scope writes; unrelated trusted CG writes pick their own
   * domain so they keep running during an ordinary profile apply.
   */
  readonly domain?: string;
  readonly mode: StoreAdmissionMode;
}

import { StoreControlBarrierCoordinator } from './store-control-barrier-v1-internal.js';
import {
  StoreControlBarrierTimeoutError,
  type StoreControlBarrierBlockers,
  type StoreControlBarrierPhase,
  type StoreGenerationSeal,
} from './store-barrier-contract-v1-internal.js';
// Re-exported: these were declared here before the barrier subsystem moved out,
// and they are part of the package's published surface.
export {
  StoreControlBarrierTimeoutError,
  type StoreControlBarrierBlockers,
  type StoreControlBarrierPhase,
  type StoreGenerationSeal,
};

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
  healthReservedSlots?: number;
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
  pressureTicket: SchedulerPressureTicket;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  waitTimer?: ReturnType<typeof setTimeout>;
  /** V1 admission metadata; `undefined` for legacy/untagged entries. */
  admission?: StoreAdmissionV1;
  /**
   * Monotonic enqueue sequence, `0` when untagged. Used to answer "is this
   * shared entry LATER than the exclusive it would bypass?" exactly, including
   * across priority lanes where array order says nothing.
   *
   * Both this and {@link domainKey} are written unconditionally so tagged and
   * untagged entries share one object shape — a polymorphic entry literal on a
   * process-global hot path costs more than the two stores it would save.
   */
  admissionSeq: number;
  /** Resolved ordering domain; empty string when untagged. */
  domainKey: string;
}

/** Per-`(storeId, domain)` ordering state. Allocated only for tagged work. */
interface DomainAdmissionState {
  /** Tagged entries of this domain still sitting in a priority queue. */
  queued: number;
  sharedInflight: number;
  exclusiveInflight: number;
  /**
   * Queued exclusives in enqueue order (`admissionSeq` is monotonic, so `push`
   * keeps this sorted). `[0]` is the head the bounded bypass is measured
   * against; removals are rare (abort/timeout) and use a linear scan.
   */
  queuedExclusives: Array<{ seq: number; queuedAt: number }>;
  /** Shared starts granted ahead of the current head exclusive. */
  bypasses: number;
}

/** Per-store admission state. Allocated only for tagged work or a seal. */
interface StoreAdmissionState {
  taggedQueued: number;
  taggedInflight: number;
  storeWideExclusiveQueued: number;
  storeWideExclusiveInflight: number;
  /** Outstanding EXECUTION permits per generation. Drained by a barrier. */
  runningPermits: Map<string, number>;
  domains: Map<string, DomainAdmissionState>;
  /** Refcount: nested control transitions must not un-seal each other. */
  seals: number;
  /** `run()` calls parked while sealed. Off-queue, untimed, unrejectable. */
  heldRuns: HeldRun[];
}

interface HeldRun {
  release: () => void;
}

interface NonAckLanePolicy {
  /** Shared normal/background capacity after the ACK and health reservations. */
  totalLimit: number;
  /** Capacity protected from background work. */
  normalFloor: number;
  /** Normal ceiling while queued background work owns its floor. */
  normalLimitWhileBackgroundQueued: number;
  /** Background progress guarantee while background work is queued. */
  backgroundFloor: number;
  /** Background ceiling that protects the normal floor. */
  backgroundLimit: number;
}

interface LegacyStorePrioritySchedulerArguments {
  argumentCount: number;
  ackReservedSlots?: number;
  now?: () => number;
  backgroundReservedSlots?: number;
  queueLimits?: number | Partial<StorePriorityQueueLimits>;
  queueWaitTimeoutMs?: number;
  healthReservedSlots?: number;
}

// Four was the incident-tested stable ceiling on an 8 GiB host. With one ACK
// reserve and one health reserve this admits at most two ordinary/background
// operations by default, while still allowing operators to tune explicitly.
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_ACK_RESERVED_SLOTS = 1;
const DEFAULT_HEALTH_RESERVED_SLOTS = 1;
const DEFAULT_NORMAL_RESERVED_SLOTS = 1;
const DEFAULT_BACKGROUND_RESERVED_SLOTS = 1;
export const DEFAULT_STORE_QUEUE_LIMIT = 64;
export const DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS = 10_000;

/**
 * Ordering domain used when an entry omits `domain`. V1 routes system-record
 * and agents/unknown-scope writes here so that a profile apply serializes
 * against exactly the writers that can observe it.
 */
export const STORE_ADMISSION_DEFAULT_DOMAIN = 'agents';

/**
 * Bounded bypass, count arm. A queued exclusive would otherwise be starved by a
 * steady stream of same-domain shared work, and a strict barrier would collapse
 * throughput for the same reason. Eight is the point where the exclusive's
 * worst-case wait is still a fraction of the queue-wait timeout even when every
 * bypass runs to the stalled-active threshold.
 */
export const STORE_ADMISSION_SHARED_BYPASS_LIMIT = 8;

/**
 * Bounded bypass, time arm — whichever arm trips first wins. 250 ms keeps a
 * profile apply inside a single interactive turn even when the bypasses are
 * individually short enough that the count arm would never trip.
 *
 * No timer backs this: the bound only ever RESTRICTS shared work, and every
 * enqueue and every completion already calls `drain()`, so the deadline is
 * re-read on each selection under exactly the load that makes it matter.
 */
export const STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS = 250;

/** Seal generation recorded for a barrier that drains ALL tagged work. */

/**
 * Default bound on a whole control transition, wait plus execution.
 *
 * Deliberately DOUBLE the managed child's 30 s `readyTimeoutMs`, and that
 * relationship is the tuning constraint, not the number: this bound exists to
 * catch a circular wait, not to police a slow disk. A legitimate Oxigraph
 * restart is allowed to consume the child's full ready timeout, so anything at
 * or below it converts every genuinely slow restart into a spurious
 * `StoreControlBarrierTimeoutError` — a bound that fires on normal operation is
 * worse than no bound, because it trains operators to ignore the one signal
 * that means a transition has actually deadlocked.
 *
 * If `readyTimeoutMs` is raised, raise this with it. Tune via
 * `DKG_STORE_BARRIER_TIMEOUT_MS`, or per transition via `runControlBarrier`.
 */
export const DEFAULT_STORE_CONTROL_BARRIER_TIMEOUT_MS = 60_000;

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
    health: parsePositiveIntegerEnv('DKG_STORE_HEALTH_QUEUE_LIMIT', common),
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
    return { ack: limit, health: limit, normal: limit, background: limit };
  }
  return {
    ack: normalizeQueueLimit(configured.ack),
    health: normalizeQueueLimit(configured.health),
    normal: normalizeQueueLimit(configured.normal),
    background: normalizeQueueLimit(configured.background),
  };
}

function normalizeQueueLimit(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) > 0
    ? value as number
    : DEFAULT_STORE_QUEUE_LIMIT;
}

function normalizeStorePrioritySchedulerOptions(
  optionsOrMaxConcurrent: StorePrioritySchedulerOptions | number | undefined,
  legacy: LegacyStorePrioritySchedulerArguments,
): StorePrioritySchedulerOptions {
  const legacyCall = typeof optionsOrMaxConcurrent === 'number' || legacy.argumentCount > 1;
  if (!legacyCall) return optionsOrMaxConcurrent ?? {};

  return {
    maxConcurrent: typeof optionsOrMaxConcurrent === 'number'
      ? optionsOrMaxConcurrent
      : undefined,
    ackReservedSlots: legacy.ackReservedSlots,
    healthReservedSlots: legacy.healthReservedSlots,
    now: legacy.now,
    backgroundReservedSlots: legacy.backgroundReservedSlots,
    queueLimits: legacy.queueLimits,
    queueWaitTimeoutMs: legacy.queueWaitTimeoutMs,
  };
}

function normalizeNonAckLanePolicy(
  totalLimit: number,
  requestedNormalFloor: number,
  requestedBackgroundFloor: number,
): NonAckLanePolicy {
  const normalFloor = Math.min(
    Math.max(0, requestedNormalFloor),
    Math.max(0, totalLimit - 1),
  );
  const backgroundLimit = Math.max(1, totalLimit - normalFloor);
  const backgroundFloor = Math.min(
    Math.max(0, requestedBackgroundFloor),
    backgroundLimit,
    Math.max(0, totalLimit - 1),
  );
  const normalLimitWhileBackgroundQueued = totalLimit - backgroundFloor;
  return {
    totalLimit,
    normalFloor,
    normalLimitWhileBackgroundQueued,
    backgroundFloor,
    backgroundLimit,
  };
}

function metricOperation(operation: string): string {
  const trimmed = operation.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 80) || 'unknown';
}

export function storeWorkPriorityRank(priority: StoreWorkPriority): number {
  if (priority === 'ack') return 0;
  if (priority === 'health') return 1;
  if (priority === 'normal') return 2;
  return 3;
}

export class StorePriorityScheduler extends ObservableScheduler {
  private readonly queues: Record<StoreWorkPriority, Array<QueueEntry<unknown>>> = {
    ack: [],
    health: [],
    normal: [],
    background: [],
  };

  private ackInflight = 0;
  private healthInflight = 0;
  private normalInflight = 0;
  private backgroundInflight = 0;
  private readonly maxConcurrent: number;
  private readonly ackReservedSlots: number;
  private readonly healthReservedSlots: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly now: () => number;
  private readonly queueLimits: StorePriorityQueueLimits;
  private readonly nonAckLanePolicy: NonAckLanePolicy;

  /**
   * Number of admission-tagged entries currently sitting in the four priority
   * queues. This single integer is the whole fast path: while it is zero, no
   * queued entry can be gated by anything below, so selection stays the
   * pre-#2052 `shift()`. Inflight tagged work cannot change that verdict —
   * with nothing tagged queued there is nothing for it to block.
   */
  private taggedQueuedCount = 0;
  /**
   * Held `run()` calls per lane. A held call has been ADMITTED — it is
   * admitted-but-not-running work exactly like a queued one — so it counts
   * against the lane's queue limit. That accounting is what makes the release
   * path total: `queued + held <= limit` is invariant, so every held call still
   * fits when the seal commits and none can be rejected after its wait.
   */
  private readonly heldByLane: Record<StoreWorkPriority, number> = {
    ack: 0,
    health: 0,
    normal: 0,
    background: 0,
  };
  private admissionSeqCounter = 0;
  private readonly storeStates = new Map<object, StoreAdmissionState>();
  private sealedStoreCount = 0;
  private heldRunCount = 0;
  private admissionEvaluations = 0;
  private admissionBypassesGranted = 0;
  private admissionBoundHolds = 0;
  /**
   * Barrier lifecycle lives here, inflight accounting does not.
   *
   * The coordinator decides quiescence by asking THIS object for the counters
   * it already maintains for admission, so there is exactly one source of truth
   * for inflight. See `StoreBarrierHostV1`.
   */
  private readonly barrierCoordinator: StoreControlBarrierCoordinator;
  /**
   * Ordinary execution slots currently held by control-barrier work. A barrier
   * is routed away from the queues before any slot accounting, so this is 0 by
   * construction — it exists as a tripwire: if the routing ever regresses and a
   * barrier becomes an ordinary queued entry, it would pin a slot for the whole
   * drain and `barrierWaitOccupiedSlotMs` turns non-zero instead of the lane
   * silently losing capacity.
   */
  private barrierOccupiedSlots = 0;

  constructor(options?: StorePrioritySchedulerOptions);
  /** @deprecated Use the named options object. Retained for package compatibility. */
  constructor(
    maxConcurrent?: number,
    ackReservedSlots?: number,
    now?: () => number,
    backgroundReservedSlots?: number,
    queueLimits?: number | Partial<StorePriorityQueueLimits>,
    queueWaitTimeoutMs?: number,
    healthReservedSlots?: number,
  );
  constructor(
    optionsOrMaxConcurrent: StorePrioritySchedulerOptions | number = {},
    legacyAckReservedSlots?: number,
    legacyNow?: () => number,
    legacyBackgroundReservedSlots?: number,
    legacyQueueLimits?: number | Partial<StorePriorityQueueLimits>,
    legacyQueueWaitTimeoutMs?: number,
    legacyHealthReservedSlots?: number,
  ) {
    const options = normalizeStorePrioritySchedulerOptions(optionsOrMaxConcurrent, {
      argumentCount: arguments.length,
      ackReservedSlots: legacyAckReservedSlots,
      now: legacyNow,
      backgroundReservedSlots: legacyBackgroundReservedSlots,
      queueLimits: legacyQueueLimits,
      queueWaitTimeoutMs: legacyQueueWaitTimeoutMs,
      healthReservedSlots: legacyHealthReservedSlots,
    });
    const resolvedNow = options.now ?? (() => performance.now());
    const resolvedQueueWaitTimeoutMs = options.queueWaitTimeoutMs
      ?? parsePositiveIntegerEnv(
        'DKG_STORE_QUEUE_WAIT_TIMEOUT_MS',
        DEFAULT_STORE_QUEUE_WAIT_TIMEOUT_MS,
      );
    super({
      scheduler: 'store',
      now: resolvedNow,
      thresholds: {
        degradedQueueAgeMs: Math.max(1, Math.floor(resolvedQueueWaitTimeoutMs / 2)),
        stalledActiveAgeMs: 30_000,
      },
    });
    this.maxConcurrent = options.maxConcurrent
      ?? parsePositiveIntegerEnv('DKG_STORE_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT);
    const requestedAckReservedSlots = options.ackReservedSlots
      ?? parsePositiveIntegerEnv('DKG_STORE_ACK_RESERVED_SLOTS', DEFAULT_ACK_RESERVED_SLOTS);
    this.ackReservedSlots = Math.min(
      requestedAckReservedSlots,
      Math.max(0, this.maxConcurrent - 1),
    );
    const requestedHealthReservedSlots = options.healthReservedSlots
      ?? parseNonNegativeIntegerEnv(
        'DKG_STORE_HEALTH_RESERVED_SLOTS',
        DEFAULT_HEALTH_RESERVED_SLOTS,
      );
    this.healthReservedSlots = Math.min(
      requestedHealthReservedSlots,
      Math.max(0, this.maxConcurrent - this.ackReservedSlots - 1),
    );
    const requestedNormalFloor = options.normalReservedSlots
      ?? parseNonNegativeIntegerEnv('DKG_STORE_NORMAL_RESERVED_SLOTS', DEFAULT_NORMAL_RESERVED_SLOTS);
    const requestedBackgroundFloor = options.backgroundReservedSlots
      ?? parseNonNegativeIntegerEnv(
        'DKG_STORE_BACKGROUND_RESERVED_SLOTS',
        DEFAULT_BACKGROUND_RESERVED_SLOTS,
      );
    this.nonAckLanePolicy = normalizeNonAckLanePolicy(
      Math.max(1, this.maxConcurrent - this.ackReservedSlots - this.healthReservedSlots),
      requestedNormalFloor,
      requestedBackgroundFloor,
    );
    this.queueWaitTimeoutMs = resolvedQueueWaitTimeoutMs;
    const barrierTimeoutMs = parsePositiveIntegerEnv(
      'DKG_STORE_BARRIER_TIMEOUT_MS',
      DEFAULT_STORE_CONTROL_BARRIER_TIMEOUT_MS,
    );
    this.now = resolvedNow;
    // The coordinator asks this scheduler for inflight rather than tracking it:
    // one source of truth for the counters quiescence is decided from.
    this.barrierCoordinator = new StoreControlBarrierCoordinator(
      {
        now: () => this.now(),
        sealStoreGeneration: (storeId, generation) =>
          this.sealStoreGeneration(storeId, generation),
        untaggedInflight: () =>
          Math.max(
            0,
            this.ackInflight + this.healthInflight + this.normalInflight
              + this.backgroundInflight - this.countTaggedInflight(),
          ),
        taggedInflightForStore: (storeId) =>
          this.storeStates.get(storeId)?.taggedInflight ?? 0,
        generationsInflight: () => this.countGenerationsInflight(),
        heldRunCount: () => this.heldRunCount,
        occupiedSlots: () => this.barrierOccupiedSlots,
        observeDepths: () => this.observeDepths(),
      },
      barrierTimeoutMs,
    );
    this.queueLimits = normalizeQueueLimits(options.queueLimits ?? resolveQueueLimitsFromEnv());
    const nonAckLimit = Math.max(1, this.maxConcurrent - this.ackReservedSlots);
    this.updatePressureCapacity({
      queueLimit: Object.values(this.queueLimits).reduce((sum, value) => sum + value, 0),
      inflightLimit: this.maxConcurrent,
      lanes: {
        ack: {
          queueLimit: this.queueLimits.ack,
          inflightLimit: this.maxConcurrent,
        },
        health: {
          queueLimit: this.queueLimits.health,
          inflightLimit: nonAckLimit,
        },
        normal: {
          queueLimit: this.queueLimits.normal,
          inflightLimit: this.nonAckLanePolicy.totalLimit,
        },
        background: {
          queueLimit: this.queueLimits.background,
          inflightLimit: this.nonAckLanePolicy.backgroundLimit,
        },
      },
    });
  }

  get snapshot(): StorePrioritySchedulerSnapshot {
    // Read once: the getter builds a fresh object, so six reads meant six
    // allocations for one snapshot.
    const barrier = this.barrierCoordinator.metrics;
    return {
      ackInflight: this.ackInflight,
      healthInflight: this.healthInflight,
      normalInflight: this.normalInflight,
      backgroundInflight: this.backgroundInflight,
      ackQueued: this.queues.ack.length,
      healthQueued: this.queues.health.length,
      normalQueued: this.queues.normal.length,
      backgroundQueued: this.queues.background.length,
      maxConcurrent: this.maxConcurrent,
      ackReservedSlots: this.ackReservedSlots,
      healthReservedSlots: this.healthReservedSlots,
      normalReservedSlots: this.nonAckLanePolicy.normalFloor,
      backgroundReservedSlots: this.nonAckLanePolicy.backgroundFloor,
      ackQueueLimit: this.queueLimits.ack,
      healthQueueLimit: this.queueLimits.health,
      normalQueueLimit: this.queueLimits.normal,
      backgroundQueueLimit: this.queueLimits.background,
      queueWaitTimeoutMs: this.queueWaitTimeoutMs,
      admissionTaggedQueued: this.taggedQueuedCount,
      admissionTaggedInflight: this.countTaggedInflight(),
      admissionTrackedStores: this.storeStates.size,
      admissionEvaluations: this.admissionEvaluations,
      admissionBypassesGranted: this.admissionBypassesGranted,
      admissionBoundHolds: this.admissionBoundHolds,
      admissionHeldRuns: this.heldRunCount,
      admissionSealedStores: this.sealedStoreCount,
      admissionGenerationsInflight: this.countGenerationsInflight(),
      barrierPending: barrier.pending,
      barrierInflight: barrier.inflight,
      barrierCoalesced: barrier.coalesced,
      barrierTimeouts: barrier.timeouts,
      barrierWaitMs: barrier.waitMs,
      barrierWaitOccupiedSlotMs: barrier.waitOccupiedSlotMs,
    };
  }

  /**
   * @param admission Optional V1 admission metadata. Omitting it (the default
   * for every pre-#2052 caller) keeps the untagged path bit-for-bit unchanged.
   * A `control-barrier` admission is routed out of the priority queues entirely
   * — `priority` and `signal` are ignored for it, by design.
   */
  async run<T>(
    priority: StoreWorkPriority | undefined,
    operation: string,
    work: () => Promise<T>,
    signal?: AbortSignal,
    admission?: StoreAdmissionV1,
  ): Promise<T> {
    const normalizedPriority = priority ?? 'normal';
    // Routed FIRST: a control transition must not be rejectable by an
    // already-aborted caller signal any more than by queue capacity.
    if (admission !== undefined && admission.mode === 'control-barrier') {
      return await this.barrierCoordinator.enqueue(
        admission.storeId,
        operation,
        work,
        admission.generation,
      );
    }
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
    }
    // Capacity is checked BEFORE the seal is consulted, and held calls count
    // toward it. Parking first and bounding never would make "held, never
    // rejected" true only WHILE held: an unbounded park converts into a
    // `queue_full` burst the moment the seal commits, so a caller would wait out
    // the entire transition only to be rejected anyway. Rejecting here instead
    // fails fast, bounds the parked population, and — because `queued + held`
    // can never exceed the limit — guarantees the release itself cannot reject.
    if (
      this.queues[normalizedPriority].length + this.heldByLane[normalizedPriority]
      >= this.queueLimits[normalizedPriority]
    ) {
      const error = new StoreSchedulerBusyError('queue_full', normalizedPriority, operation);
      this.pressureReject(
        { lane: normalizedPriority, operation },
        error.reason,
      );
      this.observeRejection(error);
      throw error;
    }
    // Admitted under the bound above, so from here the call is guaranteed to
    // run or to be cancelled by its own caller — never rejected for capacity.
    if (admission !== undefined && this.isSealed(admission.storeId)) {
      return await this.holdRun(normalizedPriority, operation, work, signal, admission);
    }
    // Both fields are written unconditionally to keep one entry shape; the
    // sequence counter only advances for tagged work so untagged traffic cannot
    // exhaust it.
    if (admission !== undefined) this.admissionSeqCounter += 1;
    const admissionSeq = admission === undefined ? 0 : this.admissionSeqCounter;
    const domainKey = admission === undefined
      ? ''
      : (admission.domain ?? STORE_ADMISSION_DEFAULT_DOMAIN);
    return new Promise<T>((resolve, reject) => {
      const pressureTicket = this.pressureEnqueue({
        lane: normalizedPriority,
        operation,
      });
      const entry: QueueEntry<T> = {
        priority: normalizedPriority,
        operation,
        queuedAt: this.now(),
        pressureTicket,
        work,
        resolve,
        reject,
        signal,
        admission,
        admissionSeq,
        domainKey,
      };
      const onAbort = () => {
        if (this.removeQueued(entry as QueueEntry<unknown>)) {
          this.cleanupQueuedEntry(entry as QueueEntry<unknown>);
          this.pressureCancelQueued(entry.pressureTicket, 'aborted');
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
        this.pressureRejectQueued(entry.pressureTicket, error.reason);
        this.observeRejection(error);
        reject(error);
        this.observeDepths();
        this.drain();
      }, this.queueWaitTimeoutMs);
      if (typeof entry.waitTimer.unref === 'function') entry.waitTimer.unref();
      if (admission !== undefined) this.attachQueuedAdmission(entry as QueueEntry<unknown>);
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
    const priorities: StoreWorkPriority[] = ['ack', 'health', 'normal', 'background'];
    priorities.sort((a, b) => storeWorkPriorityRank(a) - storeWorkPriorityRank(b));
    // The entire admission extension hangs off these two integer comparisons.
    // With nothing tagged queued AND no transition pending, every entry below is
    // provably ungated, so the head of a runnable lane is unconditionally the
    // winner — exactly the pre-#2052 selection, with no per-entry scan and no
    // allocation. The barrier term is what lets a transition stop untagged
    // traffic, which carries no store identity to gate on.
    const admissionActive =
      this.taggedQueuedCount > 0 || this.barrierCoordinator.hasPendingBarriers();
    for (const priority of priorities) {
      const queue = this.queues[priority];
      if (queue.length === 0) continue;
      if (!this.canStart(priority)) continue;
      if (!admissionActive) return queue.shift();
      // Tagged path: take the first ADMISSIBLE entry. Blocked entries are
      // skipped in place rather than dequeued, which preserves FIFO within
      // `(priority, domain)` while letting unrelated domains past.
      for (let index = 0; index < queue.length; index += 1) {
        const entry = queue[index] as QueueEntry<unknown>;
        if (!this.isEntryAdmissible(entry)) continue;
        queue.splice(index, 1);
        this.detachQueuedAdmission(entry);
        return entry;
      }
    }
    return undefined;
  }

  private canStart(priority: StoreWorkPriority): boolean {
    const totalInflight = this.ackInflight + this.healthInflight + this.normalInflight + this.backgroundInflight;
    if (totalInflight >= this.maxConcurrent) return false;
    if (priority === 'ack') return true;

    const nonAckLimit = Math.max(1, this.maxConcurrent - this.ackReservedSlots);
    const nonAckInflight = this.healthInflight + this.normalInflight + this.backgroundInflight;
    if (nonAckInflight >= nonAckLimit) return false;
    if (priority === 'health') return true;

    const lanePolicy = this.nonAckLanePolicy;
    const ordinaryInflight = this.normalInflight + this.backgroundInflight;
    if (ordinaryInflight >= lanePolicy.totalLimit) return false;
    if (priority === 'background' && this.backgroundInflight >= lanePolicy.backgroundLimit) {
      return false;
    }
    if (priority === 'background' || this.queues.background.length === 0) return true;
    return this.backgroundInflight >= lanePolicy.backgroundFloor &&
      this.normalInflight < lanePolicy.normalLimitWhileBackgroundQueued;
  }

  private start(entry: QueueEntry<unknown>): void {
    this.cleanupQueuedEntry(entry);
    if (entry.admission !== undefined) this.acquireRunningAdmission(entry);
    this.increment(entry.priority);
    const startedAt = this.now();
    this.pressureStart(entry.pressureTicket);
    const waitMs = Math.max(0, startedAt - entry.queuedAt);
    const attributes = {
      priority: entry.priority,
      operation: metricOperation(entry.operation),
    };
    getMetrics().storeSchedulerActive.add(1, attributes);
    this.observeQueueWait(entry, waitMs);
    this.observeDepths();

    let result: Promise<unknown>;
    try {
      result = entry.work();
    } catch (err) {
      result = Promise.reject(err);
    }

    let pressureOutcome: SchedulerPressureOutcome = 'completed';
    result
      .then((value) => {
        this.observeDuration(entry, startedAt, 'ok');
        entry.resolve(value);
      })
      .catch((err) => {
        pressureOutcome = 'failed';
        this.observeDuration(entry, startedAt, 'error');
        entry.reject(err);
      })
      .finally(() => {
        getMetrics().storeSchedulerActive.add(-1, attributes);
        this.pressureFinish(entry.pressureTicket, pressureOutcome);
        // Released BEFORE `drain()` so the generation permit this entry held is
        // already gone when a waiting barrier and the blocked entries behind an
        // exclusive are re-evaluated in the same turn.
        if (entry.admission !== undefined) this.releaseRunningAdmission(entry);
        this.decrement(entry.priority);
        // Evaluated only after BOTH counters are settled. Barrier readiness
        // derives untagged inflight as `total - tagged`, so pumping between the
        // two updates would make a finishing tagged entry look like a phantom
        // untagged one and stall the transition. Untagged completions must pump
        // too — the gate now waits on them.
        this.barrierCoordinator.pump();
        this.observeDepths();
        this.drain();
      });
  }

  private removeQueued(entry: QueueEntry<unknown>): boolean {
    const queue = this.queues[entry.priority];
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    this.detachQueuedAdmission(entry);
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
    else if (priority === 'health') this.healthInflight += 1;
    else if (priority === 'normal') this.normalInflight += 1;
    else this.backgroundInflight += 1;
  }

  private decrement(priority: StoreWorkPriority): void {
    if (priority === 'ack') this.ackInflight = Math.max(0, this.ackInflight - 1);
    else if (priority === 'health') this.healthInflight = Math.max(0, this.healthInflight - 1);
    else if (priority === 'normal') this.normalInflight = Math.max(0, this.normalInflight - 1);
    else this.backgroundInflight = Math.max(0, this.backgroundInflight - 1);
  }

  private observeQueueWait(entry: QueueEntry<unknown>, waitMs: number): void {
    getMetrics().storeSchedulerQueueWaitMs.record(waitMs, {
      priority: entry.priority,
      operation: metricOperation(entry.operation),
    });
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

  /**
   * Reads the three depths straight off their sources instead of materializing
   * `this.snapshot`. The recorded values are identical; the reason to stop
   * building a snapshot here is that this runs on every enqueue, start, finish,
   * abort and timeout, so the snapshot's new admission fields would have turned
   * a fixed per-operation cost into a growing one for callers that never use
   * admission at all.
   */
  private observeDepths(): void {
    getMetrics().storageAckPriorityQueueDepth.record(this.queues.ack.length);
    getMetrics().storageAckInflight.record(this.ackInflight);
    getMetrics().syncBackgroundQueueDepth.record(
      this.queues.normal.length + this.queues.background.length,
    );
  }

  // ---------------------------------------------------------------------------
  // Admission V1 — generation permits, ordering domains, control barrier.
  //
  // Everything below is reachable ONLY from an entry that carries admission
  // metadata, from an explicit control call, or from behind the
  // `taggedQueuedCount === 0` guard in `nextRunnable()`.
  // ---------------------------------------------------------------------------

  /**
   * Seal a store's generation. Synchronous and atomic: it takes effect before
   * this call returns, has no rejection path, and is not subject to queue
   * capacity or caller abort. While sealed, no tagged entry for `storeId`
   * starts and every new tagged `run()` for it is HELD off-queue.
   *
   * Seals are refcounted, so a control transition nested inside another does
   * not un-seal the outer one when it commits.
   *
   * `generation` is a LABEL, carried on the returned seal and reported through
   * `admissionGenerationsInflight` for diagnostics. It is deliberately not an
   * enforcement key: the hold is `seals > 0` and the drain is this store's whole
   * `taggedInflight`, both generation-blind, because the transition this seals
   * is a child-process restart and the child it stops serves every generation.
   * Narrowing either one to the sealed generation would be strictly weaker, and
   * — since generations are decimal counters — trivially bypassable by any
   * caller that can spell the next one.
   */
  sealStoreGeneration(storeId: object, generation: string): StoreGenerationSeal {
    const state = this.getOrCreateStoreState(storeId);
    state.seals += 1;
    if (state.seals === 1) this.sealedStoreCount += 1;
    let committed = false;
    const seal: StoreGenerationSeal = {
      storeId,
      generation,
      commit: () => {
        if (committed) return;
        committed = true;
        state.seals -= 1;
        if (state.seals === 0) {
          this.sealedStoreCount -= 1;
          this.releaseHeldRuns(state);
        }
        this.releaseStoreStateIfIdle(storeId, state);
        this.observeDepths();
        this.drain();
      },
    };
    this.drain();
    return seal;
  }

  /**
   * Run a control transition behind a barrier for `storeId`.
   *
   * The barrier seals the store for the duration, waits for the store to
   * quiesce, then runs `transition` in the single reserved controller slot that
   * sits OUTSIDE `maxConcurrent`. It is
   * never queued, never rejected by capacity or abort, and — critically — holds
   * ZERO execution slots while it waits, so the drain it is waiting for is not
   * competing with the barrier itself for capacity.
   *
   * Concurrent barriers with the same `(storeId, purpose)` coalesce into one:
   * later callers receive the FIRST barrier's promise and their own
   * `transition` is never invoked. That is the intended semantics for an
   * idempotent control transition; do not use one purpose for two different
   * transitions.
   *
   * The transition owns the store exclusively, and that is enforced rather than
   * assumed: from the moment a barrier is pending, ALL untagged work is held in
   * its queue and all tagged work for this store is held off-queue, and the
   * transition does not start until both populations have drained. Untagged
   * traffic is the load-bearing half — it is 100% of today's store traffic, and
   * it is precisely what would otherwise keep being dispatched into a child
   * that is being stopped.
   *
   * The cost is that the transition must NOT re-enter `run()` at all for the
   * duration — with tagged admission for this `storeId` (held by its own seal)
   * or untagged (held by its own barrier). It does not need to: it already owns
   * the store, so it issues its work directly.
   *
   * Re-entering anyway is a circular wait, so the whole transition is bounded
   * and rejects with {@link StoreControlBarrierTimeoutError} — naming that cause
   * and reporting what it was blocked on — rather than hanging silently. The
   * bound is deliberately NOT exact re-entry detection: telling "the transition
   * called us" apart from "an unrelated caller is legitimately waiting" needs
   * `AsyncLocalStorage`, which on Node 22 latches async_hooks on for the rest of
   * the process once entered. Taxing every async operation in the daemon
   * forever, to diagnose a caller bug faster, is the wrong trade for a
   * process-global scheduler.
   *
   * @param timeoutMs Overrides the default bound for this transition.
   */
  runControlBarrier<T>(
    storeId: object,
    purpose: string,
    transition: () => Promise<T>,
    generation?: string,
    timeoutMs?: number,
  ): Promise<T> {
    return this.barrierCoordinator.enqueue(
      storeId,
      purpose,
      transition,
      generation,
      timeoutMs,
    );
  }

  private isSealed(storeId: object): boolean {
    const state = this.storeStates.get(storeId);
    return state !== undefined && state.seals > 0;
  }

  private getOrCreateStoreState(storeId: object): StoreAdmissionState {
    const existing = this.storeStates.get(storeId);
    if (existing !== undefined) return existing;
    const created: StoreAdmissionState = {
      taggedQueued: 0,
      taggedInflight: 0,
      storeWideExclusiveQueued: 0,
      storeWideExclusiveInflight: 0,
      runningPermits: new Map(),
      domains: new Map(),
      seals: 0,
      heldRuns: [],
    };
    this.storeStates.set(storeId, created);
    return created;
  }

  private getOrCreateDomainState(
    state: StoreAdmissionState,
    domainKey: string,
  ): DomainAdmissionState {
    const existing = state.domains.get(domainKey);
    if (existing !== undefined) return existing;
    const created: DomainAdmissionState = {
      queued: 0,
      sharedInflight: 0,
      exclusiveInflight: 0,
      queuedExclusives: [],
      bypasses: 0,
    };
    state.domains.set(domainKey, created);
    return created;
  }

  /** Drops per-store state the moment it stops carrying any obligation. */
  private releaseStoreStateIfIdle(storeId: object, state: StoreAdmissionState): void {
    if (state.taggedQueued > 0 || state.taggedInflight > 0) return;
    if (state.seals > 0 || state.heldRuns.length > 0) return;
    if (state.domains.size > 0 || state.runningPermits.size > 0) return;
    this.storeStates.delete(storeId);
  }

  private countTaggedInflight(): number {
    let total = 0;
    for (const state of this.storeStates.values()) total += state.taggedInflight;
    return total;
  }

  private countGenerationsInflight(): number {
    let total = 0;
    for (const state of this.storeStates.values()) total += state.runningPermits.size;
    return total;
  }

  private attachQueuedAdmission(entry: QueueEntry<unknown>): void {
    const admission = entry.admission;
    if (admission === undefined) return;
    this.taggedQueuedCount += 1;
    const state = this.getOrCreateStoreState(admission.storeId);
    state.taggedQueued += 1;
    if (admission.mode === 'store-wide-exclusive') {
      // Store-wide work deliberately takes no domain: it blocks every domain,
      // so ordering it against one of them would be meaningless.
      state.storeWideExclusiveQueued += 1;
      return;
    }
    const domain = this.getOrCreateDomainState(state, entry.domainKey);
    domain.queued += 1;
    if (admission.mode === 'exclusive') {
      domain.queuedExclusives.push({ seq: entry.admissionSeq, queuedAt: entry.queuedAt });
    }
  }

  /** Called exactly once per tagged entry when it leaves a priority queue. */
  private detachQueuedAdmission(entry: QueueEntry<unknown>): void {
    const admission = entry.admission;
    if (admission === undefined) return;
    this.taggedQueuedCount -= 1;
    const state = this.storeStates.get(admission.storeId);
    if (state === undefined) return;
    state.taggedQueued -= 1;
    if (admission.mode === 'store-wide-exclusive') {
      state.storeWideExclusiveQueued -= 1;
      this.releaseStoreStateIfIdle(admission.storeId, state);
      return;
    }
    const domain = state.domains.get(entry.domainKey);
    if (domain !== undefined) {
      domain.queued -= 1;
      if (admission.mode === 'exclusive') {
        const index = domain.queuedExclusives.findIndex((held) => held.seq === entry.admissionSeq);
        if (index >= 0) domain.queuedExclusives.splice(index, 1);
      }
      this.releaseDomainStateIfIdle(state, entry.domainKey, domain);
    }
    this.releaseStoreStateIfIdle(admission.storeId, state);
  }

  private releaseDomainStateIfIdle(
    state: StoreAdmissionState,
    domainKey: string,
    domain: DomainAdmissionState,
  ): void {
    if (domain.queued > 0 || domain.sharedInflight > 0 || domain.exclusiveInflight > 0) return;
    state.domains.delete(domainKey);
  }

  private acquireRunningAdmission(entry: QueueEntry<unknown>): void {
    const admission = entry.admission;
    if (admission === undefined) return;
    const state = this.getOrCreateStoreState(admission.storeId);
    state.taggedInflight += 1;
    // The generation permit is held for EXECUTION only — see StoreAdmissionV1.
    state.runningPermits.set(
      admission.generation,
      (state.runningPermits.get(admission.generation) ?? 0) + 1,
    );
    if (admission.mode === 'control-barrier') {
      // Unreachable while `run()` routes barriers away from the queues; see the
      // `barrierOccupiedSlots` tripwire comment on the field declaration.
      this.barrierOccupiedSlots += 1;
      return;
    }
    if (admission.mode === 'store-wide-exclusive') {
      state.storeWideExclusiveInflight += 1;
      return;
    }
    const domain = this.getOrCreateDomainState(state, entry.domainKey);
    if (admission.mode === 'exclusive') {
      domain.exclusiveInflight += 1;
      // The exclusive won its slot, so the bound that protected it resets for
      // whichever exclusive is queued behind it.
      domain.bypasses = 0;
      return;
    }
    domain.sharedInflight += 1;
    if (domain.queuedExclusives.length > 0) {
      domain.bypasses += 1;
      this.admissionBypassesGranted += 1;
    }
  }

  private releaseRunningAdmission(entry: QueueEntry<unknown>): void {
    const admission = entry.admission;
    if (admission === undefined) return;
    const state = this.storeStates.get(admission.storeId);
    if (state === undefined) return;
    state.taggedInflight -= 1;
    const permits = (state.runningPermits.get(admission.generation) ?? 1) - 1;
    if (permits > 0) state.runningPermits.set(admission.generation, permits);
    else state.runningPermits.delete(admission.generation);
    if (admission.mode === 'control-barrier') {
      this.barrierOccupiedSlots -= 1;
    } else if (admission.mode === 'store-wide-exclusive') {
      state.storeWideExclusiveInflight -= 1;
    } else {
      const domain = state.domains.get(entry.domainKey);
      if (domain !== undefined) {
        if (admission.mode === 'exclusive') domain.exclusiveInflight -= 1;
        else domain.sharedInflight -= 1;
        this.releaseDomainStateIfIdle(state, entry.domainKey, domain);
      }
    }
    this.releaseStoreStateIfIdle(admission.storeId, state);
    // Barriers are pumped by the caller, after the lane counter is also
    // decremented — see the note in `start()`.
  }

  /**
   * The only per-entry rule evaluation in the scheduler. Reached only from the
   * tagged path in `nextRunnable()`.
   */
  private isEntryAdmissible(entry: QueueEntry<unknown>): boolean {
    // Counted BEFORE the untagged early return, on purpose: this counter is the
    // fast path's witness, so it has to rise if selection ever walks entries
    // that the `taggedQueuedCount` guard should have kept it away from — not
    // merely if a tagged entry is examined.
    this.admissionEvaluations += 1;
    const admission = entry.admission;
    if (admission === undefined) {
      // Untagged legacy entries carry no store identity, so a pending
      // transition cannot rule them out — and must therefore assume the worst.
      // This is the whole reason the barrier can claim exclusive ownership: the
      // transition IS the store's stop-and-restart, and dispatching ordinary
      // queries into a child being SIGTERM'd (or into no listener at all) turns
      // a bounded control window into a burst of connection errors across every
      // unrelated lane. Holding them in the queue instead converts that into
      // ordinary backpressure — and the existing wait timer still bounds it,
      // with a typed retryable rejection rather than a transport failure.
      return !this.barrierCoordinator.hasPendingBarriers();
    }
    const state = this.storeStates.get(admission.storeId);
    if (state === undefined) return true;
    // Sealed: the transition owns this store until it commits.
    if (state.seals > 0) return false;
    if (admission.mode === 'store-wide-exclusive') {
      // Reset/restore/import waits for every tagged entry of this store, in
      // every domain. Untagged entries carry no store identity and so cannot be
      // attributed to it — they are not waited on.
      return state.taggedInflight === 0;
    }
    // A store-wide transition that is merely QUEUED still freezes the store:
    // letting ordinary work past it here is exactly how it would be starved.
    if (state.storeWideExclusiveInflight > 0 || state.storeWideExclusiveQueued > 0) return false;
    const domain = state.domains.get(entry.domainKey);
    if (domain === undefined) return true;
    if (admission.mode === 'exclusive') {
      // Exclusive means an empty domain, not an empty scheduler: other domains
      // and untagged work keep running straight through a profile apply.
      return domain.sharedInflight === 0 && domain.exclusiveInflight === 0;
    }
    if (domain.exclusiveInflight > 0) return false;
    const head = domain.queuedExclusives[0];
    if (head === undefined) return true;
    // Only work that arrived AFTER the exclusive can be asked to wait for it;
    // an entry already queued ahead of it keeps its place.
    if (entry.admissionSeq < head.seq) return true;
    if (
      domain.bypasses < STORE_ADMISSION_SHARED_BYPASS_LIMIT &&
      this.now() - head.queuedAt < STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS
    ) {
      return true;
    }
    // Bound exhausted. This is priority-blind on purpose: ACK and health work
    // in the SAME domain would otherwise be an unbounded starvation channel.
    this.admissionBoundHolds += 1;
    return false;
  }

  /**
   * Parks a tagged `run()` while its store is sealed. Held entries occupy no
   * queue slot and carry no wait timer, which is what makes them immune to
   * `queue_full` and `queue_wait_timeout`. Caller abort is still honoured — a
   * caller that has given up must not be resurrected by the commit.
   */
  private holdRun<T>(
    priority: StoreWorkPriority,
    operation: string,
    work: () => Promise<T>,
    signal: AbortSignal | undefined,
    admission: StoreAdmissionV1,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const state = this.getOrCreateStoreState(admission.storeId);
      let settled = false;
      let abortListener: (() => void) | undefined;
      const record: HeldRun = { release: () => undefined };
      const detach = (): void => {
        if (signal !== undefined && abortListener !== undefined) {
          signal.removeEventListener('abort', abortListener);
        }
        const index = state.heldRuns.indexOf(record);
        if (index >= 0) {
          state.heldRuns.splice(index, 1);
          this.heldRunCount -= 1;
          // Released before the re-entry below re-checks capacity, so the slot
          // this call already owns is the one it reclaims.
          this.heldByLane[priority] -= 1;
        }
      };
      record.release = () => {
        if (settled) return;
        settled = true;
        detach();
        // Re-enters `run()` so a seal taken again in the meantime holds this
        // call once more, and so the queue-limit check and the wait timer both
        // apply from the moment it actually joins a queue.
        this.run(priority, operation, work, signal, admission).then(resolve, reject);
      };
      if (signal !== undefined) {
        abortListener = () => {
          if (settled) return;
          settled = true;
          detach();
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
          this.releaseStoreStateIfIdle(admission.storeId, state);
          this.observeDepths();
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }
      state.heldRuns.push(record);
      this.heldRunCount += 1;
      this.heldByLane[priority] += 1;
      this.observeDepths();
    });
  }

  private releaseHeldRuns(state: StoreAdmissionState): void {
    if (state.heldRuns.length === 0) return;
    // Snapshot first: `release()` re-enters `run()`, which can re-hold onto the
    // same array if another seal is still open.
    const released = state.heldRuns.slice();
    for (const record of released) record.release();
  }

}

export const externalStorePriorityScheduler = new StorePriorityScheduler();
backpressureRegistry.register(externalStorePriorityScheduler);

export function getExternalStorePrioritySchedulerSnapshot(): StorePrioritySchedulerSnapshot {
  return externalStorePriorityScheduler.snapshot;
}
