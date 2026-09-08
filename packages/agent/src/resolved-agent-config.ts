import type { DKGAgentConfig } from './dkg-agent-types.js';

/** Consumed resource settings never remain on the runtime config. */
export const RAW_RESOURCE_CONFIG_KEYS = [
  'syncReconcilerIntervalMs', 'syncStalenessThresholdMs',
  'syncBackoffBaseMs', 'syncBackoffMaxMs', 'syncBackoffJitter',
  'syncGlobalMaxInflight', 'syncGlobalLimit', 'syncGlobalQueueLimit',
  'syncAdmission', 'syncResponderSnapshotLimits',
] as const satisfies readonly (keyof DKGAgentConfig)[];

/** Other construction inputs are removed before their resolved values are added. */
const RESOLUTION_INPUT_KEYS = [
  ...RAW_RESOURCE_CONFIG_KEYS,
  'rfc64PublicCatalogActivation', 'rfc64CatalogActivation',
  'rfc64CatalogDeploymentProfile', 'rfc64PublicCatalogAutoPublish',
  'rfc64PublicCatalogBootstrap', 'contextGraphSubscriptionRehydrationEnabled',
] as const satisfies readonly (keyof DKGAgentConfig)[];

export type AgentConfigResolutionInputKey = typeof RESOLUTION_INPUT_KEYS[number];
const resolutionInputKeys: ReadonlySet<string> = new Set(RESOLUTION_INPUT_KEYS);

/** Preserve already-normalized fields (such as ACK timing) without mutating input. */
export function omitAgentConfigResolutionInputs<T extends DKGAgentConfig>(
  config: T,
): Omit<T, AgentConfigResolutionInputKey> {
  // Object.entries loses key/value correlation; the fixed key set defines both
  // this projection and the runtime config's declared omission boundary.
  return Object.fromEntries(Object.entries(config).filter(([key]) => !resolutionInputKeys.has(key))) as Omit<T, AgentConfigResolutionInputKey>;
}
