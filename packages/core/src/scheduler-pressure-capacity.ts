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

export interface CapturedPressureCapacity {
  readonly value: SchedulerPressureCapacity;
  readonly identity: string;
}


export function normalizePressureLimit(value: number | null | undefined): number | null {
  return Number.isFinite(value) && (value as number) >= 0 ? value as number : null;
}

/** Stable identity for the capacity semantics the tracker exposes. */
export function schedulerPressureCapacityIdentity(
  capacity: SchedulerPressureCapacity,
): string {
  const capacityModel = capacity.capacityModel === 'shared' ? 'shared' : 'partitioned';
  const lanes = capacityModel === 'partitioned'
    ? Object.entries(capacity.lanes ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([lane, limits]) => [
        lane,
        normalizePressureLimit(limits.queueLimit),
        normalizePressureLimit(limits.inflightLimit),
      ])
    : [];
  return JSON.stringify([
    capacityModel,
    normalizePressureLimit(capacity.queueLimit),
    normalizePressureLimit(capacity.inflightLimit),
    lanes,
  ]);
}

/** Capture ticket policy and semantic identity together, once at admission. */
export function capturePressureCapacity(capacity: SchedulerPressureCapacity): CapturedPressureCapacity {
  const limits = {
    queueLimit: normalizePressureLimit(capacity.queueLimit),
    inflightLimit: normalizePressureLimit(capacity.inflightLimit),
  };
  const value: SchedulerPressureCapacity = capacity.capacityModel === 'shared'
    ? { ...limits, capacityModel: 'shared' }
    : {
      ...limits,
      capacityModel: 'partitioned',
      lanes: Object.freeze(Object.fromEntries(Object.entries(capacity.lanes ?? {}).map(([lane, allocation]) => [
        lane,
        Object.freeze({
          queueLimit: normalizePressureLimit(allocation.queueLimit),
          inflightLimit: normalizePressureLimit(allocation.inflightLimit),
        }),
      ]))),
    };
  return { value: Object.freeze(value), identity: schedulerPressureCapacityIdentity(value) };
}

/** Reconcile captured owners without serializing policies in the read path. */
export function reconcilePressureCapacity(
  sources: readonly Iterable<{ readonly capacity?: CapturedPressureCapacity }>[],
  fallback: SchedulerPressureCapacity,
): SchedulerPressureCapacity {
  let liveIdentity: string | undefined;
  let liveCapacity: SchedulerPressureCapacity | undefined;
  for (const records of sources) {
    for (const record of records) {
      if (record.capacity === undefined) continue;
      if (liveIdentity !== undefined && record.capacity.identity !== liveIdentity) {
        return { capacityModel: 'shared' };
      }
      liveIdentity = record.capacity.identity;
      liveCapacity = record.capacity.value;
    }
  }
  return liveCapacity ?? fallback;
}
