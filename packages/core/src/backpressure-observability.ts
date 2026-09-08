import { getMetrics } from './telemetry-api.js';

export type BackpressureState = 'healthy' | 'degraded' | 'saturated' | 'stalled';
export type SchedulerPressureOutcome = 'completed' | 'failed' | 'cancelled' | 'released';

/**
 * How a scheduler's capacity is divided between its lanes.
 *
 * `partitioned` (the default): every lane owns a private allocation, declared
 * in `lanes`, and fills independently of its neighbours —
 * `StorePriorityScheduler`. Nothing validates the scheduler-level `queueLimit`
 * against the lane allocations: a scheduler may publish their sum (the store
 * scheduler does), or cap its total below what its lanes could hold between
 * them, and `sumLaneLimits` falls back to the sum when no scheduler ceiling is
 * published at all. So read a lane's own limit for lane pressure and the
 * scheduler's for the rollup, and derive neither from the other.
 *
 * `shared`: every lane draws on ONE pool bounded by the scheduler-level
 * `queueLimit`/`inflightLimit`. There is no private allocation to declare, so a
 * lane's ceiling *is* the pool's ceiling, lane ceilings must never be summed,
 * and the depth a lane's queued work is waiting behind is the pool's, not that
 * lane's own share of it — `PriorityAdmissionQueue`.
 */
export type SchedulerLaneCapacityModel = 'partitioned' | 'shared';

interface SchedulerPressureCapacityLimits {
  queueLimit?: number | null;
  inflightLimit?: number | null;
}

/**
 * The two models are mutually exclusive at the type level rather than by
 * convention: a shared pool has no private allocations, so it cannot carry
 * `lanes`. Omitting `capacityModel` keeps the pre-existing `partitioned` shape,
 * so every current caller is unaffected.
 */
export type SchedulerPressureCapacity =
  | (SchedulerPressureCapacityLimits & {
    capacityModel?: 'partitioned';
    /**
     * Private per-lane allocations. Independent of the scheduler-level limits
     * above — see {@link SchedulerLaneCapacityModel}; they are not summed and
     * not validated against them.
     */
    lanes?: Record<string, {
      queueLimit?: number | null;
      inflightLimit?: number | null;
    }>;
  })
  | (SchedulerPressureCapacityLimits & {
    capacityModel: 'shared';
    /** A shared pool has no private allocation to declare. */
    lanes?: never;
  });

export interface SchedulerPressureThresholds {
  /** Queue age that turns otherwise-low utilization into degraded pressure. */
  degradedQueueAgeMs?: number;
  /** Active-work age that indicates an admitted operation may be stuck. */
  stalledActiveAgeMs?: number;
  /** Fraction of a bounded queue that marks a lane as degraded. */
  degradedQueueUtilization?: number;
  /** Keep a recent admission rejection visible as saturation for this long. */
  rejectionStateWindowMs?: number;
}

export interface SchedulerPressureWork {
  lane: string;
  operation: string;
}

export interface SchedulerPressureTicket {
  readonly id: number;
}

export interface BackpressureOperationSummary {
  operation: string;
  count: number;
  oldestAgeMs: number;
}

