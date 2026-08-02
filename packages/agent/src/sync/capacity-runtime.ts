import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { SyncAdaptiveCapacityConfig } from '../dkg-agent-types.js';
import {
  AdaptiveCapacityController,
  MAX_SYNC_ADAPTIVE_INFLIGHT,
  resolveAdaptiveCapacityBounds,
  type AdaptiveCapacityDecision,
  type AdaptiveCapacityState,
} from './adaptive-capacity.js';
import {
  AdaptiveCapacitySampler,
  deriveAdaptiveInflightHardMax,
  type AdaptiveCapacitySamplerDependencies,
} from './adaptive-capacity-sampler.js';
import {
  createSyncGlobalBackpressurePolicy,
  getSyncBackpressureSnapshot,
  notifyGlobalSyncBackpressureCapacityChanged,
  parseBooleanEnv,
  resolveExplicitSyncGlobalLimit,
  resolveSyncGlobalBackpressure,
  type SyncBackpressureSnapshot,
  type SyncGlobalBackpressureConfig,
  type SyncGlobalBackpressurePolicy,
} from './backpressure.js';
import { resolveCorePublicSyncBatchSize } from './core-public-coverage-scheduler.js';

export const DEFAULT_SYNC_CAPACITY_SAMPLE_INTERVAL_MS = 5_000;

export interface SyncCapacityRuntimeConfig extends SyncGlobalBackpressureConfig {
  nodeRole?: 'core' | 'edge';
  syncAdaptiveCapacity?: SyncAdaptiveCapacityConfig;
  syncCorePublicBatchSize?: number;
}

export interface SyncCapacityStatus {
  mode: 'static' | 'adaptive';
  state: AdaptiveCapacityState | 'healthy';
  currentInflight: number | null;
  minInflight: number | null;
  maxInflight: number | null;
  currentCoverageBatch: number;
  configuredCoverageBatch: number;
  storePressureTelemetryAvailable: boolean;
  lastDecision: Pick<
    AdaptiveCapacityDecision,
    'action' | 'reason' | 'atMs'
  > | null;
}

export interface SyncCapacityRuntimeOptions {
  parallelism?: number;
  samplerDependencies?: AdaptiveCapacitySamplerDependencies;
  now?: () => number;
}

