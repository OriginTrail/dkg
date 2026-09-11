// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
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
  resolveRfc64PublicCatalogActivationInputV1,
} from '../src/rfc64/public-catalog-activation-config-v1.js';
import {
  snapshotRfc64CatalogBootstrapConfigV1,
} from '../src/rfc64/catalog-authority-config-v1.js';
import {
  resolveRfc64ActivePeerSwmRecoveryPlanV1,
  resolveRfc64PeerSwmRecoveryPlanV1,
  resolveRfc64PrivateRecoveryContextGraphIdsV1,
  resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1,
  resolveRfc64SwmRecoveryRuntimeAuthorityV1,
} from '../src/rfc64/swm-recovery-plan-v1.js';
import { Rfc64SwmRecoveryRuntimeV1 } from
  '../src/dkg-agent-rfc64-swm-recovery-runtime.js';
import {
  HOLDER_PEER,
  LOCAL,
  OUTSIDER,
  PRIVATE_CG,
  PROVIDER,
  PROVIDER_PEER,
  PROVIDER_TWO_PEER,
  PUBLIC_CG,
  chainIdentity,
  policy,
  policyEnvelope,
  privateActivation,
  rosterEnvelope,
} from './rfc64-catalog-activation-fixtures.js';

describe('RFC-64 private catalog activation', () => {
  it.each([
    ['compatibility legacy selected', 'selected-public', true, false, false, true, true],
    ['compatibility legacy unselected', 'selected-public', true, false, false, false, false],
    ['shadow selected', 'selected-public', true, true, false, true, true],
    ['catalog selected', 'selected-public', false, true, false, true, true],
    ['kill switch selected', 'selected-public', true, true, true, true, false],
    ['legacy private', 'ordinary-private', true, false, false, false, true],
    ['catalog private', 'ordinary-private', false, true, false, false, true],
    ['kill switch private', 'ordinary-private', true, true, true, false, false],
  ] as const)(
    'projects canonical %s recovery authority',
    (_name, lane, legacySyncAllowed, track2Enabled, killSwitchActive, runtimeSelected, active) => {
      const authority = { legacySyncAllowed, track2Enabled, killSwitchActive };
      expect(resolveRfc64SwmRecoveryRuntimeAuthorityV1({
        contextGraphId: PRIVATE_CG,
        lane,
        configuredAuthority: authority,
        receiverAuthority: authority,
        runtimeSelected,
      })).toEqual({
        kind: 'rfc64-swm-recovery-runtime-authority-v1',
        contextGraphId: PRIVATE_CG,
        lane,
        active,
      });
    },
  );

  it('reserves the exact graph-complete provider for selected private SWM recovery', () => {
    const bootstrap = snapshotRfc64CatalogBootstrapConfigV1(
      privateActivation().bootstrap,
    )!;
    const activation = resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: {
        killSwitch: false,
        contextGraphModes: { [PRIVATE_CG]: 'shadow' },
      },
    }, chainIdentity);
    const resolver = new Rfc64SwmRecoveryRuntimeV1({
      authority: {
        resolveRuntimeSelection: () => ({
          selectedContextGraphs: activation.selectedContextGraphs,
          eligibleContextGraphs: activation.selectedContextGraphs,
          subscriptionDriven: false,
        }),
        resolveConfigured: (contextGraphId) => ({
          contextGraphId,
          selected: true,
          eligible: true,
          active: true,
          mode: 'catalog',
          killSwitchActive: false,
          legacySyncAllowed: false,
          track2Enabled: true,
          authoringAllowed: true,
          reconciliationLane: 'catalog-apply',
        }),
        resolveRecoveryConfig: () => bootstrap,
      },
      admission: { invalidateContextGraph: () => [] },
      cooldown: { deleteProvider: () => undefined },
    });

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
    expect(resolver.resolveConfiguredCompleteProviderPeerIds(PRIVATE_CG))
      .toEqual([PROVIDER_PEER]);
    expect(resolver.resolveActiveCompleteProviderPeerIds(PRIVATE_CG))
      .toEqual([PROVIDER_PEER]);
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
    expect(resolveRfc64ActivePeerSwmRecoveryPlanV1(
      bootstrap,
      PROVIDER_PEER,
      (contextGraphId) => ({
        kind: 'rfc64-swm-recovery-runtime-authority-v1',
        contextGraphId,
        lane: contextGraphId === PRIVATE_CG ? 'ordinary-private' : 'selected-public',
        active: contextGraphId === PUBLIC_CG,
      }),
    )).toEqual({
      kind: 'rfc64-active-swm-recovery-plan-v1',
      providerPeerId: PROVIDER_PEER,
      targets: [{ contextGraphId: PUBLIC_CG, lane: 'selected-public' }],
    });
    expect(resolveRfc64ActivePeerSwmRecoveryPlanV1(
      bootstrap,
      PROVIDER_PEER,
      (contextGraphId) => ({
        kind: 'rfc64-swm-recovery-runtime-authority-v1',
        contextGraphId,
        lane: contextGraphId === PRIVATE_CG ? 'ordinary-private' : 'selected-public',
        active: true,
      }),
    )).toEqual({
      kind: 'rfc64-active-swm-recovery-plan-v1',
      providerPeerId: PROVIDER_PEER,
      targets: [
        { contextGraphId: PRIVATE_CG, lane: 'ordinary-private' },
        { contextGraphId: PUBLIC_CG, lane: 'selected-public' },
      ],
    });
  });

  it('keeps unselected standalone public policies out of active recovery', () => {
    const otherPublic = `${PUBLIC_CG}-other` as ContextGraphIdV1;
    const bootstrap = snapshotRfc64CatalogBootstrapConfigV1({
      acceptedPolicies: [PUBLIC_CG, otherPublic].map((contextGraphId) => ({
        policyEnvelope: policyEnvelope(policy(contextGraphId, 0)),
        targets: [],
        completeSwmProviders: [PROVIDER_PEER],
      })),
    })!;

    expect(resolveRfc64ActivePeerSwmRecoveryPlanV1(
      bootstrap,
      PROVIDER_PEER,
      (contextGraphId) => ({
        kind: 'rfc64-swm-recovery-runtime-authority-v1',
        contextGraphId,
        lane: 'selected-public',
        active: contextGraphId === PUBLIC_CG,
      }),
    )).toEqual({
      kind: 'rfc64-active-swm-recovery-plan-v1',
      providerPeerId: PROVIDER_PEER,
      targets: [{ contextGraphId: PUBLIC_CG, lane: 'selected-public' }],
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
      rollout: { killSwitch: false, contextGraphModes: {} },
    } as never, chainIdentity)).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
      rollout: { killSwitch: false, defaultMode: 'catalog', contextGraphModes: {} },
    });
    expect(resolveRfc64CatalogActivationInputV1({
      enabled: false,
      selectedContextGraphs: [],
      selectedPublicContextGraphs: [],
      selectedPrivateContextGraphs: [],
      rollout: { killSwitch: false, contextGraphModes: {} },
    } as never, chainIdentity)).toMatchObject({
      enabled: false,
      selectedContextGraphs: [],
      rollout: { killSwitch: false, defaultMode: 'catalog', contextGraphModes: {} },
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

  it('fails closed on malformed modes and accepts overrides before discovery', () => {
    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { contextGraphModes: { [PRIVATE_CG]: 'automatic' } },
    } as never, chainIdentity)).toThrow(/must be legacy, shadow, or catalog/u);

    const predeclared = resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { contextGraphModes: { [PUBLIC_CG]: 'shadow' } },
    }, chainIdentity);
    expect(predeclared.selectedContextGraphs).toEqual([PRIVATE_CG]);
    expect(predeclared.rollout.contextGraphModes[PUBLIC_CG]).toBe('shadow');

    expect(() => resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { killSwitch: 'yes' },
    } as never, chainIdentity)).toThrow(/killSwitch must be a boolean/u);

    expect(() => resolveRfc64CatalogActivationConfigV1({
      rollout: { defaultMode: 'automatic' },
    } as never, chainIdentity)).toThrow(/defaultMode must be legacy, shadow, or catalog/u);
    expect(() => resolveRfc64PublicCatalogActivationInputV1({
      rollout: { defaultMode: 'legacy' },
      bootstrap: {
        acceptedPublicPolicies: [{
          policyEnvelope: policyEnvelope(policy(PUBLIC_CG, 0)),
          targets: [],
        }],
      },
    } as never, chainIdentity)).toThrow(/configure lifecycle defaults under rfc64Catalog/u);
  });

  it('uses a validated unified default mode for unlisted responsibilities', () => {
    const resolved = resolveRfc64CatalogActivationConfigV1({
      rollout: {
        defaultMode: 'legacy',
        contextGraphModes: { [PUBLIC_CG]: 'shadow' },
      },
    }, chainIdentity);

    expect(resolved.rollout).toEqual({
      killSwitch: false,
      defaultMode: 'legacy',
      contextGraphModes: { [PUBLIC_CG]: 'shadow' },
    });

    const inherited = resolveRfc64CatalogActivationConfigV1({
      ...privateActivation(),
      rollout: { defaultMode: 'legacy' },
    }, chainIdentity);
    expect(inherited.rollout.contextGraphModes).toEqual({});
    expect(rfc64CatalogRolloutModeForContextGraphV1(inherited, PRIVATE_CG)).toBe('legacy');
  });

  it('treats omitted unified activation as enabled with an optional seed', () => {
    expect(resolveRfc64CatalogActivationConfigV1(undefined, {
      networkId: undefined,
      evmChainId: undefined,
    })).toEqual({
      enabled: true,
      selectedContextGraphs: [],
      selectedPublicContextGraphs: [],
      selectedPrivateContextGraphs: [],
      selectedCatalogAuthoringControls: [],
      rollout: { killSwitch: false, defaultMode: 'catalog', contextGraphModes: {} },
    });
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

});
