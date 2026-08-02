export const DEFAULT_SYNC_ADAPTIVE_INITIAL_INFLIGHT = 2;
export const DEFAULT_SYNC_ADAPTIVE_MIN_INFLIGHT = 1;
export const MAX_SYNC_ADAPTIVE_INFLIGHT = 8;
export const DEFAULT_SYNC_ADAPTIVE_COVERAGE_BATCH = 8;
export const DEFAULT_SYNC_ADAPTIVE_COOLDOWN_MS = 30_000;
export const DEFAULT_SYNC_ADAPTIVE_HEALTHY_SAMPLES = 6;
export const DEFAULT_SYNC_ADAPTIVE_STRAINED_SAMPLES = 2;

export const SYNC_ADAPTIVE_CAPACITY_THRESHOLDS = Object.freeze({
  criticalHeapRatio: 0.82,
  criticalEventLoopUtilization: 0.92,
  strainedCpuUtilization: 0.85,
  strainedHeapRatio: 0.72,
  strainedEventLoopUtilization: 0.8,
  healthyCpuUtilization: 0.65,
  healthyHeapRatio: 0.6,
  healthyEventLoopUtilization: 0.65,
});

export type AdaptiveCapacityState =
  | 'warming'
  | 'healthy'
  | 'constrained'
  | 'cooldown';

export type AdaptiveCapacityAction =
  | 'hold'
  | 'increase'
  | 'decrease'
  | 'halve';

export type AdaptiveCapacityReason =
  | 'warming'
  | 'ambiguous_signals'
  | 'no_demand'
  | 'critical_ack_queue'
  | 'critical_health_queue'
  | 'critical_store_saturated'
  | 'critical_store_stalled'
  | 'critical_heap'
  | 'critical_event_loop'
  | 'strained_store_queue'
  | 'strained_cpu'
  | 'strained_heap'
  | 'strained_event_loop'
  | 'strained_hysteresis'
  | 'healthy_hysteresis'
  | 'cooldown'
  | 'at_maximum'
  | 'store_telemetry_growth_cap';

export interface AdaptiveCapacityBoundsInput {
  /** Existing requester cap. Zero retains its established unbounded meaning. */
  initialInflight?: number;
  minInflight?: number;
  maxInflight?: number;
  /** Zero retains its established meaning: automatic Core coverage is disabled. */
  configuredCoverageBatch?: number;
}

export type AdaptiveCapacityBounds = Readonly<
  | {
      mode: 'unbounded';
      configuredCoverageBatch: number;
    }
  | {
      mode: 'bounded';
      initialInflight: number;
      minInflight: number;
      maxInflight: number;
      configuredCoverageBatch: number;
    }
>;

function requireInteger(
  name: string,
  value: number,
  minimum: number,
): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

/**
 * Resolve only controller-local bounds. Role/config/env precedence and the
 * hardware/store-derived maximum remain integration concerns.
 */
export function resolveAdaptiveCapacityBounds(
  input: AdaptiveCapacityBoundsInput,
): AdaptiveCapacityBounds {
  const configuredCoverageBatch = requireInteger(
    'configuredCoverageBatch',
    input.configuredCoverageBatch ?? DEFAULT_SYNC_ADAPTIVE_COVERAGE_BATCH,
    0,
  );
  const requestedInitial = requireInteger(
    'initialInflight',
    input.initialInflight ?? DEFAULT_SYNC_ADAPTIVE_INITIAL_INFLIGHT,
    0,
  );

  if (requestedInitial === 0) {
    return Object.freeze({
      mode: 'unbounded',
      configuredCoverageBatch,
    });
  }

  const minInflight = requireInteger(
    'minInflight',
    input.minInflight ?? DEFAULT_SYNC_ADAPTIVE_MIN_INFLIGHT,
    1,
  );
  if (minInflight > MAX_SYNC_ADAPTIVE_INFLIGHT) {
    throw new RangeError(
      `minInflight must not exceed the absolute adaptive cap ${MAX_SYNC_ADAPTIVE_INFLIGHT}`,
    );
  }
  const requestedMax = requireInteger(
    'maxInflight',
    input.maxInflight ?? MAX_SYNC_ADAPTIVE_INFLIGHT,
    1,
  );
  const maxInflight = Math.min(requestedMax, MAX_SYNC_ADAPTIVE_INFLIGHT);
  if (maxInflight < minInflight) {
    throw new RangeError('maxInflight must be greater than or equal to minInflight');
  }

  return Object.freeze({
    mode: 'bounded',
    initialInflight: Math.max(minInflight, Math.min(requestedInitial, maxInflight)),
    minInflight,
    maxInflight,
    configuredCoverageBatch,
  });
}