export interface SyncCapacitySamplingOptions {
  /** Additional Core work that does not currently occupy requester admission. */
  hasSupplementalDemand?: () => boolean;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface SyncCapacityPolicyStatus {
  inflightLimit: number | null;
  queueLimit: number | null;
}

function readStorePressure(store: TripleStore) {
  try {
    return store.getPressureSnapshot?.();
  } catch {
    return undefined;
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function resolveAdaptivePositiveInteger(
  configValue: number | undefined,
  envName: string,
  configName: string,
): number | undefined {
  const envValue = process.env[envName];
  if (envValue !== undefined) return requirePositiveInteger(envValue, envName);
  if (configValue !== undefined) {
    return requirePositiveInteger(configValue, `syncAdaptiveCapacity.${configName}`);
  }
  return undefined;
}

/** One agent-owned capacity policy; static callers keep the exact old path. */
export class SyncCapacityRuntime {
  private readonly controller?: AdaptiveCapacityController;
  private readonly sampler?: AdaptiveCapacitySampler;
  private samplingTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly policy: SyncGlobalBackpressurePolicy,
    private readonly configuredCoverageBatch: number,
    controller?: AdaptiveCapacityController,
    sampler?: AdaptiveCapacitySampler,
  ) {
    this.controller = controller;
    this.sampler = sampler;
  }

  static create(
    config: SyncCapacityRuntimeConfig,
    store: TripleStore,
    options: SyncCapacityRuntimeOptions = {},
  ): SyncCapacityRuntime {
    const configuredCoverageBatch = resolveCorePublicSyncBatchSize(
      config.syncCorePublicBatchSize,
    );
    const staticPolicy = resolveSyncGlobalBackpressure(config);
    const explicitGlobalLimit = resolveExplicitSyncGlobalLimit(config);
    const explicitlyEnabled = parseBooleanEnv('DKG_SYNC_ADAPTIVE_CAPACITY_ENABLED')
      ?? config.syncAdaptiveCapacity?.enabled;
    const adaptive = (config.nodeRole ?? 'edge') === 'core'
      && staticPolicy.limit !== undefined
      && (explicitlyEnabled ?? explicitGlobalLimit === undefined);
    if (!adaptive) {
      return new SyncCapacityRuntime(staticPolicy, configuredCoverageBatch);
    }

    const requestedMax = resolveAdaptivePositiveInteger(
      config.syncAdaptiveCapacity?.maxInflight,
      'DKG_SYNC_ADAPTIVE_MAX_INFLIGHT',
      'maxInflight',
    );
    const minInflight = resolveAdaptivePositiveInteger(
      config.syncAdaptiveCapacity?.minInflight,
      'DKG_SYNC_ADAPTIVE_MIN_INFLIGHT',
      'minInflight',
    );
    const hardMax = deriveAdaptiveInflightHardMax({
      operatorMax: Math.min(
        requestedMax ?? MAX_SYNC_ADAPTIVE_INFLIGHT,
        explicitGlobalLimit ?? MAX_SYNC_ADAPTIVE_INFLIGHT,
      ),
      parallelism: options.parallelism,
      storePressure: readStorePressure(store),
    });
    const bounds = resolveAdaptiveCapacityBounds({
      initialInflight: Math.min(2, hardMax),
      minInflight,
      maxInflight: hardMax,
      configuredCoverageBatch,
    });
    if (bounds.mode === 'unbounded') {
      return new SyncCapacityRuntime(staticPolicy, configuredCoverageBatch);
    }

    const controller = new AdaptiveCapacityController(bounds, { now: options.now });
    const adaptivePolicy = createSyncGlobalBackpressurePolicy(
      // The controller can never exceed hardMax, so use that same ceiling for
      // queue sizing and admission observability. Basing the queue on a larger
      // explicit operator limit would allow a backlog that the adaptive Core
      // can never drain at the advertised policy capacity.
      hardMax,
      config.syncGlobalQueueLimit,
      () => controller.getCurrentInflight(),
    );
    return new SyncCapacityRuntime(
      adaptivePolicy,
      configuredCoverageBatch,
      controller,
      new AdaptiveCapacitySampler(store, options.samplerDependencies),
    );
  }

  isAdaptive(): boolean {
    return this.controller !== undefined;
  }

  /** Stable admission contract; callers do not need to branch on capacity mode. */
  getAdmissionOptions(): { policy: SyncGlobalBackpressurePolicy } {
    return { policy: this.policy };
  }

  /** Runtime-owned requester-pressure view for lifecycle diagnostics and sampling. */
  getBackpressureSnapshot(): SyncBackpressureSnapshot {
    return getSyncBackpressureSnapshot(this.policy);
  }

  /** Stable resolved ceilings without exposing the branded admission policy. */
  getResolvedPolicyStatus(): SyncCapacityPolicyStatus {
    return {
      inflightLimit: this.policy.limit ?? null,
      queueLimit: this.policy.queueLimit ?? null,
    };
  }

  getEffectiveCoverageBatch(): number {
    return this.controller?.getEffectiveCoverageBatch() ?? this.configuredCoverageBatch;
  }

  sample(demand: boolean): void {
    if (!this.controller || !this.sampler) return;
    const previousInflight = this.controller.getCurrentInflight();
    this.controller.observe(this.sampler.sample(demand));
    if (this.controller.getCurrentInflight() !== previousInflight) {
      notifyGlobalSyncBackpressureCapacityChanged();
    }
  }

  /**
   * Own the adaptive sampling lifecycle and requester-demand calculation.
   * Static runtimes deliberately no-op so lifecycle callers stay mode-agnostic.
   */
  startSampling(options: SyncCapacitySamplingOptions = {}): boolean {
    if (!this.controller || !this.sampler || this.samplingTimer) return false;
    const intervalMs = requirePositiveInteger(
      options.intervalMs ?? DEFAULT_SYNC_CAPACITY_SAMPLE_INTERVAL_MS,
      'sync capacity sample interval',
    );
    this.samplingTimer = setInterval(() => {
      try {
        const pressure = this.getBackpressureSnapshot();
        const demand = pressure.inflight > 0
          || pressure.queued > 0
          || (options.hasSupplementalDemand?.() ?? false);
        this.sample(demand);
      } catch (error) {
        options.onError?.(error);
      }
    }, intervalMs);
    this.samplingTimer.unref?.();
    return true;
  }

  stopSampling(): boolean {
    if (!this.samplingTimer) return false;
    clearInterval(this.samplingTimer);
    this.samplingTimer = undefined;
    return true;
  }

  getStatus(): SyncCapacityStatus {
    if (!this.controller) {
      const currentInflight = this.policy.limit ?? null;
      return {
        mode: 'static',
        state: 'healthy',
        currentInflight,
        minInflight: currentInflight,
        maxInflight: currentInflight,
        currentCoverageBatch: this.configuredCoverageBatch,
        configuredCoverageBatch: this.configuredCoverageBatch,
        storePressureTelemetryAvailable: false,
        lastDecision: null,
      };
    }
    const status = this.controller.getStatus();
    return {
      mode: 'adaptive',
      state: status.state,
      currentInflight: status.currentInflight,
      minInflight: status.minInflight,
      maxInflight: status.maxInflight,
      currentCoverageBatch: status.effectiveCoverageBatch,
      configuredCoverageBatch: status.configuredCoverageBatch,
      storePressureTelemetryAvailable: status.storePressureTelemetryAvailable,
      lastDecision: {
        action: status.lastDecision.action,
        reason: status.lastDecision.reason,
        atMs: status.lastDecision.atMs,
      },
    };
  }
}
