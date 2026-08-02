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

interface CapacityWindow {
  readonly inflight: number;
  readonly coverageBatch: number;
}

interface CapacityCounters {
  readonly strainedSamples: number;
  readonly healthyDemandSamples: number;
}

interface CapacityControllerState {
  readonly window: Readonly<CapacityWindow>;
  readonly counters: Readonly<CapacityCounters>;
  readonly cooldownUntilMs: number;
  readonly storePressureTelemetryAvailable: boolean;
}

interface CapacityTransitionContext {
  readonly current: Readonly<CapacityControllerState>;
  readonly classified: Readonly<ClassifiedSample>;
  readonly sample: Readonly<AdaptiveCapacitySample>;
  readonly bounds: Extract<AdaptiveCapacityBounds, { mode: 'bounded' }>;
  readonly atMs: number;
  readonly cooldownMs: number;
  readonly healthySamplesToGrow: number;
  readonly strainedSamplesToShrink: number;
}

interface CapacityTransition {
  readonly action: AdaptiveCapacityAction;
  readonly reason: AdaptiveCapacityReason;
  readonly next: Readonly<CapacityControllerState>;
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

function buildTransition(
  context: CapacityTransitionContext,
  action: AdaptiveCapacityAction,
  reason: AdaptiveCapacityReason,
  next: {
    window?: Readonly<CapacityWindow>;
    counters?: Readonly<CapacityCounters>;
    cooldownUntilMs?: number;
  },
): CapacityTransition {
  return {
    action,
    reason,
    next: {
      window: next.window ?? context.current.window,
      counters: next.counters ?? context.current.counters,
      cooldownUntilMs: next.cooldownUntilMs ?? context.current.cooldownUntilMs,
      storePressureTelemetryAvailable: context.sample.store.telemetryAvailable,
    },
  };
}

function holdCapacity(
  context: CapacityTransitionContext,
  reason: AdaptiveCapacityReason,
  counters: Readonly<CapacityCounters> = context.current.counters,
): CapacityTransition {
  return buildTransition(context, 'hold', reason, { counters });
}

function halveCapacity(
  context: CapacityTransitionContext,
): CapacityTransition {
  const { current, bounds, classified, atMs, cooldownMs } = context;
  return buildTransition(context, 'halve', classified.reason, {
    window: {
      inflight: Math.max(bounds.minInflight, Math.floor(current.window.inflight / 2)),
      coverageBatch: current.window.coverageBatch > 0
        ? Math.max(1, Math.floor(current.window.coverageBatch / 2))
        : 0,
    },
    counters: { strainedSamples: 0, healthyDemandSamples: 0 },
    cooldownUntilMs: atMs + cooldownMs,
  });
}

function decreaseCapacity(
  context: CapacityTransitionContext,
): CapacityTransition {
  const { current, bounds, classified, atMs, cooldownMs } = context;
  return buildTransition(context, 'decrease', classified.reason, {
    window: {
      inflight: Math.max(bounds.minInflight, current.window.inflight - 1),
      coverageBatch: current.window.coverageBatch > 0
        ? Math.max(1, current.window.coverageBatch - 1)
        : 0,
    },
    counters: { strainedSamples: 0, healthyDemandSamples: 0 },
    cooldownUntilMs: atMs + cooldownMs,
  });
}

function increaseCapacity(
  context: CapacityTransitionContext,
  inflightCanGrow: boolean,
  coverageCanGrow: boolean,
): CapacityTransition {
  const { current, atMs, cooldownMs } = context;
  return buildTransition(context, 'increase', 'healthy_hysteresis', {
    window: {
      inflight: current.window.inflight + (inflightCanGrow ? 1 : 0),
      coverageBatch: current.window.coverageBatch + (coverageCanGrow ? 1 : 0),
    },
    counters: { strainedSamples: 0, healthyDemandSamples: 0 },
    cooldownUntilMs: atMs + cooldownMs,
  });
}

function calculateCapacityTransition(
  context: CapacityTransitionContext,
): CapacityTransition {
  const {
    current,
    classified,
    sample,
    atMs,
    healthySamplesToGrow,
    strainedSamplesToShrink,
    bounds,
  } = context;
  const waitingForCooldown = atMs < current.cooldownUntilMs;

  if (classified.kind === 'critical') return halveCapacity(context);

  if (classified.kind === 'strained') {
    const strainedSamples = current.counters.strainedSamples + 1;
    if (strainedSamples < strainedSamplesToShrink) {
      return holdCapacity(
        context,
        'strained_hysteresis',
        { strainedSamples, healthyDemandSamples: 0 },
      );
    }
    return decreaseCapacity(context);
  }

  const resetStrainedCounters = {
    strainedSamples: 0,
    healthyDemandSamples: current.counters.healthyDemandSamples,
  };
  if (classified.kind === 'ambiguous') {
    return holdCapacity(
      context,
      classified.reason,
      { strainedSamples: 0, healthyDemandSamples: 0 },
    );
  }

  if (!sample.demand) {
    return holdCapacity(
      context,
      'no_demand',
      { strainedSamples: 0, healthyDemandSamples: 0 },
    );
  }

  const healthyDemandSamples = Math.min(
    healthySamplesToGrow,
    resetStrainedCounters.healthyDemandSamples + 1,
  );
  const healthyCounters = { strainedSamples: 0, healthyDemandSamples };
  if (healthyDemandSamples < healthySamplesToGrow) {
    return holdCapacity(
      context,
      'healthy_hysteresis',
      healthyCounters,
    );
  }
  if (waitingForCooldown) {
    return holdCapacity(context, 'cooldown', healthyCounters);
  }

  const growthInflightCeiling = sample.store.telemetryAvailable
    ? bounds.maxInflight
    : Math.min(bounds.maxInflight, DEFAULT_SYNC_ADAPTIVE_INITIAL_INFLIGHT);
  const inflightCanGrow = current.window.inflight < growthInflightCeiling;
  const coverageCanGrow = current.window.coverageBatch > 0
    && current.window.coverageBatch < bounds.configuredCoverageBatch;
  if (!inflightCanGrow && !coverageCanGrow) {
    return holdCapacity(
      context,
      !sample.store.telemetryAvailable && current.window.inflight < bounds.maxInflight
        ? 'store_telemetry_growth_cap'
        : 'at_maximum',
      healthyCounters,
    );
  }

  return increaseCapacity(context, inflightCanGrow, coverageCanGrow);
}

function deriveAdaptiveCapacityState(
  current: Readonly<CapacityControllerState>,
  lastDecision: Readonly<AdaptiveCapacityDecision>,
): AdaptiveCapacityState {
  if (lastDecision.action === 'halve' || lastDecision.action === 'decrease') {
    return 'constrained';
  }
  if (lastDecision.action === 'increase') return 'cooldown';

  switch (lastDecision.reason) {
    case 'warming':
      return 'warming';
    case 'cooldown':
      return 'cooldown';
    case 'no_demand':
      return lastDecision.atMs < current.cooldownUntilMs ? 'cooldown' : 'healthy';
    case 'ambiguous_signals':
    case 'strained_hysteresis':
    case 'healthy_hysteresis':
      return lastDecision.atMs < current.cooldownUntilMs ? 'cooldown' : 'warming';
    case 'at_maximum':
      return current.storePressureTelemetryAvailable ? 'healthy' : 'constrained';
    case 'store_telemetry_growth_cap':
    case 'critical_ack_queue':
    case 'critical_health_queue':
    case 'critical_store_saturated':
    case 'critical_store_stalled':
    case 'critical_heap':
    case 'critical_event_loop':
    case 'strained_store_queue':
    case 'strained_cpu':
    case 'strained_heap':
    case 'strained_event_loop':
      return 'constrained';
  }
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
  private controllerState: Readonly<CapacityControllerState>;
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
    const createdAt = this.now();
    if (!Number.isFinite(createdAt)) throw new RangeError('now must return a finite timestamp');
    this.controllerState = {
      window: {
        inflight: bounds.initialInflight,
        coverageBatch: bounds.configuredCoverageBatch,
      },
      counters: { strainedSamples: 0, healthyDemandSamples: 0 },
      cooldownUntilMs: createdAt + this.cooldownMs,
      storePressureTelemetryAvailable: false,
    };
    this.lastDecision = Object.freeze({
      action: 'hold',
      reason: 'warming',
      atMs: createdAt,
      previousInflight: bounds.initialInflight,
      currentInflight: bounds.initialInflight,
      previousCoverageBatch: bounds.configuredCoverageBatch,
      currentCoverageBatch: bounds.configuredCoverageBatch,
    });
  }