export type AdaptiveCapacityStoreSample = Readonly<
  | {
      telemetryAvailable: false;
    }
  | {
      telemetryAvailable: true;
      ackQueued: number;
      healthQueued: number;
      normalQueued: number;
      backgroundQueued: number;
      saturated?: boolean;
      stalled?: boolean;
    }
>;

export interface AdaptiveCapacitySample {
  /** Real requester or automatic-coverage backlog; it is not a pressure signal. */
  demand: boolean;
  /** Ratios in the inclusive range 0..1. Missing host signals are ambiguous. */
  cpuUtilization?: number;
  heapRatio?: number;
  eventLoopUtilization?: number;
  store: AdaptiveCapacityStoreSample;
}

export interface AdaptiveCapacityDecision {
  readonly action: AdaptiveCapacityAction;
  readonly reason: AdaptiveCapacityReason;
  readonly atMs: number;
  readonly previousInflight: number;
  readonly currentInflight: number;
  readonly previousCoverageBatch: number;
  readonly currentCoverageBatch: number;
}

export interface AdaptiveCapacityStatus {
  readonly state: AdaptiveCapacityState;
  readonly currentInflight: number;
  readonly minInflight: number;
  readonly maxInflight: number;
  readonly effectiveCoverageBatch: number;
  readonly configuredCoverageBatch: number;
  readonly storePressureTelemetryAvailable: boolean;
  readonly consecutiveStrainedSamples: number;
  readonly consecutiveHealthyDemandSamples: number;
  readonly cooldownUntilMs: number;
  readonly lastDecision: Readonly<AdaptiveCapacityDecision>;
}

export interface AdaptiveCapacityControllerOptions {
  now?: () => number;
  cooldownMs?: number;
  healthySamplesToGrow?: number;
  strainedSamplesToShrink?: number;
}

interface ClassifiedSample {
  kind: 'critical' | 'strained' | 'healthy' | 'ambiguous';
  reason: AdaptiveCapacityReason;
}