export interface BackpressureLaneSnapshot {
  lane: string;
  state: BackpressureState;
  /**
   * How to read `queueLimit` on this row. Under `shared` it is the
   * scheduler-wide pool this lane draws on rather than a private allocation —
   * the same number on every lane, never to be summed.
   *
   * Optional so an existing hand-built `BackpressureSource` still satisfies
   * this type; absent means `partitioned`. `SchedulerPressureTracker` always
   * emits it.
   */
  capacityModel?: SchedulerLaneCapacityModel;
  /** This lane's own backlog. The attribution signal: whose work is waiting. */
  queued: number;
  /**
   * The depth `state` was actually classified against, and the numerator that
   * goes with `queueLimit` — equal to `queued` for a private allocation, and
   * the pool's whole depth for a shared one. Read this, not `queued`, to
   * compute utilization, so a consumer never has to special-case the model.
   *
   * Optional for the same backward-compatibility reason as `capacityModel`;
   * absent means `queued`.
   */
  pressureQueued?: number;
  queueLimit: number | null;
  /** This lane's own admitted work. The attribution signal, like `queued`. */
  inflight: number;
  /**
   * The admitted count that goes with `inflightLimit`: this lane's own under a
   * private allocation, and on a shared row **the pool's occupancy, always** —
   * unlike `pressureQueued`, which falls back to the lane's own backlog where
   * no depth was classified (an idle lane, or a pool with no ceiling). The
   * asymmetry is deliberate: `pressureQueued` must equal the classifier's
   * numerator or a row contradicts its own state, while no branch reads
   * `inflight` or `inflightLimit` — this pair is reported, never judged — so on
   * a shared row the ratio is a pool ratio by construction. Gating it on queued
   * work would make the series step 0 -> N on an unrelated enqueue with no
   * change in real concurrency. Absent means `inflight`.
   */
  pressureInflight?: number;
  inflightLimit: number | null;
  /** All contributing pressure signals on shared-pool rows; age remains visible at saturation. */
  stateReasons?: Array<'depth' | 'age' | 'rejection' | 'active_age'>;
  oldestQueuedAgeMs: number;
  oldestActiveAgeMs: number;
  queuedOperations: BackpressureOperationSummary[];
  activeOperations: BackpressureOperationSummary[];
  events: Record<string, number>;
  rejectedTotal: number;
  rejectedByReason: Record<string, number>;
  /** Age of the latest rejection; safe for monotonic or epoch-based clocks. */
  lastRejectedAgeMs: number | null;
}

export interface BackpressureSnapshot {
  scheduler: string;
  state: BackpressureState;
  /**
   * How this scheduler divides capacity between its lanes. It is a **scheduler**
   * invariant — every lane of one scheduler shares it — so read it here; the
   * copy on each lane row is derived, and exists so a single row still explains
   * its own `queueLimit` when it travels alone (a log line, one metric series).
   *
   * Optional so a hand-built `BackpressureSource` still satisfies this type;
   * absent means `partitioned`.
   */
  capacityModel?: SchedulerLaneCapacityModel;
  totals: {
    queued: number;
    queueLimit: number | null;
    inflight: number;
    inflightLimit: number | null;
    oldestQueuedAgeMs: number;
    oldestActiveAgeMs: number;
    rejectedTotal: number;
  };
  lanes: BackpressureLaneSnapshot[];
}

export interface BackpressureSource {
  readonly backpressureId: string;
  getBackpressureSnapshot(): BackpressureSnapshot;
}

export interface BackpressureRegistrySnapshot {
  capturedAt: string;
  state: BackpressureState;
  schedulers: BackpressureSnapshot[];
  failures: Array<{ scheduler: string; error: string }>;
}

interface PressureWorkRecord {
  id: number;
  lane: string;
  operation: string;
  queuedAt: number;
  startedAt?: number;
}

interface LaneRuntime {
  events: Map<string, number>;
  rejectedByReason: Map<string, number>;
  lastRejectedAt: number | null;
}

const DEFAULT_DEGRADED_QUEUE_AGE_MS = 5_000;
const DEFAULT_STALLED_ACTIVE_AGE_MS = 30_000;
const DEFAULT_DEGRADED_QUEUE_UTILIZATION = 0.75;
const DEFAULT_REJECTION_STATE_WINDOW_MS = 60_000;
const MAX_OPERATION_SUMMARIES = 8;

const STATE_RANK: Record<BackpressureState, number> = {
  healthy: 0,
  degraded: 1,
  saturated: 2,
  stalled: 3,
};

function maxState(a: BackpressureState, b: BackpressureState): BackpressureState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

function normalizeLimit(value: number | null | undefined): number | null {
  return Number.isFinite(value) && (value as number) >= 0 ? value as number : null;
}

/**
 * Keep metric/log dimensions bounded and strip payload-like punctuation.
 * Callers should still pass static operation names rather than graph, peer, or
 * job identifiers.
 */
export function normalizeBackpressureLabel(value: string, fallback = 'unknown'): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 80) || fallback;
}

function mapToRecord(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function operationSummaries(
  records: Iterable<PressureWorkRecord>,
  timestamp: (record: PressureWorkRecord) => number,
  now: number,
): BackpressureOperationSummary[] {
  const byOperation = new Map<string, { count: number; oldestAt: number }>();
  for (const record of records) {
    const existing = byOperation.get(record.operation);
    const at = timestamp(record);
    if (existing) {
      existing.count += 1;
      existing.oldestAt = Math.min(existing.oldestAt, at);
    } else {
      byOperation.set(record.operation, { count: 1, oldestAt: at });
    }
  }
  return [...byOperation.entries()]
    .map(([operation, value]) => ({
      operation,
      count: value.count,
      oldestAgeMs: Math.max(0, Math.floor(now - value.oldestAt)),
    }))
    .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs || b.count - a.count || a.operation.localeCompare(b.operation))
    .slice(0, MAX_OPERATION_SUMMARIES);
}

