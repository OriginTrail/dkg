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
  notifyGlobalSyncBackpressureCapacityChanged,
  parseBooleanEnv,
  resolveExplicitSyncGlobalLimit,
  resolveSyncGlobalBackpressure,
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

  private constructor(
    readonly policy: SyncGlobalBackpressurePolicy,
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

    const adaptivePolicy = resolveSyncGlobalBackpressure({
      syncGlobalMaxInflight: explicitGlobalLimit ?? hardMax,
      syncGlobalQueueLimit: config.syncGlobalQueueLimit,
    });
    return new SyncCapacityRuntime(
      adaptivePolicy,
      configuredCoverageBatch,
      new AdaptiveCapacityController(bounds, { now: options.now }),
      new AdaptiveCapacitySampler(store, options.samplerDependencies),
    );
  }

  isAdaptive(): boolean {
    return this.controller !== undefined;
  }

  getCurrentInflight(): number | undefined {
    return this.controller?.getCurrentInflight();
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
