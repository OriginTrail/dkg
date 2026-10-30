// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  computeContextGraphPolicyObjectDigestV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import { Rfc64CatalogAccessPolicyRegistryV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { selectedFixture } from './context-graph-registration-binding.fixture.js';

const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const GOVERNANCE_CONTRACT =
  '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const GOVERNANCE_CHAIN = '20430' as ChainIdV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;

/** Accepted owner-signed unregistered authority: terminal "no VM inventory" evidence. */
const UNREGISTERED_CG =
  '0x1111111111111111111111111111111111111111/unregistered' as ContextGraphIdV1;
/** Same shape, but the accepted authority came from finalized chain state. */
const FINALIZED_CG =
  '0x1111111111111111111111111111111111111111/finalized' as ContextGraphIdV1;
/** Accepted unregistered authority that nevertheless already holds a numeric binding. */
const BOUND_UNREGISTERED_CG =
  '0x1111111111111111111111111111111111111111/bound-unregistered' as ContextGraphIdV1;
/** Never accepted anywhere: `acceptedPolicySnapshot` resolves to null for it. */
const UNKNOWN_CG =
  '0x1111111111111111111111111111111111111111/unknown' as ContextGraphIdV1;

function publicPolicy(
  contextGraphId: ContextGraphIdV1,
  source: ContextGraphPolicyV1['source'],
): ContextGraphPolicyV1 {
  const finalized = source.kind === 'finalized-chain';
  return {
    networkId: NETWORK_ID,
    contextGraphId,
    governanceChainId: finalized ? GOVERNANCE_CHAIN : null,
    governanceContractAddress: finalized ? GOVERNANCE_CONTRACT : null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source,
    effectiveAt: '0',
    issuedAt: '0',
  };
}

const OWNER_SIGNED_SOURCE = {
  kind: 'owner-signed-unregistered',
  ownerAddress: OWNER,
  ownerAuthorityEra: '0',
} as const satisfies ContextGraphPolicyV1['source'];

const FINALIZED_CHAIN_SOURCE = {
  kind: 'finalized-chain',
  chainId: GOVERNANCE_CHAIN,
  contractAddress: GOVERNANCE_CONTRACT,
  blockNumber: '120',
  blockHash: `0x${'76'.repeat(32)}` as Digest32V1,
} as const satisfies ContextGraphPolicyV1['source'];

