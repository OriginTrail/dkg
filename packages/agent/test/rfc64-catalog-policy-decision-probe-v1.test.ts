/**
 * GH#3081 — telling a catalog policy decision that was answered from one that could not be made:
 * the probe around a decision, the notes that feed it, and where the policy wrapper of a
 * transport operation denied it.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
} from '@origintrail-official/dkg-core';

import { Rfc64CatalogAccessPolicyRegistryV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import {
  noteRfc64CatalogPolicyUndecidedV1,
  notingRfc64CatalogPolicyFailureV1,
  observedRfc64CatalogAccessAuthorityV1,
  rfc64CatalogLookupFailedAsV1,
  withRfc64CatalogPolicyProbeV1,
} from '../src/rfc64/catalog-policy-decision-probe-v1.js';
import {
  rfc64CatalogPolicyDenialPhaseV1,
  withCurrentRfc64CatalogPolicyV1,
} from '../src/rfc64/catalog-transport-authorization-v1.js';

const LOCAL = `0x${'a1'.repeat(20)}` as EvmAddressV1;
const MEMBER = `0x${'b2'.repeat(20)}` as EvmAddressV1;
const POLICY_DIGEST = `0x${'3d'.repeat(32)}` as Digest32V1;
const POLICY: ContextGraphPolicyV1 = {
  networkId: 'otp:20430' as ContextGraphPolicyV1['networkId'],
  contextGraphId: '0x1111111111111111111111111111111111111111/probe' as ContextGraphPolicyV1['contextGraphId'],
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  era: '0',
  version: '0',
  previousPolicyDigest: null,
  accessPolicy: 1,
  publishPolicy: 1,
  publishAuthority: null,
  publishAuthorityAccountId: '0',
  projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  administrativeDelegationDigest: null,
  source: { kind: 'owner-signed-unregistered', ownerAddress: LOCAL, ownerAuthorityEra: '0' },
  effectiveAt: '0',
  issuedAt: '0',
} as ContextGraphPolicyV1;
const ROSTER: MemberRosterV1 = {
  networkId: POLICY.networkId,
  contextGraphId: POLICY.contextGraphId,
  ownershipTransitionDigest: null,
  era: '0',
  version: '0',
  previousRosterDigest: null,
  policyDigest: POLICY_DIGEST,
  administrativeDelegationDigest: null,
  members: [LOCAL, MEMBER].sort().map((agentAddress) => ({
    agentAddress,
    roles: ['holder', 'provider'] as const,
  })),
  issuedAt: '0',
} as MemberRosterV1;

describe('RFC-64 catalog policy probe', () => {
  it('sees a note made inside it, across awaits, and nothing made outside it or in another probe', async () => {
    noteRfc64CatalogPolicyUndecidedV1();
    const quiet = { undecided: false };
    const noted = { undecided: false };

    await Promise.all([
      withRfc64CatalogPolicyProbeV1(quiet, async () => {
        await new Promise((resolve) => { setImmediate(resolve); });
      }),
      withRfc64CatalogPolicyProbeV1(noted, async () => {
        await new Promise((resolve) => { setImmediate(resolve); });
        noteRfc64CatalogPolicyUndecidedV1();
      }),
    ]);

    expect(quiet.undecided).toBe(false);
    expect(noted.undecided).toBe(true);
  });

  it('notes a lookup failure that its caller reads as unknown, and answers as before', async () => {
    const probe = { undecided: false };

    const answer = await withRfc64CatalogPolicyProbeV1(probe, () => (
      Promise.reject(new Error('store query timed out')).catch(rfc64CatalogLookupFailedAsV1(null))
    ));

    expect(answer).toBeNull();
    expect(probe.undecided).toBe(true);
    // Outside a probe the handler is just the fallback.
    expect(rfc64CatalogLookupFailedAsV1('unknown')()).toBe('unknown');
  });

  it('notes a decision that fails, thrown or rejected, and passes the failure on', async () => {
    const answered = { undecided: false };
    await expect(withRfc64CatalogPolicyProbeV1(
      answered,
      () => notingRfc64CatalogPolicyFailureV1(() => null),
    )).resolves.toBeNull();
    expect(answered.undecided).toBe(false);

    for (const decide of [
      () => { throw new Error('authority unavailable'); },
      () => Promise.reject(new Error('authority unavailable')),
    ]) {
      const probe = { undecided: false };
      await expect(withRfc64CatalogPolicyProbeV1(
        probe,
        () => notingRfc64CatalogPolicyFailureV1(decide),
      )).rejects.toThrow('authority unavailable');
      expect(probe.undecided).toBe(true);
    }
  });
});

describe('RFC-64 catalog access authority, observed', () => {
  const registryOver = (authority: Parameters<typeof observedRfc64CatalogAccessAuthorityV1>[0]) => {
    const registry = new Rfc64CatalogAccessPolicyRegistryV1(
      observedRfc64CatalogAccessAuthorityV1(authority),
    );
    registry.accept({ policy: POLICY, policyDigest: POLICY_DIGEST, roster: ROSTER });
    return registry;
  };
  const decide = async (registry: Rfc64CatalogAccessPolicyRegistryV1) => {
    const probe = { undecided: false };
    const authorization = await withRfc64CatalogPolicyProbeV1(probe, () => registry.authorize({
      operation: 'announce-outbound',
      remotePeerId: 'peer-a',
      networkId: POLICY.networkId,
      contextGraphId: POLICY.contextGraphId,
      policyDigest: POLICY_DIGEST,
    }));
    return { authorized: authorization !== null, undecided: probe.undecided };
  };

  it('leaves a decision the policy answered alone: a member is authorized, an unknown peer refused', async () => {
    expect(await decide(registryOver({
      localAgentAddress: LOCAL,
      resolveRemoteAgentAddress: async () => MEMBER,
    }))).toEqual({ authorized: true, undecided: false });
    expect(await decide(registryOver({
      resolveLocalAgentAddress: async () => LOCAL,
      resolveRemoteAgentAddress: async () => null,
    }))).toEqual({ authorized: false, undecided: false });
  });

  it('marks a decision as one that could not be made when this node\'s own principal is unresolved', async () => {
    expect(await decide(registryOver({
      resolveLocalAgentAddress: async () => null,
      resolveRemoteAgentAddress: async () => MEMBER,
    }))).toEqual({ authorized: false, undecided: true });
  });

  it('marks a decision as one that could not be made when either lookup fails', async () => {
    expect(await decide(registryOver({
      localAgentAddress: LOCAL,
      resolveRemoteAgentAddress: async () => { throw new Error('store query timed out'); },
    }))).toEqual({ authorized: false, undecided: true });
    expect(await decide(registryOver({
      resolveLocalAgentAddress: async () => { throw new Error('chain read timed out'); },
      resolveRemoteAgentAddress: async () => MEMBER,
    }))).toEqual({ authorized: false, undecided: true });
  });

  it('passes what a lookup is given and returns through unchanged', async () => {
    const resolveLocalAgentAddress = vi.fn(async () => LOCAL);
    const resolveRemoteAgentAddress = vi.fn(async () => MEMBER);
    const observed = observedRfc64CatalogAccessAuthorityV1({
      resolveLocalAgentAddress,
      resolveRemoteAgentAddress,
    })!;
    const scope = { contextGraphId: POLICY.contextGraphId } as never;

    await expect(observed.resolveLocalAgentAddress!(POLICY.contextGraphId, scope)).resolves.toBe(LOCAL);
    await expect(observed.resolveRemoteAgentAddress('peer-a', POLICY.contextGraphId)).resolves.toBe(MEMBER);
    expect(resolveLocalAgentAddress).toHaveBeenCalledWith(POLICY.contextGraphId, scope);
    expect(resolveRemoteAgentAddress).toHaveBeenCalledWith('peer-a', POLICY.contextGraphId);
  });

  it('leaves no authority, and an authority that is not well-formed, for the registry to judge', () => {
    expect(observedRfc64CatalogAccessAuthorityV1(undefined)).toBeUndefined();
    const malformed = { localAgentAddress: LOCAL, resolveRemoteAgentAddress: 'not a function' } as never;
    expect(observedRfc64CatalogAccessAuthorityV1(malformed)).toEqual(malformed);
    expect(() => new Rfc64CatalogAccessPolicyRegistryV1(
      observedRfc64CatalogAccessAuthorityV1(malformed),
    )).toThrow('resolveRemoteAgentAddress must be a function');
  });
});

describe('RFC-64 catalog policy wrapper: where an operation was denied', () => {
  it('says the work never ran when the check before it denied', async () => {
    const denial = new Error('not access-policy authorized');
    const work = vi.fn(async () => 'sent');

    const failure = await withCurrentRfc64CatalogPolicyV1(async () => { throw denial; }, work)
      .catch((error: unknown) => error);

    expect(failure).toBe(denial);
    expect(work).not.toHaveBeenCalled();
    expect(rfc64CatalogPolicyDenialPhaseV1(failure)).toBe('before-work');
  });

  it('says the work ran to its end when only the check after it denied', async () => {
    const denial = new Error('not access-policy authorized');
    const work = vi.fn(async () => 'sent');
    let checks = 0;

    const failure = await withCurrentRfc64CatalogPolicyV1(async () => {
      checks += 1;
      if (checks === 2) throw denial;
    }, work).catch((error: unknown) => error);

    expect(failure).toBe(denial);
    expect(work).toHaveBeenCalledOnce();
    expect(rfc64CatalogPolicyDenialPhaseV1(failure)).toBe('after-work');
  });

  it('says nothing about a failure of the work itself, or about anything it did not see', async () => {
    const failure = await withCurrentRfc64CatalogPolicyV1(
      async () => undefined,
      async () => { throw new Error('stream reset by peer'); },
    ).catch((error: unknown) => error);

    expect(rfc64CatalogPolicyDenialPhaseV1(failure)).toBeNull();
    expect(rfc64CatalogPolicyDenialPhaseV1(new Error('unrelated'))).toBeNull();
    expect(rfc64CatalogPolicyDenialPhaseV1('a string')).toBeNull();
    expect(rfc64CatalogPolicyDenialPhaseV1(undefined)).toBeNull();
    // A check that fails with something that is not an object is passed on as it is.
    await expect(withCurrentRfc64CatalogPolicyV1(
      () => Promise.reject('denied'),
      async () => 'sent',
    )).rejects.toBe('denied');
  });
});
