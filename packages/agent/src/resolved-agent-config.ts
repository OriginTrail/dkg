import type { CatalogSealDeploymentProfileV1 } from '@origintrail-official/dkg-core';
import type { StorageAckTiming } from '@origintrail-official/dkg-publisher';
import type { DKGAgentConfig, Rfc64CatalogBootstrapConfigV1, Rfc64PublicCatalogBootstrapConfigV1 } from './dkg-agent-types.js';
import type { ResolvedRfc64CatalogAuthoringPolicyV1 } from './rfc64/public-catalog-activation-config-v1.js';
import type { StartupResourcePolicy, resolveStartupResourcePolicy } from './resource-policy.js';

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

/** Values resolved by startup after ACK normalization and protocol admission. */
export type AgentConfigResolvedValues = Pick<ResolvedDKGAgentConfig,
  | 'genesisId' | 'networkIdentity' | 'rfc64CatalogAccessPolicyAuthority'
  | 'rfc64CatalogDeploymentProfile' | 'rfc64CatalogBootstrap'
  | 'rfc64CatalogAuthoringPolicy' | 'rfc64CatalogExecutionPlan'
  | 'rfc64PublicCatalogBootstrap' | 'contextGraphSubscriptionRehydrationEnabled'
  | 'resourcePolicy'
>;

/** One checked boundary between normalized construction inputs and runtime configuration. */
export function resolveAgentConfig(
  config: StorageAckNormalizedDKGAgentConfig,
  resolved: AgentConfigResolvedValues,
): ResolvedDKGAgentConfig {
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
  return { ...runtimeInput, ...resolved };
}