  observe(sample: AdaptiveCapacitySample, atMs = this.now()): AdaptiveCapacityStatus {
    this.validateSample(sample, atMs);
    const transition = calculateCapacityTransition({
      current: this.controllerState,
      classified: classifySample(sample),
      sample,
      bounds: this.bounds,
      atMs,
      cooldownMs: this.cooldownMs,
      healthySamplesToGrow: this.healthySamplesToGrow,
      strainedSamplesToShrink: this.strainedSamplesToShrink,
    });
    this.applyTransition(transition, atMs);
    return this.getStatus();
  }

  getCurrentInflight(): number {
    return this.controllerState.window.inflight;
  }

  getEffectiveCoverageBatch(): number {
    return this.controllerState.window.coverageBatch;
  }

  getStatus(): AdaptiveCapacityStatus {
    const { window, counters } = this.controllerState;
    return Object.freeze({
      state: deriveAdaptiveCapacityState(this.controllerState, this.lastDecision),
      currentInflight: window.inflight,
      minInflight: this.bounds.minInflight,
      maxInflight: this.bounds.maxInflight,
      effectiveCoverageBatch: window.coverageBatch,
      configuredCoverageBatch: this.bounds.configuredCoverageBatch,
      storePressureTelemetryAvailable: this.controllerState.storePressureTelemetryAvailable,
      consecutiveStrainedSamples: counters.strainedSamples,
      consecutiveHealthyDemandSamples: counters.healthyDemandSamples,
      cooldownUntilMs: this.controllerState.cooldownUntilMs,
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

  private applyTransition(
    transition: Readonly<CapacityTransition>,
    atMs: number,
  ): void {
    const previous = this.controllerState.window;
    this.controllerState = transition.next;
    this.lastDecision = Object.freeze({
      action: transition.action,
      reason: transition.reason,
      atMs,
      previousInflight: previous.inflight,
      currentInflight: transition.next.window.inflight,
      previousCoverageBatch: previous.coverageBatch,
      currentCoverageBatch: transition.next.window.coverageBatch,
    });
  }
}
