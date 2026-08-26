// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
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

import {
  resolveRfc64CatalogActivationConfigV1,
  resolveRfc64CatalogActivationsV1,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import { mergeRfc64CatalogBootstrapsV1 } from '../src/dkg-agent.js';

const NETWORK = 'otp:20430' as NetworkIdV1;
const PRIVATE_CG = (
  '0x1111111111111111111111111111111111111111/private-release-1'
) as ContextGraphIdV1;
const PUBLIC_CG = (
  '0x1111111111111111111111111111111111111111/public-compat'
) as ContextGraphIdV1;
const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const LOCAL = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const PROVIDER = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const OUTSIDER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const PROVIDER_TWO = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const PROVIDER_PEER = '12D3KooPrivateProvider';
const PROVIDER_TWO_PEER = '12D3KooPrivateProviderTwo';
const HOLDER_PEER = '12D3KooPrivateHolder';

function policy(contextGraphId: ContextGraphIdV1, accessPolicy: 0 | 1): ContextGraphPolicyV1 {
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

function policyEnvelope(input: ContextGraphPolicyV1): UnsignedContextGraphPolicyEnvelopeV1 {
  return {
    issuer: OWNER,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: input,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  };
}

function rosterEnvelope(
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

function privateActivation(options: {
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

function publicBootstrapPolicy(index: number, targetCount = 0) {
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

const chainIdentity = resolveRfc64PublicCatalogActivationChainIdentityV1(NETWORK);

describe('RFC-64 private catalog activation', () => {
  it('accepts one exact private policy, roster, provider, and local member', () => {
    const resolved = resolveRfc64CatalogActivationConfigV1(
      privateActivation(),
      chainIdentity,
    );

    expect(resolved).toMatchObject({
      enabled: true,
      selectedContextGraphs: [PRIVATE_CG],
      selectedPublicContextGraphs: [],
      selectedPrivateContextGraphs: [PRIVATE_CG],
      accessPolicyAuthority: {
        localAgentAddress: LOCAL,
        peerAgentBindings: [{ peerId: PROVIDER_PEER, agentAddress: PROVIDER }],
      },
    });
    expect(resolved.bootstrap?.acceptedPolicies[0]?.rosterEnvelope?.payload.policyDigest)
      .toBe(computeContextGraphPolicyObjectDigestV1(
        resolved.bootstrap.acceptedPolicies[0]!.policyEnvelope,
      ));
    expect(Object.isFrozen(resolved.bootstrap?.acceptedPolicies[0]?.rosterEnvelope)).toBe(true);
  });

  it('accepts registered private policies for the Release 2 runtime', () => {
    const registeredPolicy: ContextGraphPolicyV1 = {
      ...policy(PRIVATE_CG, 1),
      governanceChainId: '20430',
      governanceContractAddress: OUTSIDER,
      source: {
        kind: 'finalized-chain',
        chainId: '20430',
        contractAddress: OUTSIDER,
        blockNumber: '42',
        blockHash: `0x${'55'.repeat(32)}`,
      },
    };
    const registeredEnvelope = policyEnvelope(registeredPolicy);
    const activation = privateActivation({
      roster: rosterEnvelope(registeredEnvelope),
    });
    const resolved = resolveRfc64CatalogActivationConfigV1({
      ...activation,
      bootstrap: {
        ...activation.bootstrap,
        acceptedPolicies: [{
          ...activation.bootstrap.acceptedPolicies[0],
          policyEnvelope: registeredEnvelope,
        }],
      },
    }, chainIdentity);

    expect(resolved).toMatchObject({
      enabled: true,
      selectedPrivateContextGraphs: [PRIVATE_CG],
      bootstrap: {
        acceptedPolicies: [{
          policyEnvelope: {
            payload: {
              accessPolicy: 1,
              source: { kind: 'finalized-chain' },
            },
          },
        }],
      },
    });
  });

  it('fails closed on missing or policy-mismatched private roster authority', () => {
    const activation = privateActivation();
    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...activation,
      bootstrap: {
        acceptedPolicies: [{
          ...activation.bootstrap.acceptedPolicies[0],
          rosterEnvelope: undefined,
        }],
      },
    } as never, chainIdentity)).toThrow(/private policies require rosterEnvelope/u);

    const mismatched = rosterEnvelope(policyEnvelope(policy(PUBLIC_CG, 1)));
    expect(() => resolveRfc64CatalogActivationConfigV1(
      privateActivation({ roster: mismatched }),
      chainIdentity,
    )).toThrow(/not bound to the exact accepted policy/u);
  });

  it('requires exact bound current provider and local membership', () => {
    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      accessPolicyAuthority: {
        localAgentAddress: LOCAL,
        peerAgentBindings: [],
      },
    }, chainIdentity)).toThrow(/has no exact peerAgentBinding/u);

    const envelope = policyEnvelope(policy(PRIVATE_CG, 1));
    expect(() => resolveRfc64CatalogActivationConfigV1(privateActivation({
      roster: rosterEnvelope(envelope, { localMember: false }),
    }), chainIdentity)).toThrow(/localAgentAddress is not a current member/u);

    expect(() => resolveRfc64CatalogActivationConfigV1(privateActivation({
      roster: rosterEnvelope(envelope, { providerRole: false }),
    }), chainIdentity)).toThrow(/not a current roster provider/u);
  });

  it('allows a provider to bind a holder-only current member for inbound reads', () => {
    const activation = privateActivation({ localAgentAddress: PROVIDER });
    const resolved = resolveRfc64CatalogActivationConfigV1({
      ...activation,
      accessPolicyAuthority: {
        ...activation.accessPolicyAuthority,
        peerAgentBindings: [
          ...activation.accessPolicyAuthority.peerAgentBindings,
          { peerId: HOLDER_PEER, agentAddress: LOCAL },
        ],
      },
    }, chainIdentity);

    expect(resolved.accessPolicyAuthority?.peerAgentBindings).toContainEqual({
      peerId: HOLDER_PEER,
      agentAddress: LOCAL,
    });
  });

  it('accepts multiple complete providers and keeps every target on the exact ordered set', () => {
    const multiProvider = resolveRfc64CatalogActivationConfigV1(
      privateActivation({ providers: [PROVIDER_PEER, PROVIDER_TWO_PEER] }),
      chainIdentity,
    );
    expect(multiProvider.bootstrap?.acceptedPolicies[0]).toMatchObject({
      completeSwmProviders: [PROVIDER_PEER, PROVIDER_TWO_PEER],
      targets: [{ providers: [PROVIDER_PEER, PROVIDER_TWO_PEER] }],
    });

    const activation = privateActivation();
    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...activation,
      bootstrap: {
        ...activation.bootstrap,
        acceptedPolicies: [{
          ...activation.bootstrap.acceptedPolicies[0],
          targets: [{ authorAddress: PROVIDER, providers: ['12D3KooOtherProvider'] }],
        }],
      },
    }, chainIdentity)).toThrow(/must use the exact completeSwmProviders list/u);

    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...activation,
      bootstrap: {
        ...activation.bootstrap,
        acceptedPolicies: [{
          ...activation.bootstrap.acceptedPolicies[0],
          targets: [{ authorAddress: OUTSIDER, providers: [PROVIDER_PEER] }],
        }],
      },
    }, chainIdentity)).toThrow(/target author is not a current roster member/u);
  });

  it('keeps public compatibility, unions disjoint blocks, and rejects overlap conflicts', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const publicCatalog = {
      bootstrap: {
        acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
        retryIntervalMs: 1_000,
      },
    } as const;
    const union = resolveRfc64CatalogActivationsV1({
      catalog: privateActivation(),
      publicCatalog,
    }, chainIdentity);
    expect(union.catalog.selectedContextGraphs).toEqual([PUBLIC_CG, PRIVATE_CG]);
    expect(union.publicCatalog.selectedContextGraphs).toEqual([PUBLIC_CG]);

    const conflictingPublic = {
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(policy(PRIVATE_CG, 0)),
          targets: [],
        }],
        retryIntervalMs: 1_000,
      },
    } as const;
    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: privateActivation(),
      publicCatalog: conflictingPublic,
    }, chainIdentity)).toThrow(/conflict for selected graph/u);
  });

  it('enforces the global policy limit after additive and compatibility blocks are merged', () => {
    const additivePolicies = Array.from(
      { length: 32 },
      (_, index) => publicBootstrapPolicy(index),
    );
    const compatibilityPolicies = Array.from(
      { length: 33 },
      (_, index) => publicBootstrapPolicy(index + additivePolicies.length),
    );

    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: {
        bootstrap: {
          acceptedPolicies: additivePolicies,
          retryIntervalMs: 1_000,
        },
      },
      publicCatalog: {
        bootstrap: {
          acceptedPublicPolicies: compatibilityPolicies,
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity)).toThrow(/acceptedPolicies must contain at most 64 policies/u);
  });

  it('enforces the global target limit after additive and compatibility blocks are merged', () => {
    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: {
        bootstrap: {
          acceptedPolicies: [publicBootstrapPolicy(0, 128)],
          retryIntervalMs: 1_000,
        },
      },
      publicCatalog: {
        bootstrap: {
          acceptedPublicPolicies: [publicBootstrapPolicy(1, 129)],
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity)).toThrow(/targets must contain at most 256 catalogs/u);
  });

  it('merges additive private bootstrap with legacy public bootstrap without dropping either', () => {
    const privateBootstrap = privateActivation().bootstrap;
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const legacyPublic = {
      acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
      retryIntervalMs: 1_000,
    } as const;

    const merged = mergeRfc64CatalogBootstrapsV1(privateBootstrap, legacyPublic);

    expect(merged?.acceptedPolicies.map(({ policyEnvelope: envelope }) => (
      envelope.payload.contextGraphId
    ))).toEqual([PRIVATE_CG, PUBLIC_CG]);
    expect(merged?.retryIntervalMs).toBe(1_000);
    expect(() => mergeRfc64CatalogBootstrapsV1(privateBootstrap, {
      ...legacyPublic,
      acceptedPublicPolicies: [{
        policyEnvelope: privateBootstrap.acceptedPolicies[0]!.policyEnvelope,
        targets: [],
      }],
    })).toThrow(/configured twice/u);
  });
});