function validateRatio(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite ratio between 0 and 1`);
  }
}

function validateQueueDepth(name: string, value: number): void {
  requireInteger(name, value, 0);
}

function classifySample(sample: AdaptiveCapacitySample): ClassifiedSample {
  const thresholds = SYNC_ADAPTIVE_CAPACITY_THRESHOLDS;
  const store = sample.store;
  if (store.telemetryAvailable) {
    if (store.ackQueued > 0) return { kind: 'critical', reason: 'critical_ack_queue' };
    if (store.healthQueued > 0) return { kind: 'critical', reason: 'critical_health_queue' };
    if (store.saturated === true) {
      return { kind: 'critical', reason: 'critical_store_saturated' };
    }
    if (store.stalled === true) return { kind: 'critical', reason: 'critical_store_stalled' };
  }
  if (
    sample.heapRatio !== undefined
    && sample.heapRatio >= thresholds.criticalHeapRatio
  ) {
    return { kind: 'critical', reason: 'critical_heap' };
  }
  if (
    sample.eventLoopUtilization !== undefined
    && sample.eventLoopUtilization >= thresholds.criticalEventLoopUtilization
  ) {
    return { kind: 'critical', reason: 'critical_event_loop' };
  }

  if (
    store.telemetryAvailable
    && (store.normalQueued > 0 || store.backgroundQueued > 0)
  ) {
    return { kind: 'strained', reason: 'strained_store_queue' };
  }
  if (
    sample.cpuUtilization !== undefined
    && sample.cpuUtilization >= thresholds.strainedCpuUtilization
  ) {
    return { kind: 'strained', reason: 'strained_cpu' };
  }
  if (
    sample.heapRatio !== undefined
    && sample.heapRatio >= thresholds.strainedHeapRatio
  ) {
    return { kind: 'strained', reason: 'strained_heap' };
  }
  if (
    sample.eventLoopUtilization !== undefined
    && sample.eventLoopUtilization >= thresholds.strainedEventLoopUtilization
  ) {
    return { kind: 'strained', reason: 'strained_event_loop' };
  }

  const completeHostSample = sample.cpuUtilization !== undefined
    && sample.heapRatio !== undefined
    && sample.eventLoopUtilization !== undefined;
  const storeQueuesHealthy = !store.telemetryAvailable
    || (
      store.ackQueued === 0
      && store.healthQueued === 0
      && store.normalQueued === 0
      && store.backgroundQueued === 0
      && store.saturated !== true
      && store.stalled !== true
    );
  if (
    completeHostSample
    && sample.cpuUtilization! <= thresholds.healthyCpuUtilization
    && sample.heapRatio! <= thresholds.healthyHeapRatio
    && sample.eventLoopUtilization! <= thresholds.healthyEventLoopUtilization
    && storeQueuesHealthy
  ) {
    return { kind: 'healthy', reason: 'healthy_hysteresis' };
  }
  return { kind: 'ambiguous', reason: 'ambiguous_signals' };
}

/**
 * Pure fast-down/slow-up AIMD controller. Sampling and application of the
 * returned limits are deliberately owned by the DKGAgent integration layer.
 */
export class AdaptiveCapacityController {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly healthySamplesToGrow: number;
  private readonly strainedSamplesToShrink: number;
  private currentInflight: number;
  private currentCoverageBatch: number;
  private state: AdaptiveCapacityState = 'warming';
  private storePressureTelemetryAvailable = false;
  private consecutiveStrainedSamples = 0;
  private consecutiveHealthyDemandSamples = 0;
  private cooldownUntilMs: number;
  private lastDecision: Readonly<AdaptiveCapacityDecision>;

  constructor(
    private readonly bounds: Extract<AdaptiveCapacityBounds, { mode: 'bounded' }>,
    options: AdaptiveCapacityControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cooldownMs = requireInteger(
      'cooldownMs',
      options.cooldownMs ?? DEFAULT_SYNC_ADAPTIVE_COOLDOWN_MS,
      0,
    );
    this.healthySamplesToGrow = requireInteger(
      'healthySamplesToGrow',
      options.healthySamplesToGrow ?? DEFAULT_SYNC_ADAPTIVE_HEALTHY_SAMPLES,
      1,
    );
    this.strainedSamplesToShrink = requireInteger(
      'strainedSamplesToShrink',
      options.strainedSamplesToShrink ?? DEFAULT_SYNC_ADAPTIVE_STRAINED_SAMPLES,
      1,
    );
    this.currentInflight = bounds.initialInflight;
    this.currentCoverageBatch = bounds.configuredCoverageBatch;
    const createdAt = this.now();
    if (!Number.isFinite(createdAt)) throw new RangeError('now must return a finite timestamp');
    this.cooldownUntilMs = createdAt + this.cooldownMs;
    this.lastDecision = Object.freeze({
      action: 'hold',
      reason: 'warming',
      atMs: createdAt,
      previousInflight: this.currentInflight,
      currentInflight: this.currentInflight,
      previousCoverageBatch: this.currentCoverageBatch,
      currentCoverageBatch: this.currentCoverageBatch,
    });
  }

  observe(sample: AdaptiveCapacitySample, atMs = this.now()): AdaptiveCapacityStatus {
    this.validateSample(sample, atMs);
    this.storePressureTelemetryAvailable = sample.store.telemetryAvailable;
    const classified = classifySample(sample);

    if (classified.kind === 'critical') {
      this.consecutiveStrainedSamples = 0;
      this.consecutiveHealthyDemandSamples = 0;
      this.applyDecision('halve', classified.reason, atMs, () => {
        this.currentInflight = Math.max(
          this.bounds.minInflight,
          Math.floor(this.currentInflight / 2),
        );
        if (this.currentCoverageBatch > 0) {
          this.currentCoverageBatch = Math.max(
            1,
            Math.floor(this.currentCoverageBatch / 2),
          );
        }
      });
      this.state = 'constrained';
      this.cooldownUntilMs = atMs + this.cooldownMs;
      return this.getStatus();
    }

    if (classified.kind === 'strained') {
      this.consecutiveHealthyDemandSamples = 0;
      this.consecutiveStrainedSamples += 1;
      if (this.consecutiveStrainedSamples < this.strainedSamplesToShrink) {
        this.state = atMs < this.cooldownUntilMs ? 'cooldown' : 'warming';
        this.applyDecision('hold', 'strained_hysteresis', atMs);
        return this.getStatus();
      }

      this.consecutiveStrainedSamples = 0;
      this.applyDecision('decrease', classified.reason, atMs, () => {
        this.currentInflight = Math.max(
          this.bounds.minInflight,
          this.currentInflight - 1,
        );
        if (this.currentCoverageBatch > 0) {
          this.currentCoverageBatch = Math.max(1, this.currentCoverageBatch - 1);
        }
      });
      this.state = 'constrained';
      this.cooldownUntilMs = atMs + this.cooldownMs;
      return this.getStatus();
    }

    this.consecutiveStrainedSamples = 0;
    if (classified.kind === 'ambiguous') {
      this.consecutiveHealthyDemandSamples = 0;
      this.state = atMs < this.cooldownUntilMs ? 'cooldown' : 'warming';
      this.applyDecision('hold', classified.reason, atMs);
      return this.getStatus();
    }

    if (!sample.demand) {
      this.consecutiveHealthyDemandSamples = 0;
      this.state = atMs < this.cooldownUntilMs ? 'cooldown' : 'healthy';
      this.applyDecision('hold', 'no_demand', atMs);
      return this.getStatus();
    }

    this.consecutiveHealthyDemandSamples = Math.min(
      this.healthySamplesToGrow,
      this.consecutiveHealthyDemandSamples + 1,
    );
    if (this.consecutiveHealthyDemandSamples < this.healthySamplesToGrow) {
      this.state = atMs < this.cooldownUntilMs ? 'cooldown' : 'warming';
      this.applyDecision('hold', 'healthy_hysteresis', atMs);
      return this.getStatus();
    }
    if (atMs < this.cooldownUntilMs) {
      this.state = 'cooldown';
      this.applyDecision('hold', 'cooldown', atMs);
      return this.getStatus();
    }

    const growthInflightCeiling = sample.store.telemetryAvailable
      ? this.bounds.maxInflight
      : Math.min(this.bounds.maxInflight, DEFAULT_SYNC_ADAPTIVE_INITIAL_INFLIGHT);
    const inflightCanGrow = this.currentInflight < growthInflightCeiling;
    const coverageCanGrow = this.currentCoverageBatch > 0
      && this.currentCoverageBatch < this.bounds.configuredCoverageBatch;
    if (!inflightCanGrow && !coverageCanGrow) {
      this.state = sample.store.telemetryAvailable ? 'healthy' : 'constrained';
      this.applyDecision(
        'hold',
        !sample.store.telemetryAvailable && this.currentInflight < this.bounds.maxInflight
          ? 'store_telemetry_growth_cap'
          : 'at_maximum',
        atMs,
      );
      return this.getStatus();
    }

    this.applyDecision('increase', 'healthy_hysteresis', atMs, () => {
      if (inflightCanGrow) this.currentInflight += 1;
      if (coverageCanGrow) this.currentCoverageBatch += 1;
    });
    this.consecutiveHealthyDemandSamples = 0;
    this.cooldownUntilMs = atMs + this.cooldownMs;
    this.state = 'cooldown';
    return this.getStatus();
  }

  getCurrentInflight(): number {
    return this.currentInflight;
  }

  getEffectiveCoverageBatch(): number {
    return this.currentCoverageBatch;
  }

  getStatus(): AdaptiveCapacityStatus {
    return Object.freeze({
      state: this.state,
      currentInflight: this.currentInflight,
      minInflight: this.bounds.minInflight,
      maxInflight: this.bounds.maxInflight,
      effectiveCoverageBatch: this.currentCoverageBatch,
      configuredCoverageBatch: this.bounds.configuredCoverageBatch,
      storePressureTelemetryAvailable: this.storePressureTelemetryAvailable,
      consecutiveStrainedSamples: this.consecutiveStrainedSamples,
      consecutiveHealthyDemandSamples: this.consecutiveHealthyDemandSamples,
      cooldownUntilMs: this.cooldownUntilMs,
      lastDecision: this.lastDecision,
    });
  }

  private validateSample(sample: AdaptiveCapacitySample, atMs: number): void {
    if (!Number.isFinite(atMs)) throw new RangeError('atMs must be a finite timestamp');
    validateRatio('cpuUtilization', sample.cpuUtilization);
    validateRatio('heapRatio', sample.heapRatio);
    validateRatio('eventLoopUtilization', sample.eventLoopUtilization);
    if (sample.store.telemetryAvailable) {
      validateQueueDepth('store.ackQueued', sample.store.ackQueued);
      validateQueueDepth('store.healthQueued', sample.store.healthQueued);
      validateQueueDepth('store.normalQueued', sample.store.normalQueued);
      validateQueueDepth('store.backgroundQueued', sample.store.backgroundQueued);
    }
  }

  private applyDecision(
    action: AdaptiveCapacityAction,
    reason: AdaptiveCapacityReason,
    atMs: number,
    mutate?: () => void,
  ): void {
    const previousInflight = this.currentInflight;
    const previousCoverageBatch = this.currentCoverageBatch;
    mutate?.();
    this.lastDecision = Object.freeze({
      action,
      reason,
      atMs,
      previousInflight,
      currentInflight: this.currentInflight,
      previousCoverageBatch,
      currentCoverageBatch: this.currentCoverageBatch,
    });
  }
}
