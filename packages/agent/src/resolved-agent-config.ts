import type { CatalogSealDeploymentProfileV1 } from '@origintrail-official/dkg-core';
import type { StorageAckTiming } from '@origintrail-official/dkg-publisher';
import type { DKGAgentConfig, Rfc64CatalogBootstrapConfigV1, Rfc64PublicCatalogBootstrapConfigV1 } from './dkg-agent-types.js';
import type { ResolvedRfc64CatalogAuthoringPolicyV1 } from './rfc64/public-catalog-activation-config-v1.js';
import type { StartupResourcePolicy, resolveStartupResourcePolicy } from './resource-policy.js';
import type { SyncAdmissionConfig } from './sync/policy.js';
import { resolveSyncReconcilerTiming, type SyncReconcilerTiming } from './sync/reconciler-timing.js';
import type { SyncResponderSnapshotLimitsConfig } from './sync/responder/snapshot-policy.js';

/** Resource inputs are derived from the resolver, not from a second omission list.
 * selectedRecoveryContextGraphIds is synthesized during startup, not a raw agent option.
 */
export type RawResourceResolutionInput = Pick<
  DKGAgentConfig,
  Extract<keyof Parameters<typeof resolveStartupResourcePolicy>[0], keyof DKGAgentConfig>
>;

/** Protocol inputs consumed by startup; the one place they are enumerated. */
type ProtocolResolutionInput = Pick<DKGAgentConfig,
  | 'rfc64PublicCatalogActivation' | 'rfc64CatalogActivation' | 'rfc64CatalogActivations'
  | 'rfc64CatalogDeploymentProfile' | 'rfc64PublicCatalogAutoPublish'
  | 'rfc64PublicCatalogBootstrap' | 'contextGraphSubscriptionRehydrationEnabled'
>;

/**
 * Every construction-only input. This key set drives the resolved type's
 * omission, and {@link resolveAgentConfig} proves at compile time that its
 * destructuring removes each of these keys at runtime.
 */
export type AgentConfigResolutionInputKey = keyof RawResourceResolutionInput | keyof ProtocolResolutionInput;

export type StorageAckNormalizedDKGAgentConfig = Omit<
  DKGAgentConfig,
  'storageAckTiming' | 'ackHandlerDeadlineMs' | 'ackSendTimeoutMs'
> & { storageAckTiming: StorageAckTiming };

export type ResolvedDKGAgentConfig =
  Omit<
    DKGAgentConfig,
    | 'storageAckTiming'
    | 'ackHandlerDeadlineMs'
    | 'ackSendTimeoutMs'
    | AgentConfigResolutionInputKey
  > & {
    contextGraphSubscriptionRehydrationEnabled: boolean;
    storageAckTiming: StorageAckTiming;
    /** Executable startup resource policy and the diagnostics derived from it. */
    resourcePolicy: StartupResourcePolicy;
    rfc64CatalogDeploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
    rfc64CatalogBootstrap?: Readonly<Rfc64CatalogBootstrapConfigV1>;
    /** Sole immutable restart-stable D17/D18 runtime authority for this boot. */
    rfc64CatalogExecutionPlan: import('./rfc64/catalog-rollout-authority-v1.js')
      .Rfc64CatalogExecutionPlanV1;
    rfc64CatalogAuthoringPolicy?: ResolvedRfc64CatalogAuthoringPolicyV1;
    rfc64PublicCatalogBootstrap?: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
  };

/**
 * Fields the pre-policy resolved config exposed. They are projections of
 * `resourcePolicy` (environment and defaults applied), retained only for
 * consumers compiled against the historical `dkg-agent-types` declaration.
 * Internal code sees {@link ResolvedDKGAgentConfig}, which omits them.
 */
export interface LegacyResolvedConfigProjection {
  /** @deprecated Read `resourcePolicy.reconcilerTiming` for the effective policy. */
  readonly syncReconcilerTiming: SyncReconcilerTiming;
  /** @deprecated Historical caller input; read `resourcePolicy.admission.limit` for the effective limit. */
  readonly syncGlobalMaxInflight?: number;
  /** @deprecated Historical caller input; read `resourcePolicy.admission.limit` for the effective limit. */
  readonly syncGlobalLimit?: number;
  /** @deprecated Historical caller input; read `resourcePolicy.admission.queueLimit` for the effective limit. */
  readonly syncGlobalQueueLimit?: number;
  /** @deprecated Historical caller input; read `resourcePolicy.admission` for the effective policy. */
  readonly syncAdmission?: SyncAdmissionConfig;
  /** @deprecated Historical caller input; read `resourcePolicy.snapshot.budget` for the effective budget. */
  readonly syncResponderSnapshotLimits?: SyncResponderSnapshotLimitsConfig;
}

/** The historical resolved-config contract: the canonical model plus deprecated projections. */
export type LegacyResolvedDKGAgentConfig = ResolvedDKGAgentConfig & LegacyResolvedConfigProjection;

/** Preserve exactly what the pre-policy resolved config exposed to callers. */
export function projectLegacyResolvedConfig(
  config: StorageAckNormalizedDKGAgentConfig,
): LegacyResolvedConfigProjection {
  return {
    syncReconcilerTiming: resolveSyncReconcilerTiming(config),
    syncGlobalMaxInflight: config.syncGlobalMaxInflight,
    syncGlobalLimit: config.syncGlobalLimit,
    syncGlobalQueueLimit: config.syncGlobalQueueLimit,
    syncAdmission: cloneSyncAdmission(config.syncAdmission),
    syncResponderSnapshotLimits: cloneSnapshotLimits(config.syncResponderSnapshotLimits),
  };
}

