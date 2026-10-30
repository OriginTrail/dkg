import { isRfc64PublicOnlyAuthoringExclusionV1 } from '../rfc64/catalog-rollout-authority-v1.js';
import { assertContextGraphIdV1, type NetworkIdV1 } from '@origintrail-official/dkg-core';
import type { ResolvedDKGAgentConfig } from '../dkg-agent-types.js';
import type { Rfc64PublicCatalogServiceV1 } from '../rfc64/public-catalog-service-v1.js';
import type { DKGAgent } from '../dkg-agent.js';
import { SwmCatalogAuthorityNotReady } from './swm-inventory-write.js';

type CatalogAuthoringApplicability =
  | { status: 'excluded'; reason: 'legacy' | 'kill-switch' | 'named-subgraph' | 'public-only' }
  | { status: 'required'; authority: ReturnType<DKGAgent['resolveRfc64CatalogReceiverAuthorityV1']> }
  | { status: 'unavailable'; error: SwmCatalogAuthorityNotReady };

/** Deliberate scope exclusions only. Temporary readiness cannot erase ownership. */
export function catalogAuthoringApplicability(
  input: { authority: ReturnType<DKGAgent['resolveRfc64CatalogReceiverAuthorityV1']>;
    config: ResolvedDKGAgentConfig; service: Rfc64PublicCatalogServiceV1 | undefined },
  contextGraphId: string, subGraphName: string | null | undefined,
): CatalogAuthoringApplicability {
  const { authority, config, service } = input;
  if (subGraphName !== undefined && subGraphName !== null) return { status: 'excluded', reason: 'named-subgraph' };
  if (authority.mode === 'legacy') return { status: 'excluded', reason: 'legacy' };
  if (authority.killSwitchActive) return { status: 'excluded', reason: 'kill-switch' };
  const policy = config.rfc64CatalogAuthoringPolicy;
  if (policy?.publicDefault === undefined || policy.byContextGraph[contextGraphId] !== undefined) {
    return { status: 'required', authority };
  }
  // Only accepted policy can establish the public-only fallback exclusion.
  // Caller-supplied workspace policy cannot waive a catalog obligation.
  assertContextGraphIdV1(contextGraphId, 'catalog authoring contextGraphId');
  const networkId = config.rfc64CatalogDeploymentProfile?.networkId ?? config.networkIdentity?.chainId;
  if (service === undefined) return { status: 'unavailable', error: new SwmCatalogAuthorityNotReady('service-unavailable') };
  const accepted = networkId === undefined ? null : service.acceptedPolicySnapshot(networkId as NetworkIdV1, contextGraphId);
  if (accepted === null) return { status: 'unavailable', error: new SwmCatalogAuthorityNotReady('policy-not-accepted') };
  return isRfc64PublicOnlyAuthoringExclusionV1(policy, contextGraphId, accepted.policy.accessPolicy)
    ? { status: 'excluded', reason: 'public-only' }
    : { status: 'required', authority };
}
