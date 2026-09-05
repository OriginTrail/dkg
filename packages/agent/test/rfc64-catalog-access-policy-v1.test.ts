// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  computeContextGraphPolicyObjectDigestV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import {
  Rfc64CatalogAccessPolicyRegistryV1,
  assertAcceptedRfc64CatalogAuthorMembershipV1,
  assertAcceptedRfc64CatalogPolicyRosterV1,
  rfc64CatalogAuthorityDirectionV1,
  type Rfc64CatalogAuthorityOperationV1,
  type Rfc64CatalogAccessOperationV1,
} from '../src/rfc64/catalog-access-policy-v1.js';

const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const LOCAL = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const LOCAL_OTHER = '0x2222222222222222222222222222222222222223' as EvmAddressV1;
const REMOTE = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const OUTSIDER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const CURATOR = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const NETWORK = 'otp:20430' as const;
const CG = '0x1111111111111111111111111111111111111111/v2-policy' as const;
const CG_OTHER = '0x1111111111111111111111111111111111111111/v2-policy-other' as const;

const OPERATIONS: readonly Rfc64CatalogAccessOperationV1[] = Object.freeze([
  'announce-outbound',
  'announce-inbound',
  'head-replay-outbound',
  'head-replay-inbound',
  'fetch-outbound',
  'fetch-inbound',
  'catalog-object-fetch-outbound',
  'catalog-object-fetch-inbound',
  'ka-bundle-fetch-outbound',
  'ka-bundle-fetch-inbound',
]);

function policy(
  accessPolicy: 0 | 1,
  publishPolicy: 0 | 1,
  contextGraphId: ContextGraphIdV1 = CG,
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
    publishPolicy,
    publishAuthority: publishPolicy === 0 ? CURATOR : null,
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

function digestFor(input: ContextGraphPolicyV1): Digest32V1 {
  return computeContextGraphPolicyObjectDigestV1({
    issuer: OWNER,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: input,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1);
}

function roster(
  policyDigest: Digest32V1,
  options: {
    contextGraphId?: ContextGraphIdV1;
    localAgentAddress?: EvmAddressV1;
    localProvider?: boolean;
    remoteProvider?: boolean;
  } = {},
): MemberRosterV1 {
  return {
    networkId: NETWORK,
    contextGraphId: options.contextGraphId ?? CG,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: null,
    members: [
      {
        agentAddress: options.localAgentAddress ?? LOCAL,
        roles: options.localProvider === false ? ['holder'] : ['holder', 'provider'],
      },
      {
        agentAddress: REMOTE,
        roles: options.remoteProvider === false ? ['holder'] : ['holder', 'provider'],
      },
    ],
    issuedAt: '0',
  };
}

function registry(
  remoteAddress: EvmAddressV1 | null = REMOTE,
): Rfc64CatalogAccessPolicyRegistryV1 {
  return new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: LOCAL,
    resolveRemoteAgentAddress: async () => remoteAddress,
  });
}

function authInput(
  operation: Rfc64CatalogAccessOperationV1,
  policyDigest: Digest32V1,
  contextGraphId: ContextGraphIdV1 = CG,
) {
  return {
    operation,
    remotePeerId: '12D3KooRemote',
    networkId: NETWORK,
    contextGraphId,
    policyDigest,
  } as const;
}