function cloneSyncAdmission(config: SyncAdmissionConfig | undefined): SyncAdmissionConfig | undefined {
  if (config === undefined) return undefined;
  return {
    ...config,
    ...(config.fast === undefined ? {} : { fast: { ...config.fast } }),
    ...(config.slow === undefined ? {} : { slow: { ...config.slow } }),
  };
}

function cloneSnapshotLimits(
  config: SyncResponderSnapshotLimitsConfig | undefined,
): SyncResponderSnapshotLimitsConfig | undefined {
  if (config === undefined) return undefined;
  return {
    ...(config.global === undefined ? {} : { global: { ...config.global } }),
    ...(config.local === undefined ? {} : { local: { ...config.local } }),
  };
}

/**
 * The historical fields remain readable through an isolated prototype facade,
 * but are neither own properties nor writable copies on the canonical runtime
 * object. Object enumeration/serialization therefore sees only canonical
 * fields, and every structured compatibility read receives a fresh snapshot.
 */
function attachLegacyResolvedConfigView(
  runtime: ResolvedDKGAgentConfig,
  projection: LegacyResolvedConfigProjection,
): LegacyResolvedDKGAgentConfig {
  const compatibilityPrototype = Object.create(Object.prototype) as object;
  Object.defineProperties(compatibilityPrototype, {
    syncReconcilerTiming: {
      configurable: false,
      enumerable: false,
      get: () => ({ ...projection.syncReconcilerTiming }),
    },
    syncGlobalMaxInflight: {
      configurable: false,
      enumerable: false,
      get: () => projection.syncGlobalMaxInflight,
    },
    syncGlobalLimit: {
      configurable: false,
      enumerable: false,
      get: () => projection.syncGlobalLimit,
    },
    syncGlobalQueueLimit: {
      configurable: false,
      enumerable: false,
      get: () => projection.syncGlobalQueueLimit,
    },
    syncAdmission: {
      configurable: false,
      enumerable: false,
      get: () => cloneSyncAdmission(projection.syncAdmission),
    },
    syncResponderSnapshotLimits: {
      configurable: false,
      enumerable: false,
      get: () => cloneSnapshotLimits(projection.syncResponderSnapshotLimits),
    },
  });
  return Object.assign(Object.create(compatibilityPrototype), runtime) as LegacyResolvedDKGAgentConfig;
}

/** Values resolved by startup after ACK normalization and protocol admission. */
export type AgentConfigResolvedValues = Pick<ResolvedDKGAgentConfig,
  | 'genesisId' | 'networkIdentity' | 'rfc64CatalogAccessPolicyAuthority'
  | 'rfc64CatalogDeploymentProfile' | 'rfc64CatalogBootstrap'
  | 'rfc64CatalogAuthoringPolicy' | 'rfc64CatalogExecutionPlan'
  | 'rfc64PublicCatalogBootstrap' | 'contextGraphSubscriptionRehydrationEnabled'
  | 'resourcePolicy'
>;

/**
 * One checked boundary between normalized construction inputs and runtime
 * configuration. Deprecated reads are supplied by a non-enumerable,
 * read-only compatibility facade; internal consumers receive the result
 * through the canonical type and the runtime object owns no duplicate fields.
 */
export function resolveAgentConfig(
  config: StorageAckNormalizedDKGAgentConfig,
  resolved: AgentConfigResolvedValues,
): LegacyResolvedDKGAgentConfig {
  const legacyProjection = projectLegacyResolvedConfig(config);
  const {
    syncReconcilerIntervalMs: _syncReconcilerIntervalMs,
    syncStalenessThresholdMs: _syncStalenessThresholdMs,
    syncBackoffBaseMs: _syncBackoffBaseMs,
    syncBackoffMaxMs: _syncBackoffMaxMs,
    syncBackoffJitter: _syncBackoffJitter,
    syncGlobalMaxInflight: _syncGlobalMaxInflight,
    syncGlobalLimit: _syncGlobalLimit,
    syncGlobalQueueLimit: _syncGlobalQueueLimit,
    syncAdmission: _syncAdmission,
    syncResponderSnapshotLimits: _syncResponderSnapshotLimits,
    rfc64PublicCatalogActivation: _rfc64PublicCatalogActivation,
    rfc64CatalogActivation: _rfc64CatalogActivation,
    rfc64CatalogActivations: _rfc64CatalogActivations,
    rfc64CatalogDeploymentProfile: _rfc64CatalogDeploymentProfile,
    rfc64PublicCatalogAutoPublish: _rfc64PublicCatalogAutoPublish,
    rfc64PublicCatalogBootstrap: _rfc64PublicCatalogBootstrap,
    contextGraphSubscriptionRehydrationEnabled: _contextGraphSubscriptionRehydrationEnabled,
    ...retained
  } = config;
  // Omit alone allows extra properties through structural assignment. The
  // never-valued fields make an unremoved future resolver input a compile error.
  const runtimeInput = retained satisfies
    Omit<StorageAckNormalizedDKGAgentConfig, AgentConfigResolutionInputKey>
    & Partial<Record<AgentConfigResolutionInputKey, never>>;
  const runtime: ResolvedDKGAgentConfig = { ...runtimeInput, ...resolved };
  return attachLegacyResolvedConfigView(runtime, legacyProjection);
}
