import type { CatalogSealDeploymentProfileV1 } from '@origintrail-official/dkg-core';
import type { StorageAckTiming } from '@origintrail-official/dkg-publisher';
import type { DKGAgentConfig, Rfc64CatalogBootstrapConfigV1, Rfc64PublicCatalogBootstrapConfigV1 } from './dkg-agent-types.js';
import type { ResolvedRfc64CatalogAuthoringPolicyV1 } from './rfc64/public-catalog-activation-config-v1.js';
import type { StartupResourcePolicy, resolveStartupResourcePolicy } from './resource-policy.js';
import type { SyncAdmissionConfig } from './sync/policy.js';
import type { SyncReconcilerTiming } from './sync/reconciler-timing.js';
import type { SyncResponderSnapshotLimitsConfig } from './sync/responder/snapshot-policy.js';

/** Resource inputs are derived from the resolver, not from a second omission list.
 * selectedRecoveryContextGraphIds is synthesized during startup, not a raw agent option.
 */
export type RawResourceResolutionInput = Pick<
  DKGAgentConfig,
  Extract<keyof Parameters<typeof resolveStartupResourcePolicy>[0], keyof DKGAgentConfig>
>;

type ProtocolResolutionInput = Pick<DKGAgentConfig,
  | 'rfc64PublicCatalogActivation' | 'rfc64CatalogActivation'
  | 'rfc64CatalogDeploymentProfile' | 'rfc64PublicCatalogAutoPublish'
  | 'rfc64PublicCatalogBootstrap' | 'contextGraphSubscriptionRehydrationEnabled'
>;

/** Exhaustive diagnostic names; adding a resolver input requires naming it here. */
const resourceResolutionFields = {
  syncReconcilerIntervalMs: true, syncStalenessThresholdMs: true,
  syncBackoffBaseMs: true, syncBackoffMaxMs: true, syncBackoffJitter: true,
  syncGlobalMaxInflight: true, syncGlobalLimit: true, syncGlobalQueueLimit: true,
  syncAdmission: true, syncResponderSnapshotLimits: true,
} satisfies Record<keyof RawResourceResolutionInput, true>;
const protocolResolutionFields = {
  rfc64PublicCatalogActivation: true, rfc64CatalogActivation: true,
  rfc64CatalogDeploymentProfile: true, rfc64PublicCatalogAutoPublish: true,
  rfc64PublicCatalogBootstrap: true, contextGraphSubscriptionRehydrationEnabled: true,
} satisfies Record<keyof ProtocolResolutionInput, true>;
export const RAW_RESOURCE_CONFIG_KEYS = Object.freeze(Object.keys(resourceResolutionFields));
export const RESOLUTION_INPUT_KEYS = Object.freeze([
  ...RAW_RESOURCE_CONFIG_KEYS, ...Object.keys(protocolResolutionFields),
]);
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
  /** @deprecated Read `resourcePolicy.reconcilerTiming`. */
  readonly syncReconcilerTiming: SyncReconcilerTiming;
  /** @deprecated Read `resourcePolicy.admission.limit`; this is the effective limit. */
  readonly syncGlobalMaxInflight?: number;
  /** @deprecated Read `resourcePolicy.admission.limit`; this is the effective limit. */
  readonly syncGlobalLimit?: number;
  /** @deprecated Read `resourcePolicy.admission.queueLimit`; this is the effective limit. */
  readonly syncGlobalQueueLimit?: number;
  /** @deprecated Read `resourcePolicy.admission`; this is the effective admission policy. */
  readonly syncAdmission?: SyncAdmissionConfig;
  /** @deprecated Read `resourcePolicy.snapshot.budget`; this is the effective budget. */
  readonly syncResponderSnapshotLimits?: SyncResponderSnapshotLimitsConfig;
}

/** The historical resolved-config contract: the canonical model plus deprecated projections. */
export type LegacyResolvedDKGAgentConfig = ResolvedDKGAgentConfig & LegacyResolvedConfigProjection;

/** Every deprecated alias derives from the policy, so the runtime keeps one owner. */
export function projectLegacyResolvedConfig(
  policy: StartupResourcePolicy,
): LegacyResolvedConfigProjection {
  const { reconcilerTiming, admission, snapshot: { budget } } = policy;
  return {
    syncReconcilerTiming: reconcilerTiming,
    ...(admission.limit === undefined
      ? {}
      : { syncGlobalMaxInflight: admission.limit, syncGlobalLimit: admission.limit }),
    ...(admission.queueLimit === undefined ? {} : { syncGlobalQueueLimit: admission.queueLimit }),
    syncAdmission: {
      mode: admission.mode,
      ...(admission.limit === undefined ? {} : { globalMaxInflight: admission.limit }),
      ...(admission.partitions === undefined
        ? {}
        : { fast: admission.partitions.fast, slow: admission.partitions.slow }),
    },
    syncResponderSnapshotLimits: {
      global: { rows: budget.maxRows, bytesEstimate: budget.maxBytesEstimate },
      local: { rows: budget.maxSnapshotRows, bytesEstimate: budget.maxSnapshotBytesEstimate },
    },
  };
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
 * configuration. The result also carries the deprecated compatibility
 * projections; internal consumers receive it through the canonical type.
 */
export function resolveAgentConfig(
  config: StorageAckNormalizedDKGAgentConfig,
  resolved: AgentConfigResolvedValues,
): LegacyResolvedDKGAgentConfig {
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
  return { ...runtime, ...projectLegacyResolvedConfig(resolved.resourcePolicy) };
}
