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
  rfc64CatalogKillSwitchActiveV1,
  rfc64CatalogRolloutModeForContextGraphV1,
  rfc64LegacySyncAuthorityActiveForContextGraphV1,
  projectRfc64CatalogReceiverAuthorityV1,
  resolveRfc64CatalogAuthorityDecisionV1,
  resolveRfc64CatalogConfiguredAuthorityDecisionV1,
  resolveRfc64CatalogActivationConfigV1,
  resolveRfc64CatalogActivationInputV1,
  resolveRfc64CatalogActivationsV1,
  resolveRfc64LegacySyncContextGraphsV1,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
  resolveRfc64PublicCatalogActivationInputV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import {
  snapshotRfc64CatalogBootstrapConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from '../src/rfc64/catalog-authority-config-v1.js';
import {
  resolveRfc64PeerSwmRecoveryPlanV1,
  resolveRfc64PrivateRecoveryContextGraphIdsV1,
  resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1,
} from '../src/rfc64/swm-recovery-plan-v1.js';
import { DKGAgent, mergeRfc64CatalogBootstrapsV1 } from '../src/dkg-agent.js';

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
  it('reserves the exact graph-complete provider for selected private SWM recovery', () => {
    const bootstrap = snapshotRfc64CatalogBootstrapConfigV1(
      privateActivation().bootstrap,
    )!;
    const resolverAgent = {
      config: {
        rfc64CatalogBootstrap: bootstrap,
        rfc64CatalogRollout: {
          selectedContextGraphs: [PRIVATE_CG],
          rollout: {
            killSwitch: false,
            contextGraphModes: { [PRIVATE_CG]: 'shadow' },
          },
        },
      },
      resolveRfc64CatalogReceiverAuthorityV1: () => ({ legacySyncAllowed: true }),
    } as unknown as DKGAgent;

    expect(resolveRfc64PrivateRecoveryContextGraphIdsV1(bootstrap))
      .toEqual([PRIVATE_CG]);
    expect(resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(
      bootstrap,
      PROVIDER_PEER,
    )).toEqual([PRIVATE_CG]);
    expect(resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(
      bootstrap,
      '12D3KooUnconfiguredPrivateProvider',
    )).toEqual([]);
    expect(DKGAgent.prototype.resolveRfc64CompleteSwmProviderPeerIdsV1.call(
      resolverAgent,
      PRIVATE_CG,
    )).toEqual([PROVIDER_PEER]);
  });

  it('derives one mixed private/public recovery plan from snapshotted catalog config', () => {
    const privatePolicy = privateActivation().bootstrap.acceptedPolicies[0]!;
    const bootstrap = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: [
        privatePolicy,
        {
          policyEnvelope: policyEnvelope(policy(PUBLIC_CG, 0)),
          targets: [],
          completeSwmProviders: [PROVIDER_PEER],
        },
      ],
      retryIntervalMs: 1_000,
    })!;

    expect(resolveRfc64PeerSwmRecoveryPlanV1(bootstrap, PROVIDER_PEER)).toEqual({
      providerPeerId: PROVIDER_PEER,
      targets: [
        { contextGraphId: PRIVATE_CG, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC_CG, lane: 'selected-public' },
      ],
    });
  });

  it('elects one private replacement owner while retaining redundant public providers', () => {
    const privatePolicy = privateActivation({
      providers: [PROVIDER_PEER, PROVIDER_TWO_PEER],
    }).bootstrap.acceptedPolicies[0]!;
    const bootstrap = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: [
        privatePolicy,
        {
          policyEnvelope: policyEnvelope(policy(PUBLIC_CG, 0)),
          targets: [],
          completeSwmProviders: [PROVIDER_PEER, PROVIDER_TWO_PEER],
        },
      ],
    })!;

    expect(resolveRfc64PeerSwmRecoveryPlanV1(bootstrap, PROVIDER_PEER)).toEqual({
      providerPeerId: PROVIDER_PEER,
      targets: [
        { contextGraphId: PRIVATE_CG, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC_CG, lane: 'selected-public' },
      ],
    });
    expect(resolveRfc64PeerSwmRecoveryPlanV1(bootstrap, PROVIDER_TWO_PEER)).toEqual({
      providerPeerId: PROVIDER_TWO_PEER,
      targets: [{ contextGraphId: PUBLIC_CG, lane: 'selected-public' }],
    });
  });

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

  it('snapshots policy-neutral selected-catalog authoring independently from public controls', () => {
    const catalog = {
      ...privateActivation(),
      autoPublish: {
        catalogIssuerDelegationExpiresAt: '1893456000000',
      },
    } as const;
    const resolved = resolveRfc64CatalogActivationConfigV1(catalog, chainIdentity);

    expect(resolved.autoPublish).toEqual({
      catalogIssuerDelegationEffectiveAt: '0',
      catalogIssuerDelegationExpiresAt: '1893456000000',
    });
    expect(Object.isFrozen(resolved.autoPublish)).toBe(true);

    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const publicBootstrap = {
      acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
      retryIntervalMs: 1_000,
    } as const;
    const mixed = resolveRfc64CatalogActivationsV1({
      catalog: resolved,
      publicCatalog: {
        autoPublish: {
          peers: ['12D3KooPublicHint'],
          catalogIssuerDelegationExpiresAt: '1893456000000',
        },
        bootstrap: publicBootstrap,
      },
    }, chainIdentity);
    expect(mixed).toMatchObject({
      catalog: { autoPublish: resolved.autoPublish },
      publicCatalog: { autoPublish: { peers: ['12D3KooPublicHint'] } },
      selectedCatalogAuthoringControls: [{
        kind: 'selected-private',
        contextGraphId: PRIVATE_CG,
        announcementPeers: [PROVIDER_PEER],
      }],
    });
    const roundTripped = resolveRfc64CatalogActivationsV1({
      catalog: mixed.catalog,
      publicCatalog: mixed.publicCatalog,
    }, chainIdentity);
    expect(roundTripped.selectedCatalogAuthoringControls).toEqual(
      mixed.selectedCatalogAuthoringControls,
    );
    expect(roundTripped.catalog.selectedCatalogAuthoringControls).toEqual(
      mixed.selectedCatalogAuthoringControls,
    );
  });

  it('rejects selected-CG authoring before startup when provider authority is missing', () => {
    expect(() => resolveRfc64CatalogActivationsV1({
      catalog: {
        autoPublish: {
          catalogIssuerDelegationExpiresAt: '1893456000000',
        },
        bootstrap: {
          acceptedPolicies: [{
            policyEnvelope: policyEnvelope(policy(PUBLIC_CG, 0)),
            targets: [],
          }],
        },
      },
    }, chainIdentity)).toThrow(
      new RegExp(`autoPublish requires completeSwmProviders for ${PUBLIC_CG}`, 'u'),
    );
  });

  it('resolves restart-stable per-CG rollout modes without changing omitted compatibility', () => {
    const catalog = resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: {
        killSwitch: false,
        contextGraphModes: { [PRIVATE_CG]: 'shadow' },
      },
    }, chainIdentity);

    expect(rfc64CatalogRolloutModeForContextGraphV1(catalog, PRIVATE_CG)).toBe('shadow');
    expect(rfc64CatalogRolloutModeForContextGraphV1(catalog, PUBLIC_CG)).toBe('legacy');
    expect(rfc64CatalogKillSwitchActiveV1(catalog)).toBe(false);
    expect(Object.isFrozen(catalog.rollout?.contextGraphModes)).toBe(true);

    const omitted = resolveRfc64CatalogActivationConfigV1(
      privateActivation(),
      chainIdentity,
    );
    expect(rfc64CatalogRolloutModeForContextGraphV1(omitted, PRIVATE_CG)).toBe('catalog');
  });

  it('activates eligible public and private catalog rails only for explicit edge selections', () => {
    const activation = Object.freeze({
      enabled: true,
      selectedContextGraphs: Object.freeze([PUBLIC_CG, PRIVATE_CG]),
      rollout: Object.freeze({
        killSwitch: false,
        contextGraphModes: Object.freeze({
          [PUBLIC_CG]: 'catalog' as const,
          [PRIVATE_CG]: 'catalog' as const,
        }),
      }),
    });

    expect(projectRfc64CatalogReceiverAuthorityV1(
      resolveRfc64CatalogConfiguredAuthorityDecisionV1(activation, PUBLIC_CG),
      { active: false },
    )).toMatchObject({
      selected: true,
      eligible: true,
      active: false,
      mode: 'catalog',
      reconciliationLane: 'disabled',
      track2Enabled: false,
      legacySyncAllowed: false,
    });
    expect(resolveRfc64CatalogConfiguredAuthorityDecisionV1(
      activation,
      PUBLIC_CG,
    )).toMatchObject({
      selected: true,
      eligible: true,
      active: true,
      reconciliationLane: 'catalog-apply',
      track2Enabled: true,
      authoringAllowed: true,
    });
    expect(rfc64LegacySyncAuthorityActiveForContextGraphV1(
      activation,
      PUBLIC_CG,
      { active: false },
    )).toBe(false);
    expect(projectRfc64CatalogReceiverAuthorityV1(
      resolveRfc64CatalogConfiguredAuthorityDecisionV1(activation, PRIVATE_CG),
      { active: true },
    )).toMatchObject({
      selected: true,
      eligible: true,
      active: true,
      reconciliationLane: 'catalog-apply',
      track2Enabled: true,
      legacySyncAllowed: false,
    });
    expect(rfc64LegacySyncAuthorityActiveForContextGraphV1(
      activation,
      PRIVATE_CG,
      { active: true },
    )).toBe(false);
  });

  it('preserves pre-activation Track-2 authoring while keeping ordinary sync legacy', () => {
    const disabled = Object.freeze({
      enabled: false,
      selectedContextGraphs: Object.freeze([]),
      rollout: undefined,
    });
    expect(rfc64CatalogRolloutModeForContextGraphV1(disabled, PUBLIC_CG)).toBe('legacy');
    expect(rfc64LegacySyncAuthorityActiveForContextGraphV1(disabled, PUBLIC_CG)).toBe(true);
    expect(resolveRfc64CatalogAuthorityDecisionV1(disabled as never, PUBLIC_CG))
      .toMatchObject({ reconciliationLane: 'catalog-apply', authoringAllowed: true });
  });

  it('normalizes the previous release disabled resolved activation shapes', () => {
    expect(resolveRfc64PublicCatalogActivationInputV1({
      enabled: false,
      selectedContextGraphs: [],
    } as never, chainIdentity)).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
      rollout: { killSwitch: false, contextGraphModes: {} },
    });
    expect(resolveRfc64CatalogActivationInputV1({
      enabled: false,
      selectedContextGraphs: [],
      selectedPublicContextGraphs: [],
      selectedPrivateContextGraphs: [],
    } as never, chainIdentity)).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
      rollout: { killSwitch: false, contextGraphModes: {} },
    });
  });

  it('projects one legacy sync authority and never uses the kill switch as fallback', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const activation = resolveRfc64CatalogActivationsV1({
      catalog: {
        ...privateActivation(),
        rollout: {
          killSwitch: true,
          contextGraphModes: { [PRIVATE_CG]: 'catalog' },
        },
      },
      publicCatalog: {
        rollout: { contextGraphModes: { [PUBLIC_CG]: 'shadow' } },
        bootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity).catalog;

    expect(resolveRfc64LegacySyncContextGraphsV1({
      configuredContextGraphs: ['ordinary-cg', PRIVATE_CG],
      activation,
    })).toEqual(['ordinary-cg', PUBLIC_CG]);
    expect(rfc64LegacySyncAuthorityActiveForContextGraphV1(activation, PRIVATE_CG))
      .toBe(false);
    expect(rfc64CatalogKillSwitchActiveV1(activation)).toBe(true);
    const shadow = resolveRfc64CatalogConfiguredAuthorityDecisionV1(
      activation,
      PUBLIC_CG,
    );
    expect(shadow).toMatchObject({
      mode: 'shadow',
      active: false,
      track2Enabled: false,
      legacySyncAllowed: true,
    });
    expect(projectRfc64CatalogReceiverAuthorityV1(
      shadow,
      { active: false },
    )).toMatchObject({
      selected: true,
      eligible: true,
      active: false,
      mode: 'shadow',
      track2Enabled: false,
      legacySyncAllowed: false,
    });
  });

  it('fails closed on malformed, unknown, or unselected rollout modes', () => {
    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { contextGraphModes: { [PRIVATE_CG]: 'automatic' } },
    } as never, chainIdentity)).toThrow(/must be legacy, shadow, or catalog/u);

    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { contextGraphModes: { [PUBLIC_CG]: 'shadow' } },
    }, chainIdentity)).toThrow(/contains unselected graph/u);

    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { killSwitch: 'yes' },
    } as never, chainIdentity)).toThrow(/killSwitch must be a boolean/u);
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

  it('unions disjoint rollout modes and lets either block engage the shared kill switch', () => {
    const publicEnvelope = policyEnvelope(policy(PUBLIC_CG, 0));
    const union = resolveRfc64CatalogActivationsV1({
      catalog: {
        ...privateActivation(),
        rollout: { contextGraphModes: { [PRIVATE_CG]: 'catalog' } },
      },
      publicCatalog: {
        rollout: {
          killSwitch: true,
          contextGraphModes: { [PUBLIC_CG]: 'shadow' },
        },
        bootstrap: {
          acceptedPublicPolicies: [{ policyEnvelope: publicEnvelope, targets: [] }],
          retryIntervalMs: 1_000,
        },
      },
    }, chainIdentity);

    expect(rfc64CatalogRolloutModeForContextGraphV1(union.catalog, PRIVATE_CG))
      .toBe('catalog');
    expect(rfc64CatalogRolloutModeForContextGraphV1(union.catalog, PUBLIC_CG))
      .toBe('shadow');
    expect(rfc64CatalogKillSwitchActiveV1(union.catalog)).toBe(true);
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

  it('enforces the policy limit in the daemon additive/legacy bootstrap merge', () => {
    const catalog = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: Array.from(
        { length: 32 },
        (_, index) => publicBootstrapPolicy(index),
      ),
      retryIntervalMs: 1_000,
    })!;
    const legacyPublic = snapshotRfc64PublicCatalogBootstrapConfigV1({
      acceptedPublicPolicies: Array.from(
        { length: 33 },
        (_, index) => publicBootstrapPolicy(index + 32),
      ),
      retryIntervalMs: 1_000,
    })!;

    expect(() => mergeRfc64CatalogBootstrapsV1(catalog, legacyPublic))
      .toThrow(/acceptedPolicies must contain at most 64 policies/u);
  });

  it('enforces the target limit in the daemon additive/legacy bootstrap merge', () => {
    const catalog = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: [publicBootstrapPolicy(0, 128)],
      retryIntervalMs: 1_000,
    })!;
    const legacyPublic = snapshotRfc64PublicCatalogBootstrapConfigV1({
      acceptedPublicPolicies: [publicBootstrapPolicy(1, 129)],
      retryIntervalMs: 1_000,
    })!;

    expect(() => mergeRfc64CatalogBootstrapsV1(catalog, legacyPublic))
      .toThrow(/targets must contain at most 256 catalogs/u);
  });
});
