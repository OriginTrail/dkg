// SPDX-License-Identifier: Apache-2.0

import { assertNetworkIdV1, assertContextGraphIdV1, type NetworkIdV1, type ContextGraphIdV1 } from '@origintrail-official/dkg-core';
import type { ResolvedDKGAgentConfig } from '../dkg-agent-types.js';
import type { Rfc64PublicCatalogServiceV1 } from './public-catalog-service-v1.js';

/** Accepted private roster resolution preserves fail-closed configured selections and live join proof. */
export function resolveRfc64PrivateReadRoster(input: {
  readonly config: Pick<ResolvedDKGAgentConfig, 'networkIdentity' | 'rfc64CatalogBootstrap'>;
  readonly service: Pick<Rfc64PublicCatalogServiceV1, 'acceptedPolicySnapshot'> | undefined;
  readonly isJoinDerived: (contextGraphId: string) => boolean;
}, contextGraphId: string): readonly string[] | null | undefined {
    const service = input.service;
    // RFC-64 policies are keyed by the effective namespaced chain network
    // (for example `otp:20430`). `networkIdentity.networkId` is the DKG
    // genesis hash and must never be used as catalog-policy authority.
    const activeNetworkId = input.config.networkIdentity?.chainId;
    if (service !== undefined && activeNetworkId !== undefined) {
      let canonicalNetworkId: NetworkIdV1 | null = null;
      let canonicalContextGraphId: ContextGraphIdV1 | null = null;
      try {
        assertNetworkIdV1(activeNetworkId);
        assertContextGraphIdV1(contextGraphId);
        canonicalNetworkId = activeNetworkId;
        canonicalContextGraphId = contextGraphId;
      } catch {
        // Non-RFC-64 identifiers continue through the legacy authorization path.
      }
      if (canonicalNetworkId !== null && canonicalContextGraphId !== null) {
        const current = service.acceptedPolicySnapshot(
          canonicalNetworkId,
          canonicalContextGraphId,
        );
        if (current !== null) {
          if (current.policy.accessPolicy !== 1) return undefined;
          // A join-derived roster never authorizes a read on its own.
          if (input.isJoinDerived(contextGraphId) === true) {
            return undefined;
          }
          if (current.roster === null) return null;
          return Object.freeze(
            current.roster.members.map(({ agentAddress }) => agentAddress),
          );
        }
      }
    }

    // A configured private selection remains fail-closed until its authority
    // is accepted into the live registry. Bootstrap is a liveness/source hint,
    // not the ownership boundary for query authorization.
    const configured = input.config.rfc64CatalogBootstrap?.acceptedPolicies.filter(
      ({ policyEnvelope }) => (
        policyEnvelope.payload.contextGraphId === contextGraphId
        && policyEnvelope.payload.accessPolicy === 1
      ),
    ) ?? [];
    if (configured.length === 0) return undefined;
    if (service === undefined) return null;

    for (const { policyEnvelope } of configured) {
      const policy = policyEnvelope.payload;
      const current = service.acceptedPolicySnapshot(
        policy.networkId,
        policy.contextGraphId,
      );
      if (
        current !== null
        && current.policy.accessPolicy === 1
        && current.roster !== null
      ) {
        return Object.freeze(current.roster.members.map(({ agentAddress }) => agentAddress));
      }
    }
    return null;
  }
