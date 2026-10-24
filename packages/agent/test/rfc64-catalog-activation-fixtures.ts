// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  MEMBER_ROSTER_OBJECT_TYPE_V1,
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
  type UnsignedMemberRosterEnvelopeV1,
} from '@origintrail-official/dkg-core';

import { resolveRfc64PublicCatalogActivationChainIdentityV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';

export const NETWORK = 'otp:20430' as NetworkIdV1;
export const PRIVATE_CG = (
  '0x1111111111111111111111111111111111111111/private-release-1'
) as ContextGraphIdV1;
export const PUBLIC_CG = (
  '0x1111111111111111111111111111111111111111/public-compat'
) as ContextGraphIdV1;
export const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
export const LOCAL = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
export const PROVIDER = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
export const OUTSIDER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
export const PROVIDER_TWO = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
export const PROVIDER_PEER = '12D3KooPrivateProvider';
export const PROVIDER_TWO_PEER = '12D3KooPrivateProviderTwo';
export const HOLDER_PEER = '12D3KooPrivateHolder';

export function policy(
  contextGraphId: ContextGraphIdV1,
  accessPolicy: 0 | 1,
): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: OWNER,
      ownerAuthorityEra: '0',
    },
    effectiveAt: '0',
    issuedAt: '0',
  };
}

export function policyEnvelope(
  input: ContextGraphPolicyV1,
): UnsignedContextGraphPolicyEnvelopeV1 {
  return {
    issuer: OWNER,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: input,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  };
}

export function rosterEnvelope(
  acceptedPolicyEnvelope: UnsignedContextGraphPolicyEnvelopeV1,
  options: { localMember?: boolean; providerRole?: boolean } = {},
): UnsignedMemberRosterEnvelopeV1 {
  const policyDigest = computeContextGraphPolicyObjectDigestV1(acceptedPolicyEnvelope);
  const payload: MemberRosterV1 = {
    networkId: acceptedPolicyEnvelope.payload.networkId,
    contextGraphId: acceptedPolicyEnvelope.payload.contextGraphId,
    ownershipTransitionDigest: acceptedPolicyEnvelope.payload.ownershipTransitionDigest,
    era: acceptedPolicyEnvelope.payload.era,
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest:
      acceptedPolicyEnvelope.payload.administrativeDelegationDigest,
    members: [
      ...(options.localMember === false
        ? []
        : [{ agentAddress: LOCAL, roles: ['holder'] as const }]),
      {
        agentAddress: PROVIDER,
        roles: options.providerRole === false
          ? ['holder'] as const
          : ['holder', 'provider'] as const,
      },
      { agentAddress: PROVIDER_TWO, roles: ['holder', 'provider'] as const },
    ],
    issuedAt: '0',
  };
  return {
    issuer: OWNER,
    objectType: MEMBER_ROSTER_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  };
}

export function privateActivation(options: {
  roster?: UnsignedMemberRosterEnvelopeV1;
  localAgentAddress?: EvmAddressV1;
  boundAgentAddress?: EvmAddressV1;
  providers?: readonly string[];
} = {}) {
  const envelope = policyEnvelope(policy(PRIVATE_CG, 1));
  const providers = options.providers ?? [PROVIDER_PEER];
  return {
    bootstrap: {
      acceptedPolicies: [{
        policyEnvelope: envelope,
        rosterEnvelope: options.roster ?? rosterEnvelope(envelope),
        targets: [{ authorAddress: PROVIDER, providers }],
        completeSwmProviders: providers,
      }],
      retryIntervalMs: 1_000,
    },
    accessPolicyAuthority: {
      localAgentAddress: options.localAgentAddress ?? LOCAL,
      peerAgentBindings: [{
        peerId: PROVIDER_PEER,
        agentAddress: options.boundAgentAddress ?? PROVIDER,
      }, ...(providers.includes(PROVIDER_TWO_PEER)
        ? [{ peerId: PROVIDER_TWO_PEER, agentAddress: PROVIDER_TWO }]
        : [])],
    },
  } as const;
}

export function publicBootstrapPolicy(index: number, targetCount = 0) {
  const contextGraphId = `${OWNER}/bounded-public-${index}` as ContextGraphIdV1;
  return {
    policyEnvelope: policyEnvelope(policy(contextGraphId, 0)),
    targets: Array.from({ length: targetCount }, (_, targetIndex) => ({
      authorAddress: `0x${(
        BigInt(index + 1) * 1_000n + BigInt(targetIndex + 1)
      ).toString(16).padStart(40, '0')}` as EvmAddressV1,
      providers: [PROVIDER_PEER],
    })),
  } as const;
}

export const chainIdentity =
  resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK);
