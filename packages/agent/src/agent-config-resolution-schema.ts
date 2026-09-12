import type { CatalogSealDeploymentProfileV1 } from '@origintrail-official/dkg-core';
import type { StorageAckTiming } from '@origintrail-official/dkg-publisher';
import type { DKGAgentConfig, Rfc64CatalogBootstrapConfigV1, Rfc64PublicCatalogBootstrapConfigV1 } from './dkg-agent-types.js';
import type { ResolvedRfc64CatalogAuthoringPolicyV1 } from './rfc64/public-catalog-activation-config-v1.js';
import type { StartupResourcePolicy } from './resource-policy.js';

/** Consumed resource settings never remain on the runtime config. */
export const RAW_RESOURCE_CONFIG_KEYS = [
  'syncReconcilerIntervalMs', 'syncStalenessThresholdMs',
  'syncBackoffBaseMs', 'syncBackoffMaxMs', 'syncBackoffJitter',
  'syncGlobalMaxInflight', 'syncGlobalLimit', 'syncGlobalQueueLimit',
  'syncAdmission', 'syncResponderSnapshotLimits',
] as const satisfies readonly (keyof DKGAgentConfig)[];

/** Other construction inputs are removed before their resolved values are added. */
export const RESOLUTION_INPUT_KEYS = [
  ...RAW_RESOURCE_CONFIG_KEYS,
  'rfc64PublicCatalogActivation', 'rfc64CatalogActivation',
  'rfc64CatalogDeploymentProfile', 'rfc64PublicCatalogAutoPublish',
  'rfc64PublicCatalogBootstrap', 'contextGraphSubscriptionRehydrationEnabled',
] as const satisfies readonly (keyof DKGAgentConfig)[];

export type AgentConfigResolutionInputKey = typeof RESOLUTION_INPUT_KEYS[number];

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