function digestFor(policy: ContextGraphPolicyV1): Digest32V1 {
  return computeContextGraphPolicyObjectDigestV1({
    issuer: OWNER,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1);
}

interface GuardAgentView {
  hasAcceptedRfc64UnregisteredAuthorityV1(contextGraphId: string): boolean;
  selectVmReconcileTargets(): { bound: string[]; unbound: string[] };
}

/**
 * Install one real accepted-policy registry behind the catalog-service view the
 * agent guards read. Only the service shell is synthetic: acceptance, canonical
 * policy validation and lookup keying are the production implementations.
 */
function installAcceptedPolicies(
  agent: ReturnType<typeof selectedFixture>['agent'],
  policies: readonly ContextGraphPolicyV1[],
  options: { readonly networkId?: unknown } = {},
) {
  const registry = new Rfc64CatalogAccessPolicyRegistryV1();
  for (const policy of policies) {
    registry.accept({ policy, policyDigest: digestFor(policy), roster: null });
  }
  const lookups: string[] = [];
  Reflect.set(agent, 'rfc64PublicCatalogOwnerV1', {
    service: {
      acceptedPolicySnapshot(networkId: NetworkIdV1, contextGraphId: ContextGraphIdV1) {
        lookups.push(`${networkId}|${contextGraphId}`);
        return registry.lookup(networkId, contextGraphId);
      },
    },
  });
  const config = agent.config as Record<string, unknown>;
  config.rfc64CatalogDeploymentProfile = {
    networkId: 'networkId' in options ? options.networkId : NETWORK_ID,
  };
  return { registry, lookups };
}

describe('hasAcceptedRfc64UnregisteredAuthorityV1 identifier guard', () => {
  it('discriminates on the accepted policy source kind for canonical coordinates', () => {
    const fixture = selectedFixture();
    const { lookups } = installAcceptedPolicies(fixture.agent, [
      publicPolicy(UNREGISTERED_CG, OWNER_SIGNED_SOURCE),
      publicPolicy(FINALIZED_CG, FINALIZED_CHAIN_SOURCE),
    ]);
    const agent = fixture.agent as unknown as GuardAgentView;

    expect(agent.hasAcceptedRfc64UnregisteredAuthorityV1(UNREGISTERED_CG)).toBe(true);
    expect(agent.hasAcceptedRfc64UnregisteredAuthorityV1(FINALIZED_CG)).toBe(false);
    expect(agent.hasAcceptedRfc64UnregisteredAuthorityV1(UNKNOWN_CG)).toBe(false);
    expect(lookups).toEqual([
      `${NETWORK_ID}|${UNREGISTERED_CG}`,
      `${NETWORK_ID}|${FINALIZED_CG}`,
      `${NETWORK_ID}|${UNKNOWN_CG}`,
    ]);
  });

  it('returns false for a malformed contextGraphId instead of throwing at the caller', () => {
    const fixture = selectedFixture();
    const { lookups } = installAcceptedPolicies(fixture.agent, [
      publicPolicy(UNREGISTERED_CG, OWNER_SIGNED_SOURCE),
    ]);
    const agent = fixture.agent as unknown as GuardAgentView;

    // A space is outside the author-lane contextGraphId grammar, so
    // `assertContextGraphIdV1` throws before any policy lookup can happen.
    expect(agent.hasAcceptedRfc64UnregisteredAuthorityV1('not a canonical cg id'))
      .toBe(false);
    expect(agent.hasAcceptedRfc64UnregisteredAuthorityV1('')).toBe(false);
    // The rejection is the identifier guard, not an absent accepted snapshot.
    expect(lookups).toEqual([]);
  });

  it('returns false when the configured active networkId is not canonical', () => {
    const fixture = selectedFixture();
    const { lookups } = installAcceptedPolicies(
      fixture.agent,
      [publicPolicy(UNREGISTERED_CG, OWNER_SIGNED_SOURCE)],
      { networkId: 'otp 20430' },
    );
    const agent = fixture.agent as unknown as GuardAgentView;

    expect(agent.hasAcceptedRfc64UnregisteredAuthorityV1(UNREGISTERED_CG)).toBe(false);
    expect(lookups).toEqual([]);
  });
});

describe('VM-reconcile selection of RFC-64 selected targets', () => {
  function selectionFixture() {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    // An accepted unregistered authority that has since been bound to a numeric
    // on-chain id: the binding, not the policy source, decides VM eligibility.
    fixture.agent.subscribedContextGraphs.set(BOUND_UNREGISTERED_CG, {
      subscribed: false,
      synced: false,
      syncMode: 'always-on',
      onChainId: '77',
    });
    const installed = installAcceptedPolicies(fixture.agent, [
      publicPolicy(UNREGISTERED_CG, OWNER_SIGNED_SOURCE),
      publicPolicy(FINALIZED_CG, FINALIZED_CHAIN_SOURCE),
      publicPolicy(BOUND_UNREGISTERED_CG, OWNER_SIGNED_SOURCE),
    ]);
    const config = fixture.agent.config as Record<string, unknown>;
    const selected = [UNREGISTERED_CG, FINALIZED_CG, BOUND_UNREGISTERED_CG];
    config.syncContextGraphs = selected;
    config.rfc64CatalogBootstrap = {
      acceptedPolicies: selected.map((contextGraphId) => ({
        policyEnvelope: { payload: { accessPolicy: 0, contextGraphId } },
        targets: [],
      })),
    };
    return { fixture, installed };
  }

  it('excludes an accepted unregistered target with no authoritative binding', () => {
    const { fixture } = selectionFixture();
    const agent = fixture.agent as unknown as GuardAgentView;

    const { bound, unbound } = agent.selectVmReconcileTargets();

    // Terminal evidence of "no finalized VM inventory": never sweep it.
    expect(bound).not.toContain(UNREGISTERED_CG);
    expect(unbound).not.toContain(UNREGISTERED_CG);
    // Accepted from finalized chain state -> still a real VM-reconcile target.
    expect(bound).toContain(FINALIZED_CG);
    // Same owner-signed policy, but an authoritative binding overrides the skip.
    expect(bound).toContain(BOUND_UNREGISTERED_CG);
    expect(bound).toHaveLength(2);
  });

  it('re-admits the unregistered target once it holds an authoritative binding', () => {
    const { fixture } = selectionFixture();
    fixture.agent.subscribedContextGraphs.set(UNREGISTERED_CG, {
      subscribed: false,
      synced: false,
      syncMode: 'always-on',
      onChainId: '91',
    });
    const agent = fixture.agent as unknown as GuardAgentView;

    expect(agent.selectVmReconcileTargets().bound).toContain(UNREGISTERED_CG);
  });

  it('admits a selected target that holds no accepted policy at all', () => {
    const { fixture, installed } = selectionFixture();
    const config = fixture.agent.config as Record<string, unknown>;
    // Selected exactly like the others, but never accepted into the policy
    // registry: `acceptedPolicySnapshot` resolves null, so the unregistered
    // skip must not fire and the target stays a real VM-reconcile candidate.
    config.syncContextGraphs = [
      ...(config.syncContextGraphs as string[]),
      UNKNOWN_CG,
    ];
    config.rfc64CatalogBootstrap = {
      acceptedPolicies: [
        ...(config.rfc64CatalogBootstrap as {
          acceptedPolicies: readonly unknown[];
        }).acceptedPolicies,
        {
          policyEnvelope: { payload: { accessPolicy: 0, contextGraphId: UNKNOWN_CG } },
          targets: [],
        },
      ],
    };
    const agent = fixture.agent as unknown as GuardAgentView;

    const { bound } = agent.selectVmReconcileTargets();
    expect(bound).toContain(UNKNOWN_CG);
    expect(bound).not.toContain(UNREGISTERED_CG);
    expect(installed.lookups).toContain(`${NETWORK_ID}|${UNKNOWN_CG}`);
  });
});