export interface SchedulerPressureTrackerOptions {
  scheduler: string;
  capacity?: SchedulerPressureCapacity;
  thresholds?: SchedulerPressureThresholds;
  now?: () => number;
}

/**
 * Scheduling-policy-neutral lifecycle tracker.
 *
 * Queue implementations call the five transition methods at their existing
 * admission boundaries. The tracker owns timings, state classification,
 * bounded metrics, and diagnostic snapshots, but never decides which work may
 * run. All observability calls are fail-open so instrumentation cannot change
 * scheduler behaviour.
 */
export class SchedulerPressureTracker {
  readonly scheduler: string;

  private readonly queued = new Map<number, PressureWorkRecord>();
  private readonly active = new Map<number, PressureWorkRecord>();
  private readonly lanes = new Map<string, LaneRuntime>();
  private readonly now: () => number;
  private readonly thresholds: Required<SchedulerPressureThresholds>;
  private capacity: SchedulerPressureCapacity;
  private nextTicketId = 1;

  constructor(options: SchedulerPressureTrackerOptions) {
    this.scheduler = normalizeBackpressureLabel(options.scheduler, 'scheduler');
    this.capacity = options.capacity ?? {};
    this.now = options.now ?? Date.now;
    this.thresholds = {
      degradedQueueAgeMs:
        options.thresholds?.degradedQueueAgeMs ?? DEFAULT_DEGRADED_QUEUE_AGE_MS,
      stalledActiveAgeMs:
        options.thresholds?.stalledActiveAgeMs ?? DEFAULT_STALLED_ACTIVE_AGE_MS,
      degradedQueueUtilization:
        options.thresholds?.degradedQueueUtilization ?? DEFAULT_DEGRADED_QUEUE_UTILIZATION,
      rejectionStateWindowMs:
        options.thresholds?.rejectionStateWindowMs ?? DEFAULT_REJECTION_STATE_WINDOW_MS,
    };
  }

  updateCapacity(capacity: SchedulerPressureCapacity): void {
    this.capacity = capacity;
  }

  enqueue(work: SchedulerPressureWork): SchedulerPressureTicket {
    const record: PressureWorkRecord = {
      id: this.nextTicketId++,
      lane: normalizeBackpressureLabel(work.lane, 'default'),
      operation: normalizeBackpressureLabel(work.operation),
      queuedAt: this.now(),
    };
    this.queued.set(record.id, record);
    this.recordEvent(record.lane, 'enqueued');
    return { id: record.id };
  }

  start(ticket: SchedulerPressureTicket): void {
    const record = this.queued.get(ticket.id);
    if (!record) return;
    this.queued.delete(ticket.id);
    record.startedAt = this.now();
    this.active.set(ticket.id, record);
    this.recordEvent(record.lane, 'started');
    this.safeMetric(() => getMetrics().backpressureQueueWaitMs.record(
      Math.max(0, record.startedAt! - record.queuedAt),
      { scheduler: this.scheduler, lane: record.lane },
    ));
  }

  reject(work: SchedulerPressureWork, reason: string): void {
    const lane = normalizeBackpressureLabel(work.lane, 'default');
    this.recordRejection(lane, reason);
  }

  rejectQueued(ticket: SchedulerPressureTicket, reason: string): void {
    const record = this.queued.get(ticket.id);
    if (!record) return;
    this.queued.delete(ticket.id);
    this.recordRejection(record.lane, reason);
  }

  cancelQueued(ticket: SchedulerPressureTicket, reason = 'cancelled'): void {
    const record = this.queued.get(ticket.id);
    if (!record) return;
    this.queued.delete(ticket.id);
    this.recordEvent(record.lane, 'cancelled', reason);
  }

  finish(ticket: SchedulerPressureTicket, outcome: SchedulerPressureOutcome): void {
    const record = this.active.get(ticket.id);
    if (!record) return;
    this.active.delete(ticket.id);
    const finishedAt = this.now();
    this.recordEvent(record.lane, outcome);
    this.safeMetric(() => getMetrics().backpressureActiveDurationMs.record(
      Math.max(0, finishedAt - (record.startedAt ?? finishedAt)),
      {
        scheduler: this.scheduler,
        lane: record.lane,
        outcome,
      },
    ));
  }