describe('RFC-64 D26 catalog access authorization', () => {
  it('classifies every protocol operation through one exhaustive authority table', () => {
    const cases: readonly (readonly [
      Rfc64CatalogAuthorityOperationV1,
      'serving' | 'receiving',
    ])[] = [
      ['announce-outbound', 'serving'],
      ['announce-inbound', 'receiving'],
      ['fetch-outbound', 'receiving'],
      ['fetch-inbound', 'serving'],
      ['catalog-object-fetch-outbound', 'receiving'],
      ['catalog-object-fetch-inbound', 'serving'],
      ['ka-bundle-fetch-outbound', 'receiving'],
      ['ka-bundle-fetch-inbound', 'serving'],
      ['current-head-discovery-outbound', 'receiving'],
      ['current-head-discovery-inbound', 'serving'],
    ];
    expect(cases.map(([operation]) => [
      operation,
      rfc64CatalogAuthorityDirectionV1(operation),
    ])).toEqual(cases);
  });

  it('supports an explicit open-only registry without a dummy identity authority', async () => {
    const subject = new Rfc64CatalogAccessPolicyRegistryV1();
    const openPolicy = policy(0, 1);
    const openDigest = digestFor(openPolicy);
    subject.accept({ policy: openPolicy, policyDigest: openDigest });
    await expect(subject.authorize(authInput('fetch-inbound', openDigest)))
      .resolves.toEqual({ accessPolicy: 0, policyDigest: openDigest });

    const privatePolicy = policy(1, 1);
    const privateDigest = digestFor(privatePolicy);
    expect(() => subject.accept({
      policy: privatePolicy,
      policyDigest: privateDigest,
      roster: roster(privateDigest),
    })).toThrow(/requires explicit access-policy authority/u);
  });

  it('keeps both open-sharing cells SWM-equivalent without resolving a roster identity', async () => {
    for (const publishPolicy of [0, 1] as const) {
      let resolverCalls = 0;
      const acceptedPolicy = policy(0, publishPolicy);
      const policyDigest = digestFor(acceptedPolicy);
      const subject = new Rfc64CatalogAccessPolicyRegistryV1({
        localAgentAddress: LOCAL,
        resolveRemoteAgentAddress: async () => {
          resolverCalls += 1;
          return null;
        },
      });
      subject.accept({ policy: acceptedPolicy, policyDigest });
      for (const operation of OPERATIONS) {
        await expect(subject.authorize(authInput(operation, policyDigest))).resolves.toEqual({
          accessPolicy: 0,
          policyDigest,
        });
      }
      expect(subject.isSwmAuthorAuthorized({
        networkId: NETWORK,
        contextGraphId: CG,
        policyDigest,
        authorAddress: OUTSIDER,
      })).toBe(true);
      expect(resolverCalls).toBe(0);
    }
  });

  it('keeps both invite-only cells SWM-equivalent and requires current members', async () => {
    for (const publishPolicy of [0, 1] as const) {
      const acceptedPolicy = policy(1, publishPolicy);
      const policyDigest = digestFor(acceptedPolicy);
      const subject = registry();
      subject.accept({ policy: acceptedPolicy, policyDigest, roster: roster(policyDigest) });
      for (const operation of OPERATIONS) {
        await expect(subject.authorize(authInput(operation, policyDigest))).resolves.toEqual({
          accessPolicy: 1,
          policyDigest,
        });
      }
      expect(subject.isSwmAuthorAuthorized({
        networkId: NETWORK,
        contextGraphId: CG,
        policyDigest,
        authorAddress: REMOTE,
      })).toBe(true);
      expect(subject.isSwmAuthorAuthorized({
        networkId: NETWORK,
        contextGraphId: CG,
        policyDigest,
        authorAddress: OUTSIDER,
      })).toBe(false);
    }
  });

  it('passes the exact private Context Graph into peer identity resolution', async () => {
    const acceptedPolicy = policy(1, 1);
    const policyDigest = digestFor(acceptedPolicy);
    const resolutions: Array<{ peerId: string; contextGraphId: string }> = [];
    const subject = new Rfc64CatalogAccessPolicyRegistryV1({
      localAgentAddress: LOCAL,
      resolveRemoteAgentAddress: async (peerId, contextGraphId) => {
        resolutions.push({ peerId, contextGraphId });
        return REMOTE;
      },
    });
    subject.accept({ policy: acceptedPolicy, policyDigest, roster: roster(policyDigest) });

    await expect(subject.authorize(authInput('fetch-outbound', policyDigest)))
      .resolves.toEqual({ accessPolicy: 1, policyDigest });
    expect(resolutions).toEqual([{ peerId: '12D3KooRemote', contextGraphId: CG }]);
  });

  it('resolves the local private principal independently for each Context Graph', async () => {
    const resolutions: string[] = [];
    const subject = new Rfc64CatalogAccessPolicyRegistryV1({
      resolveLocalAgentAddress: async (contextGraphId) => {
        resolutions.push(contextGraphId);
        return contextGraphId === CG ? LOCAL : LOCAL_OTHER;
      },
      resolveRemoteAgentAddress: async () => REMOTE,
    });
    const firstPolicy = policy(1, 1);
    const firstDigest = digestFor(firstPolicy);
    subject.accept({
      policy: firstPolicy,
      policyDigest: firstDigest,
      roster: roster(firstDigest),
    });
    const secondPolicy = policy(1, 1, CG_OTHER);
    const secondDigest = digestFor(secondPolicy);
    subject.accept({
      policy: secondPolicy,
      policyDigest: secondDigest,
      roster: roster(secondDigest, {
        contextGraphId: CG_OTHER,
        localAgentAddress: LOCAL_OTHER,
      }),
    });

    for (const operation of OPERATIONS) {
      await expect(subject.authorize(authInput(operation, firstDigest)))
        .resolves.toEqual({ accessPolicy: 1, policyDigest: firstDigest });
      await expect(subject.authorize(authInput(
        operation,
        secondDigest,
        CG_OTHER,
      ))).resolves.toEqual({ accessPolicy: 1, policyDigest: secondDigest });
    }
    expect(resolutions).toEqual(OPERATIONS.flatMap(() => [CG, CG_OTHER]));
    expect(subject.isSwmAuthorAuthorized({
      networkId: NETWORK,
      contextGraphId: CG_OTHER,
      policyDigest: secondDigest,
      authorAddress: LOCAL_OTHER,
    })).toBe(true);
  });

  it('fails closed when the per-CG resolver reports no unique local principal', async () => {
    const acceptedPolicy = policy(1, 1);
    const policyDigest = digestFor(acceptedPolicy);
    const subject = new Rfc64CatalogAccessPolicyRegistryV1({
      // Both no match and multiple ambiguous matches collapse to the registry's
      // sole fail-closed resolver result.
      resolveLocalAgentAddress: async () => null,
      resolveRemoteAgentAddress: async () => REMOTE,
    });
    subject.accept({ policy: acceptedPolicy, policyDigest, roster: roster(policyDigest) });

    await expect(subject.authorize(authInput('fetch-inbound', policyDigest)))
      .resolves.toBeNull();
  });

  it('rejects a private authorization when policy rotates during local resolution', async () => {
    let finishLocalResolution: ((address: EvmAddressV1) => void) | undefined;
    const initialPolicy = policy(1, 1);
    const initialDigest = digestFor(initialPolicy);
    const subject = new Rfc64CatalogAccessPolicyRegistryV1({
      resolveLocalAgentAddress: async () => new Promise<EvmAddressV1>((resolve) => {
        finishLocalResolution = resolve;
      }),
      resolveRemoteAgentAddress: async () => REMOTE,
    });
    subject.acceptCurrent({
      policy: initialPolicy,
      policyDigest: initialDigest,
      roster: roster(initialDigest),
    });

    const authorization = subject.authorize(authInput('fetch-inbound', initialDigest));
    expect(finishLocalResolution).toBeTypeOf('function');
    const successorPolicy = {
      ...policy(1, 1),
      version: '1',
      previousPolicyDigest: initialDigest,
    } satisfies ContextGraphPolicyV1;
    const successorDigest = digestFor(successorPolicy);
    subject.acceptCurrent({
      policy: successorPolicy,
      policyDigest: successorDigest,
      roster: roster(successorDigest),
    });
    finishLocalResolution!(LOCAL);

    await expect(authorization).resolves.toBeNull();
    expect(subject.lookup(NETWORK, CG)?.policyDigest).toBe(successorDigest);
  });

  it('requires exactly one local private-authority source', () => {
    expect(() => new Rfc64CatalogAccessPolicyRegistryV1({
      localAgentAddress: LOCAL,
      resolveLocalAgentAddress: async () => LOCAL,
      resolveRemoteAgentAddress: async () => REMOTE,
    } as never)).toThrow(/exactly one/u);
    expect(() => new Rfc64CatalogAccessPolicyRegistryV1({
      resolveRemoteAgentAddress: async () => REMOTE,
    } as never)).toThrow(/exactly one/u);
  });

  it('requires the serving side to hold the provider role', async () => {
    const acceptedPolicy = policy(1, 1);
    const policyDigest = digestFor(acceptedPolicy);

    const localNotProvider = registry();
    localNotProvider.accept({
      policy: acceptedPolicy,
      policyDigest,
      roster: roster(policyDigest, { localProvider: false }),
    });
    for (const operation of [
      'announce-outbound',
      'fetch-inbound',
      'catalog-object-fetch-inbound',
      'ka-bundle-fetch-inbound',
    ] as const) {
      await expect(localNotProvider.authorize(authInput(operation, policyDigest)))
        .resolves.toBeNull();
    }

    const remoteNotProvider = registry();
    remoteNotProvider.accept({
      policy: acceptedPolicy,
      policyDigest,
      roster: roster(policyDigest, { remoteProvider: false }),
    });
    for (const operation of [
      'announce-inbound',
      'fetch-outbound',
      'catalog-object-fetch-outbound',
      'ka-bundle-fetch-outbound',
    ] as const) {
      await expect(remoteNotProvider.authorize(authInput(operation, policyDigest)))
        .resolves.toBeNull();
    }
  });

  it('denies unknown peers, stale digests, and missing private membership', async () => {
    const acceptedPolicy = policy(1, 0);
    const policyDigest = digestFor(acceptedPolicy);
    const outsider = registry(OUTSIDER);
    outsider.accept({ policy: acceptedPolicy, policyDigest, roster: roster(policyDigest) });
    await expect(outsider.authorize(authInput('fetch-inbound', policyDigest)))
      .resolves.toBeNull();
    await expect(outsider.authorize(authInput(
      'fetch-inbound',
      `0x${'ab'.repeat(32)}` as Digest32V1,
    ))).resolves.toBeNull();
    const unresolved = registry(null);
    unresolved.accept({ policy: acceptedPolicy, policyDigest, roster: roster(policyDigest) });
    await expect(unresolved.authorize(authInput('fetch-inbound', policyDigest)))
      .resolves.toBeNull();
  });

  it('fails closed for malformed runtime operations and peer identifiers', async () => {
    for (const accessPolicy of [0, 1] as const) {
      const acceptedPolicy = policy(accessPolicy, 1);
      const policyDigest = digestFor(acceptedPolicy);
      const subject = registry();
      subject.accept({
        policy: acceptedPolicy,
        policyDigest,
        roster: accessPolicy === 1 ? roster(policyDigest) : null,
      });

      await expect(subject.authorize({
        ...authInput('fetch-inbound', policyDigest),
        operation: 'not-a-catalog-operation',
      } as never)).resolves.toBeNull();
      await expect(subject.authorize({
        ...authInput('fetch-inbound', policyDigest),
        remotePeerId: '',
      })).resolves.toBeNull();
      await expect(subject.authorize(null as never)).resolves.toBeNull();
      expect(subject.isSwmAuthorAuthorized(null as never)).toBe(false);
    }
  });

  it('snapshots the operation before awaiting peer-to-agent resolution', async () => {
    let finishResolution: ((address: EvmAddressV1) => void) | undefined;
    const acceptedPolicy = policy(1, 1);
    const policyDigest = digestFor(acceptedPolicy);
    const subject = new Rfc64CatalogAccessPolicyRegistryV1({
      localAgentAddress: LOCAL,
      resolveRemoteAgentAddress: async () => new Promise<EvmAddressV1>((resolve) => {
        finishResolution = resolve;
      }),
    });
    subject.accept({
      policy: acceptedPolicy,
      policyDigest,
      roster: roster(policyDigest, { remoteProvider: false }),
    });

    const input = { ...authInput('fetch-outbound', policyDigest) };
    const authorization = subject.authorize(input);
    input.operation = 'fetch-inbound';
    expect(finishResolution).toBeTypeOf('function');
    finishResolution!(REMOTE);
    await expect(authorization).resolves.toBeNull();
  });

  it('binds the conditional roster exactly and snapshots mutable caller input', async () => {
    const acceptedPolicy = policy(1, 1);
    const policyDigest = digestFor(acceptedPolicy);
    const acceptedRoster = roster(policyDigest);
    const subject = registry();
    const accepted = subject.accept({
      policy: acceptedPolicy,
      policyDigest,
      roster: acceptedRoster,
    });
    acceptedPolicy.accessPolicy = 0;
    acceptedRoster.members.splice(0, acceptedRoster.members.length);
    expect(accepted.policy.accessPolicy).toBe(1);
    expect(accepted.roster?.members).toHaveLength(2);
    await expect(subject.authorize(authInput('fetch-outbound', policyDigest)))
      .resolves.toEqual({ accessPolicy: 1, policyDigest });

    expect(() => registry().accept({
      policy: policy(1, 1),
      policyDigest,
    })).toThrow(/requires a current member roster/u);
    expect(() => registry().accept({
      policy: policy(0, 1),
      policyDigest: digestFor(policy(0, 1)),
      roster: roster(policyDigest),
    })).toThrow(/forbids an exhaustive member roster/u);
    expect(() => registry().accept({
      policy: policy(1, 1),
      policyDigest,
      roster: { ...roster(policyDigest), policyDigest: `0x${'cd'.repeat(32)}` as Digest32V1 },
    })).toThrow(/not bound to the exact accepted policy/u);
  });

  it('keeps snapshot validity separate from author membership', () => {
    const acceptedPolicy = policy(1, 1);
    const policyDigest = digestFor(acceptedPolicy);
    const acceptedRoster = roster(policyDigest);

    expect(() => assertAcceptedRfc64CatalogPolicyRosterV1(
      acceptedPolicy,
      policyDigest,
      acceptedRoster,
    )).not.toThrow();
    expect(() => assertAcceptedRfc64CatalogAuthorMembershipV1(
      acceptedPolicy,
      acceptedRoster,
      LOCAL,
    )).not.toThrow();
    expect(() => assertAcceptedRfc64CatalogAuthorMembershipV1(
      acceptedPolicy,
      acceptedRoster,
      OUTSIDER,
    )).toThrow(/author membership/u);

    const openPolicy = policy(0, 1);
    expect(() => assertAcceptedRfc64CatalogPolicyRosterV1(
      openPolicy,
      digestFor(openPolicy),
      null,
    )).not.toThrow();
    expect(() => assertAcceptedRfc64CatalogAuthorMembershipV1(
      openPolicy,
      null,
      OUTSIDER,
    )).not.toThrow();
  });

  it('allows exact replay but refuses unverified current-policy replacement', () => {
    const initial = policy(0, 1);
    const initialDigest = digestFor(initial);
    const subject = registry();
    subject.accept({ policy: initial, policyDigest: initialDigest });
    expect(subject.accept({ policy: initial, policyDigest: initialDigest }).policyDigest)
      .toBe(initialDigest);
    const replacement = { ...policy(0, 0), version: '1', previousPolicyDigest: initialDigest };
    expect(() => subject.accept({
      policy: replacement,
      policyDigest: digestFor(replacement),
    })).toThrow(/verified transition\/high-water path/u);
  });

  it('advances only across a linked monotonic accepted-current policy transition', async () => {
    const initial = policy(0, 1);
    const initialDigest = digestFor(initial);
    const subject = registry();
    subject.acceptCurrent({ policy: initial, policyDigest: initialDigest });
    const successor = {
      ...policy(0, 0),
      version: '1',
      previousPolicyDigest: initialDigest,
    } satisfies ContextGraphPolicyV1;
    const successorDigest = digestFor(successor);
    subject.acceptCurrent({ policy: successor, policyDigest: successorDigest });

    expect(subject.lookup(NETWORK, CG)?.policyDigest).toBe(successorDigest);
    await expect(subject.authorize(authInput('fetch-inbound', initialDigest)))
      .resolves.toBeNull();
    await expect(subject.authorize(authInput('fetch-inbound', successorDigest)))
      .resolves.toEqual({ accessPolicy: 0, policyDigest: successorDigest });

    const unlinked = {
      ...policy(0, 1),
      version: '2',
      previousPolicyDigest: initialDigest,
    } satisfies ContextGraphPolicyV1;
    expect(() => subject.acceptCurrent({
      policy: unlinked,
      policyDigest: digestFor(unlinked),
    })).toThrow(/exact predecessor digest/u);
    expect(subject.lookup(NETWORK, CG)?.policyDigest).toBe(successorDigest);
  });

  it('promotes an unregistered authority to finalized chain state exactly one way', () => {
    const initial = policy(0, 0);
    const initialDigest = digestFor(initial);
    const finalized = {
      ...policy(0, 0),
      governanceChainId: '31337',
      governanceContractAddress: '0x6666666666666666666666666666666666666666',
      ownershipTransitionDigest: `0x${'77'.repeat(32)}` as Digest32V1,
      source: {
        kind: 'finalized-chain' as const,
        chainId: '31337',
        contractAddress: '0x6666666666666666666666666666666666666666',
        blockNumber: '42',
        blockHash: `0x${'88'.repeat(32)}` as Digest32V1,
      },
    } satisfies ContextGraphPolicyV1;
    const finalizedDigest = digestFor(finalized);
    const subject = registry();

    subject.acceptAuthoritativeCurrent({ policy: initial, policyDigest: initialDigest });
    expect(subject.acceptAuthoritativeCurrent({
      policy: finalized,
      policyDigest: finalizedDigest,
    }).policyDigest).toBe(finalizedDigest);
    expect(subject.acceptAuthoritativeCurrent({
      policy: finalized,
      policyDigest: finalizedDigest,
    }).policyDigest).toBe(finalizedDigest);

    expect(() => subject.acceptAuthoritativeCurrent({
      policy: initial,
      policyDigest: initialDigest,
    })).toThrow(/does not advance its high-water/u);
    expect(subject.lookup(NETWORK, CG)?.policyDigest).toBe(finalizedDigest);
  });

  it('rejects a stale unregistered roster after a newer curator generation', () => {
    const privatePolicy = policy(1, 0);
    const policyDigest = digestFor(privatePolicy);
    const initialRoster = roster(policyDigest);
    const newerRoster: MemberRosterV1 = {
      ...initialRoster,
      version: '2',
      members: initialRoster.members.filter(({ agentAddress }) => agentAddress !== REMOTE),
    };
    const staleRoster: MemberRosterV1 = {
      ...initialRoster,
      version: '1',
    };
    const subject = registry();

    subject.acceptAuthoritativeCurrent({
      policy: privatePolicy,
      policyDigest,
      roster: initialRoster,
    });
    expect(subject.acceptAuthoritativeCurrent({
      policy: privatePolicy,
      policyDigest,
      roster: newerRoster,
    }).roster?.version).toBe('2');
    expect(() => subject.acceptAuthoritativeCurrent({
      policy: privatePolicy,
      policyDigest,
      roster: staleRoster,
    })).toThrow(/does not advance its high-water/u);
    expect(subject.lookup(NETWORK, CG)?.roster).toEqual(newerRoster);
  });
});
