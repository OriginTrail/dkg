import { getMetrics } from './telemetry-api.js';

export type BackpressureState = 'healthy' | 'degraded' | 'saturated' | 'stalled';
export type SchedulerPressureOutcome = 'completed' | 'failed' | 'cancelled' | 'released';

/**
 * How a scheduler's capacity is divided between its lanes.
 *
 * `partitioned` (the default): every lane owns a private allocation, declared
 * in `lanes`, and those allocations add up to the scheduler's ceiling. A lane
 * fills independently of its neighbours — `StorePriorityScheduler`.
 *
 * `shared`: every lane draws on ONE pool bounded by the scheduler-level
 * `queueLimit`/`inflightLimit`. There is no private allocation to declare, so a
 * lane's ceiling *is* the pool's ceiling, lane ceilings must never be summed,
 * and the depth a lane's queued work is waiting behind is the pool's, not that
 * lane's own share of it — `PriorityAdmissionQueue`.
 */
export type SchedulerLaneCapacityModel = 'partitioned' | 'shared';

export interface SchedulerPressureCapacity {
  queueLimit?: number | null;
  inflightLimit?: number | null;
  /** Defaults to `partitioned`. See {@link SchedulerLaneCapacityModel}. */
  laneCapacity?: SchedulerLaneCapacityModel;
  /**
   * Private per-lane allocations. Meaningful only under `partitioned`; a
   * `shared` scheduler has none to declare and takes its lane ceilings from the
   * scheduler-level limits above.
   */
  lanes?: Record<string, {
    queueLimit?: number | null;
    inflightLimit?: number | null;
  }>;
}

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
   * How to read `queueLimit`/`inflightLimit` on this row. Under `shared` they
   * are the scheduler-wide pool this lane draws on rather than a private
   * allocation, so `queued` is this lane's share of a depth the whole pool
   * contributes to — read `totals` for that depth, and never sum lane limits.
   */
  capacityModel: SchedulerLaneCapacityModel;
  queued: number;
  queueLimit: number | null;
  inflight: number;
  inflightLimit: number | null;
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

  private laneSnapshot(lane: string, now: number): BackpressureLaneSnapshot {
    const runtime = this.runtimeFor(lane);
    const queued = [...this.queued.values()].filter((entry) => entry.lane === lane);
    const active = [...this.active.values()].filter((entry) => entry.lane === lane);
    const shared = this.capacity.laneCapacity === 'shared';
    const queueLimit = shared
      ? normalizeLimit(this.capacity.queueLimit)
      : normalizeLimit(this.capacity.lanes?.[lane]?.queueLimit);
    const inflightLimit = shared
      ? normalizeLimit(this.capacity.inflightLimit)
      : normalizeLimit(this.capacity.lanes?.[lane]?.inflightLimit);
    // Depth pressure is measured against whatever the lane's ceiling bounds:
    // its own backlog when the allocation is private, the whole pool when the
    // ceiling is shared. Under `partitioned` this is `queued.length`, so the
    // classifier below is unchanged for every scheduler that owns its lanes.
    const boundedDepth = shared ? this.queued.size : queued.length;
    const oldestQueuedAgeMs = queued.length === 0
      ? 0
      : Math.max(...queued.map((entry) => Math.max(0, Math.floor(now - entry.queuedAt))));
    const oldestActiveAgeMs = active.length === 0
      ? 0
      : Math.max(...active.map((entry) => Math.max(
          0,
          Math.floor(now - (entry.startedAt ?? now)),
        )));
    // A lane with nothing waiting is not held back by a full queue, whoever
    // filled it. Under `partitioned` the guard is implied by the comparisons it
    // guards (`boundedDepth` is this lane's own backlog), so it changes nothing
    // there; under `shared` it is what keeps an idle lane out of a pool's
    // saturation.
    const depthCeiling = queueLimit !== null && queueLimit > 0 && queued.length > 0
      ? queueLimit
      : null;
    let state: BackpressureState = 'healthy';
    if (oldestActiveAgeMs >= this.thresholds.stalledActiveAgeMs) {
      state = 'stalled';
    } else if (
      (depthCeiling !== null && boundedDepth >= depthCeiling)
      || (
        runtime.lastRejectedAt !== null
        && now - runtime.lastRejectedAt <= this.thresholds.rejectionStateWindowMs
      )
    ) {
      state = 'saturated';
    } else if (
      oldestQueuedAgeMs >= this.thresholds.degradedQueueAgeMs
      || (
        depthCeiling !== null
        && boundedDepth / depthCeiling >= this.thresholds.degradedQueueUtilization
      )
    ) {
      state = 'degraded';
    }
    return {
      lane,
      state,
      capacityModel: shared ? 'shared' : 'partitioned',
      queued: queued.length,
      queueLimit,
      inflight: active.length,
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
      queueLimit: number | null;
      inflight: number;
      inflightLimit: number | null;
      oldestQueuedAgeMs: number;
      oldestActiveAgeMs: number;
    },
  ) => {
    const attributes = { scheduler: snapshot.scheduler, lane };
    metrics.backpressureQueueDepth.record(values.queued, attributes);
    metrics.backpressureInflight.record(values.inflight, attributes);
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
    return `[backpressure] ${JSON.stringify({
      event,
      scheduler: scheduler.scheduler,
      lane: values.lane,
      state,
      ...(previousState ? { previousState } : {}),
      queued: values.queued,
      // A lane sharing one pool is classified against the pool's depth, and
      // `queued` is only this lane's share of it. Without the pool depth beside
      // it the line reads as a contradiction — `state: saturated` next to
      // `queued: 1, queueLimit: 4` — and the rollup line that would have
      // carried the totals is suppressed exactly when a lane matches it.
      ...(lane?.capacityModel === 'shared' ? { poolQueued: scheduler.totals.queued } : {}),
      queueLimit: values.queueLimit,
      inflight: values.inflight,
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