  snapshot(): BackpressureSnapshot {
    const now = this.now();
    const laneNames = new Set<string>([
      ...this.lanes.keys(),
      ...Object.keys(this.capacity.lanes ?? {}),
      ...[...this.queued.values()].map((entry) => entry.lane),
      ...[...this.active.values()].map((entry) => entry.lane),
    ]);
    const snapshots = [...laneNames]
      .sort()
      .map((lane) => this.laneSnapshot(lane, now));
    const totals = {
      queued: snapshots.reduce((sum, lane) => sum + lane.queued, 0),
      queueLimit: normalizeLimit(this.capacity.queueLimit)
        ?? this.sumLaneLimits('queueLimit', snapshots),
      inflight: snapshots.reduce((sum, lane) => sum + lane.inflight, 0),
      inflightLimit: normalizeLimit(this.capacity.inflightLimit)
        ?? this.sumLaneLimits('inflightLimit', snapshots),
      oldestQueuedAgeMs: Math.max(0, ...snapshots.map((lane) => lane.oldestQueuedAgeMs)),
      oldestActiveAgeMs: Math.max(0, ...snapshots.map((lane) => lane.oldestActiveAgeMs)),
      rejectedTotal: snapshots.reduce((sum, lane) => sum + lane.rejectedTotal, 0),
    };
    let state = snapshots.reduce<BackpressureState>(
      (current, lane) => maxState(current, lane.state),
      'healthy',
    );
    if (
      totals.queueLimit !== null
      && totals.queueLimit > 0
      && totals.queued >= totals.queueLimit
    ) {
      state = maxState(state, 'saturated');
    } else if (
      totals.queueLimit !== null
      && totals.queueLimit > 0
      && totals.queued / totals.queueLimit >= this.thresholds.degradedQueueUtilization
    ) {
      state = maxState(state, 'degraded');
    }
    if (totals.oldestQueuedAgeMs >= this.thresholds.degradedQueueAgeMs) {
      state = maxState(state, 'degraded');
    }
    if (totals.oldestActiveAgeMs >= this.thresholds.stalledActiveAgeMs) {
      state = maxState(state, 'stalled');
    }
    return {
      scheduler: this.scheduler,
      state,
      capacityModel: this.capacity.capacityModel === 'shared' ? 'shared' : 'partitioned',
      totals,
      lanes: snapshots,
    };
  }

  private runtimeFor(lane: string): LaneRuntime {
    let runtime = this.lanes.get(lane);
    if (!runtime) {
      runtime = {
        events: new Map(),
        rejectedByReason: new Map(),
        lastRejectedAt: null,
      };
      this.lanes.set(lane, runtime);
    }
    return runtime;
  }

  private recordEvent(lane: string, event: string, reason?: string): void {
    const runtime = this.runtimeFor(lane);
    runtime.events.set(event, (runtime.events.get(event) ?? 0) + 1);
    this.safeMetric(() => getMetrics().backpressureEventsTotal.add(1, {
      scheduler: this.scheduler,
      lane,
      event,
      ...(reason ? { reason: normalizeBackpressureLabel(reason) } : {}),
    }));
  }

  private recordRejection(lane: string, reason: string): void {
    const normalizedReason = normalizeBackpressureLabel(reason, 'rejected');
    const runtime = this.runtimeFor(lane);
    runtime.rejectedByReason.set(
      normalizedReason,
      (runtime.rejectedByReason.get(normalizedReason) ?? 0) + 1,
    );
    runtime.lastRejectedAt = this.now();
    this.recordEvent(lane, 'rejected', normalizedReason);
  }

  /**
   * Everything the capacity model decides, in one place: which ceilings apply
   * to a lane, what depth its state is measured against, and whether depth
   * pressure applies at all. `laneSnapshot` stays a model-agnostic classifier,
   * so adding a model means extending this descriptor rather than editing the
   * classifier's branches.
   */
  private laneCapacityFor(lane: string, laneQueued: number): {
    /** Reported ceilings, whether or not depth classification applies. */
    capacityModel: SchedulerLaneCapacityModel;
    queueLimit: number | null;
    inflightLimit: number | null;
    /**
     * The depth and the ceiling the lane's state is classified against, or
     * `null` when no depth applies to it at all — an unbounded queue, or a lane
     * with an empty backlog. Carrying the pair together is what keeps "does
     * depth apply" from being inferred from a nullable ceiling.
     */
    depthPressure: { queued: number; limit: number } | null;
  } {
    const shared = this.capacity.capacityModel === 'shared';
    const queueLimit = shared
      ? normalizeLimit(this.capacity.queueLimit)
      : normalizeLimit(this.capacity.lanes?.[lane]?.queueLimit);
    // A lane with nothing waiting is not held back by a full queue, whoever
    // filled it. Scoped to `shared` deliberately: under `partitioned` the
    // comparisons imply it only for a positive utilization threshold, and
    // `degradedQueueUtilization` is caller-supplied public API — at 0 the old
    // branch read `0 / limit >= 0` as degraded on an idle lane. Applying the
    // guard there would have been a real behaviour change for a private
    // allocation, so it is not applied there.
    const depthApplies = queueLimit !== null && queueLimit > 0 && (!shared || laneQueued > 0);
    return {
      capacityModel: shared ? 'shared' : 'partitioned',
      queueLimit,
      inflightLimit: shared
        ? normalizeLimit(this.capacity.inflightLimit)
        : normalizeLimit(this.capacity.lanes?.[lane]?.inflightLimit),
      // Depth is measured against whatever the lane's ceiling bounds: its own
      // backlog when the allocation is private, the whole pool when the ceiling
      // is shared.
      depthPressure: depthApplies && queueLimit !== null
        ? { queued: shared ? this.queued.size : laneQueued, limit: queueLimit }
        : null,
    };
  }

  private laneSnapshot(lane: string, now: number): BackpressureLaneSnapshot {
    const runtime = this.runtimeFor(lane);
    const queued = [...this.queued.values()].filter((entry) => entry.lane === lane);
    const active = [...this.active.values()].filter((entry) => entry.lane === lane);
    const {
      capacityModel,
      queueLimit,
      inflightLimit,
      depthPressure,
    } = this.laneCapacityFor(lane, queued.length);
    // Exactly the depth the classifier used, so `pressureQueued / queueLimit`
    // is always the utilization behind this lane's own state. A lane no depth
    // applies to reports its own backlog rather than a pool it is not being
    // held back by — publishing the pool there would read as full utilization
    // on a lane that is `healthy` and waiting for nothing.
    const pressureQueued = depthPressure?.queued ?? queued.length;
    // The concurrency ceiling on a shared row is the pool's, so the count
    // beside it must be too. The classifier reads neither — this pair is
    // reported, not judged — but a row that pairs a lane-local count with a
    // pool ceiling tells an operator the pool is idle while it is the reason
    // nothing drains.
    const pressureInflight = capacityModel === 'shared' ? this.active.size : active.length;
    const oldestQueuedAgeMs = queued.length === 0
      ? 0
      : Math.max(...queued.map((entry) => Math.max(0, Math.floor(now - entry.queuedAt))));
    const oldestActiveAgeMs = active.length === 0
      ? 0
      : Math.max(...active.map((entry) => Math.max(
          0,
          Math.floor(now - (entry.startedAt ?? now)),
        )));
    const activeAgeStalled = oldestActiveAgeMs >= this.thresholds.stalledActiveAgeMs;
    const recentlyRejected = runtime.lastRejectedAt !== null
      && now - runtime.lastRejectedAt <= this.thresholds.rejectionStateWindowMs;
    const queueAgeDegraded = oldestQueuedAgeMs >= this.thresholds.degradedQueueAgeMs;
    const depthSaturated = depthPressure !== null && depthPressure.queued >= depthPressure.limit;
    const depthDegraded = depthPressure !== null
      && depthPressure.queued / depthPressure.limit >= this.thresholds.degradedQueueUtilization;
    const stateReasons: NonNullable<BackpressureLaneSnapshot['stateReasons']> = [];
    if (activeAgeStalled) stateReasons.push('active_age');
    if (recentlyRejected) stateReasons.push('rejection');
    if (queueAgeDegraded) stateReasons.push('age');
    if (depthSaturated || depthDegraded) stateReasons.push('depth');
    let state: BackpressureState = 'healthy';
    if (activeAgeStalled) {
      state = 'stalled';
    } else if (depthSaturated || recentlyRejected) {
      state = 'saturated';
    } else if (queueAgeDegraded || depthDegraded) {
      state = 'degraded';
    }
    return {
      lane,
      state,
      ...(capacityModel === 'shared' ? { stateReasons } : {}),
      capacityModel,
      queued: queued.length,
      pressureQueued,
      queueLimit,
      inflight: active.length,
      pressureInflight,
      inflightLimit,
      oldestQueuedAgeMs,
      oldestActiveAgeMs,
      queuedOperations: operationSummaries(queued, (entry) => entry.queuedAt, now),
      activeOperations: operationSummaries(
        active,
        (entry) => entry.startedAt ?? now,
        now,
      ),
      events: mapToRecord(runtime.events),
      rejectedTotal: [...runtime.rejectedByReason.values()].reduce((sum, value) => sum + value, 0),
      rejectedByReason: mapToRecord(runtime.rejectedByReason),
      lastRejectedAgeMs: runtime.lastRejectedAt === null
        ? null
        : Math.max(0, Math.floor(now - runtime.lastRejectedAt)),
    };
  }

  /**
   * Reached only when the scheduler publishes no ceiling of its own — which is
   * also the only case in which a `shared` lane has none either, since a shared
   * lane's ceiling resolves from that same value. A pool ceiling can therefore
   * never become a summand here, which it must not: summing it would report N×
   * the real capacity and silence the rollup's own saturation branch.
   */
  private sumLaneLimits(
    field: 'queueLimit' | 'inflightLimit',
    lanes: BackpressureLaneSnapshot[],
  ): number | null {
    if (lanes.length === 0 || lanes.some((lane) => lane[field] === null)) return null;
    return lanes.reduce((sum, lane) => sum + (lane[field] ?? 0), 0);
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch {
      // Metrics are strictly fail-open.
    }
  }
}

/**
 * Base class for in-memory schedulers. Subclasses retain complete ownership of
 * queue ordering, admission, coalescing, and release semantics and call these
 * protected lifecycle methods at their existing boundaries.
 */
export abstract class ObservableScheduler implements BackpressureSource {
  protected readonly pressure: SchedulerPressureTracker;

  protected constructor(options: SchedulerPressureTrackerOptions) {
    this.pressure = new SchedulerPressureTracker(options);
  }

  get backpressureId(): string {
    return this.pressure.scheduler;
  }

  getBackpressureSnapshot(): BackpressureSnapshot {
    return this.pressure.snapshot();
  }

  protected updatePressureCapacity(capacity: SchedulerPressureCapacity): void {
    this.pressure.updateCapacity(capacity);
  }

  protected pressureEnqueue(work: SchedulerPressureWork): SchedulerPressureTicket {
    return this.pressure.enqueue(work);
  }

  protected pressureStart(ticket: SchedulerPressureTicket): void {
    this.pressure.start(ticket);
  }

  protected pressureReject(work: SchedulerPressureWork, reason: string): void {
    this.pressure.reject(work, reason);
  }

  protected pressureRejectQueued(ticket: SchedulerPressureTicket, reason: string): void {
    this.pressure.rejectQueued(ticket, reason);
  }

  protected pressureCancelQueued(ticket: SchedulerPressureTicket, reason?: string): void {
    this.pressure.cancelQueued(ticket, reason);
  }

  protected pressureFinish(
    ticket: SchedulerPressureTicket,
    outcome: SchedulerPressureOutcome,
  ): void {
    this.pressure.finish(ticket, outcome);
  }
}

export class BackpressureRegistry {
  private readonly sources = new Map<string, BackpressureSource>();

  register(source: BackpressureSource): () => void {
    const id = normalizeBackpressureLabel(source.backpressureId, 'scheduler');
    const existing = this.sources.get(id);
    if (existing && existing !== source) {
      throw new Error(`Backpressure source "${id}" is already registered`);
    }
    this.sources.set(id, source);
    return () => {
      if (this.sources.get(id) === source) this.sources.delete(id);
    };
  }

  capture(): BackpressureRegistrySnapshot {
    const schedulers: BackpressureSnapshot[] = [];
    const failures: Array<{ scheduler: string; error: string }> = [];
    for (const [id, source] of [...this.sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        schedulers.push(source.getBackpressureSnapshot());
      } catch (error) {
        failures.push({
          scheduler: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      capturedAt: new Date().toISOString(),
      state: schedulers.reduce<BackpressureState>(
        (current, scheduler) => maxState(current, scheduler.state),
        'healthy',
      ),
      schedulers,
      failures,
    };
  }
}

export const backpressureRegistry = new BackpressureRegistry();

export function recordBackpressureSnapshotMetrics(snapshot: BackpressureSnapshot): void {
  const metrics = getMetrics();
  const record = (
    lane: string,
    values: {
      queued: number;
      pressureQueued?: number;
      queueLimit: number | null;
      inflight: number;
      pressureInflight?: number;
      inflightLimit: number | null;
      oldestQueuedAgeMs: number;
      oldestActiveAgeMs: number;
    },
  ) => {
    const attributes = { scheduler: snapshot.scheduler, lane };
    metrics.backpressureQueueDepth.record(values.queued, attributes);
    // `queue_depth` stays this lane's own backlog — the attribution signal —
    // so the numerator that actually goes with `queue_limit` is published
    // beside it. Without this a shared lane exports `queue_depth: 1` against a
    // pool `queue_limit: 4` and a utilization alert reads 25% while the lane is
    // `saturated`; on a private allocation the two are equal.
    metrics.backpressurePressureDepth.record(values.pressureQueued ?? values.queued, attributes);
    metrics.backpressureInflight.record(values.inflight, attributes);
    metrics.backpressurePressureInflight.record(values.pressureInflight ?? values.inflight, attributes);
    metrics.backpressureOldestQueuedAgeMs.record(values.oldestQueuedAgeMs, attributes);
    metrics.backpressureOldestActiveAgeMs.record(values.oldestActiveAgeMs, attributes);
    if (values.queueLimit !== null) {
      metrics.backpressureQueueLimit.record(values.queueLimit, attributes);
    }
    if (values.inflightLimit !== null) {
      metrics.backpressureInflightLimit.record(values.inflightLimit, attributes);
    }
  };
  record('all', {
    queued: snapshot.totals.queued,
    // The rollup row is the whole queue, so its depth is its own pressure.
    pressureQueued: snapshot.totals.queued,
    pressureInflight: snapshot.totals.inflight,
    queueLimit: snapshot.totals.queueLimit,
    inflight: snapshot.totals.inflight,
    inflightLimit: snapshot.totals.inflightLimit,
    oldestQueuedAgeMs: snapshot.totals.oldestQueuedAgeMs,
    oldestActiveAgeMs: snapshot.totals.oldestActiveAgeMs,
  });
  for (const lane of snapshot.lanes) record(lane.lane, lane);
}

export interface BackpressureMonitorOptions {
  registry?: BackpressureRegistry;
  intervalMs?: number;
  summaryIntervalMs?: number;
  now?: () => number;
  emit: (
    level: 'info' | 'warn',
    message: string,
    snapshot: BackpressureSnapshot,
    lane: BackpressureLaneSnapshot | null,
  ) => void;
}

interface LoggedPressureState {
  state: BackpressureState;
  lastLoggedAt: number;
}

/**
 * One process-wide sampler provides transition/recovery logging and periodic
 * summaries. It logs state changes rather than individual queue operations.
 */
export class BackpressureMonitor {
  private readonly registry: BackpressureRegistry;
  private readonly intervalMs: number;
  private readonly summaryIntervalMs: number;
  private readonly now: () => number;
  private readonly emit: BackpressureMonitorOptions['emit'];
  private readonly logged = new Map<string, LoggedPressureState>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: BackpressureMonitorOptions) {
    this.registry = options.registry ?? backpressureRegistry;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
    this.summaryIntervalMs = Math.max(this.intervalMs, options.summaryIntervalMs ?? 60_000);
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  sample(): void {
    const captured = this.registry.capture();
    const now = this.now();
    for (const scheduler of captured.schedulers) {
      try {
        recordBackpressureSnapshotMetrics(scheduler);
      } catch {
        // The monitor must keep logging even if a metrics provider misbehaves.
      }
      const worstLaneState = scheduler.lanes.reduce<BackpressureState>(
        (state, lane) => maxState(state, lane.state),
        'healthy',
      );
      const samples: Array<{ key: string; state: BackpressureState; lane: BackpressureLaneSnapshot | null }> =
        scheduler.lanes.map((lane) => ({
          key: `${scheduler.scheduler}/${lane.lane}`,
          state: lane.state,
          lane,
        }));
      if (STATE_RANK[scheduler.state] > STATE_RANK[worstLaneState]) {
        samples.push({
          key: `${scheduler.scheduler}/all`,
          state: scheduler.state,
          lane: null,
        });
      }
      for (const sample of samples) {
        this.observeSample(sample.key, sample.state, scheduler, sample.lane, now);
      }
    }
  }

  private observeSample(
    key: string,
    state: BackpressureState,
    scheduler: BackpressureSnapshot,
    lane: BackpressureLaneSnapshot | null,
    now: number,
  ): void {
    const previous = this.logged.get(key);
    if (state === 'healthy') {
      if (previous && previous.state !== 'healthy') {
        this.safeEmit(
          'info',
          this.message('recovered', scheduler, lane, state, previous.state),
          scheduler,
          lane,
        );
      }
      this.logged.set(key, { state, lastLoggedAt: previous?.lastLoggedAt ?? now });
      return;
    }

    const transition = !previous || previous.state !== state;
    const summaryDue = !previous || now - previous.lastLoggedAt >= this.summaryIntervalMs;
    if (transition || summaryDue) {
      this.safeEmit(
        'warn',
        this.message(transition ? 'transition' : 'summary', scheduler, lane, state, previous?.state),
        scheduler,
        lane,
      );
      this.logged.set(key, { state, lastLoggedAt: now });
    }
  }

  private message(
    event: 'transition' | 'summary' | 'recovered',
    scheduler: BackpressureSnapshot,
    lane: BackpressureLaneSnapshot | null,
    state: BackpressureState,
    previousState?: BackpressureState,
  ): string {
    const values = lane ?? {
      lane: 'all',
      queued: scheduler.totals.queued,
      queueLimit: scheduler.totals.queueLimit,
      inflight: scheduler.totals.inflight,
      inflightLimit: scheduler.totals.inflightLimit,
      oldestQueuedAgeMs: scheduler.totals.oldestQueuedAgeMs,
      oldestActiveAgeMs: scheduler.totals.oldestActiveAgeMs,
      rejectedTotal: scheduler.totals.rejectedTotal,
      queuedOperations: scheduler.lanes.flatMap((item) => item.queuedOperations)
        .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs)
        .slice(0, MAX_OPERATION_SUMMARIES),
      activeOperations: scheduler.lanes.flatMap((item) => item.activeOperations)
        .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs)
        .slice(0, MAX_OPERATION_SUMMARIES),
    };
    // A source that predates `pressureQueued` reports its own backlog, which is
    // what a private allocation is classified against anyway.
    const pressureQueued = lane?.pressureQueued ?? values.queued;
    const pressureInflight = lane?.pressureInflight ?? values.inflight;
    return `[backpressure] ${JSON.stringify({
      event,
      scheduler: scheduler.scheduler,
      lane: values.lane,
      state,
      ...(lane?.stateReasons ? { stateReasons: lane.stateReasons } : {}),
      ...(previousState ? { previousState } : {}),
      queued: values.queued,
      // Only when the depth that classified the lane is not the lane's own
      // backlog — i.e. a shared pool. Without it the line reads as a
      // contradiction (`state: saturated` next to `queued: 1, queueLimit: 4`),
      // and the rollup line that would have carried the pool's depth is
      // suppressed exactly when a lane matches the rollup's state. A private
      // allocation emits nothing extra, so those records are unchanged.
      ...(pressureQueued === values.queued ? {} : { pressureQueued }),
      queueLimit: values.queueLimit,
      inflight: values.inflight,
      ...(pressureInflight === values.inflight ? {} : { pressureInflight }),
      inflightLimit: values.inflightLimit,
      oldestQueuedAgeMs: values.oldestQueuedAgeMs,
      oldestActiveAgeMs: values.oldestActiveAgeMs,
      rejectedTotal: values.rejectedTotal,
      queuedOperations: values.queuedOperations,
      activeOperations: values.activeOperations,
    })}`;
  }

  private safeEmit(
    level: 'info' | 'warn',
    message: string,
    scheduler: BackpressureSnapshot,
    lane: BackpressureLaneSnapshot | null,
  ): void {
    try {
      this.emit(level, message, scheduler, lane);
    } catch {
      // Logging must never break scheduling or the monitor loop.
    }
  }
}
