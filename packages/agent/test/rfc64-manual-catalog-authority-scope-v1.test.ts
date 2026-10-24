// SPDX-License-Identifier: Apache-2.0

/**
 * A manual peer table (`rfc64Catalog.accessPolicyAuthority`) answers for the
 * selected private graphs it was configured for; every other private graph
 * resolves its peers from its own state (`rfc64/manual-catalog-authority-scope-v1.ts`).
 * Checked through the catalog's real access-policy registry.
 */
import { describe, expect, it, vi } from 'vitest';
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
import { Rfc64CatalogAccessPolicyRegistryV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { scopeRfc64CatalogAccessAuthorityV1 } from '../src/rfc64/manual-catalog-authority-scope-v1.js';

const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const CURATOR = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const AUTHOR = '0x3333333333333333333333333333333333333333' as EvmAddressV1;
const MEMBER = '0x4444444444444444444444444444444444444444' as EvmAddressV1;
const OUTSIDER = '0x5555555555555555555555555555555555555555' as EvmAddressV1;
const AUTHOR_PEER = '12D3KooWAuthorPeerOfTheTable';
const MEMBER_PEER = '12D3KooWMemberPeerJoinedLater';
const OUTSIDER_PEER = '12D3KooWOutsiderPeer';
const NETWORK = 'otp:20430' as const;
/** The private graph the activation config selected, and the table was checked against. */
const SELECTED = `${OWNER}/selected-private` as ContextGraphIdV1;
/** A private graph this node joined at runtime. */
const JOINED = `${OWNER}/joined-private` as ContextGraphIdV1;

function privatePolicy(contextGraphId: ContextGraphIdV1): ContextGraphPolicyV1 {
  return {
    networkId: NETWORK,
    contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: CURATOR,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: { kind: 'owner-signed-unregistered', ownerAddress: OWNER, ownerAuthorityEra: '0' },
    effectiveAt: '0',
    issuedAt: '0',
  };
}

function digestFor(policy: ContextGraphPolicyV1): Digest32V1 {
  return computeContextGraphPolicyObjectDigestV1({
    issuer: OWNER,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: policy,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1);
}

function roster(policy: ContextGraphPolicyV1, policyDigest: Digest32V1): MemberRosterV1 {
  return {
    networkId: NETWORK,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousRosterDigest: null,
    policyDigest,
    administrativeDelegationDigest: null,
    members: [CURATOR, AUTHOR, MEMBER].map((agentAddress) => ({
      agentAddress,
      roles: ['holder', 'provider'] as const,
    })),
    issuedAt: '0',
  } as MemberRosterV1;
}

/**
 * The curator's node: a manual table binding the author's peer, configured for
 * SELECTED, or the same lookup supplied in code as a function authority.
 */
function curatorNode(options: { readonly functionAuthority?: boolean } = {}) {
  const manualContextGraphs = options.functionAuthority === true ? undefined : [SELECTED];
  const table = new Map([[AUTHOR_PEER, AUTHOR]]);
  const ownState = new Map([[MEMBER_PEER, MEMBER], [AUTHOR_PEER, AUTHOR], [OUTSIDER_PEER, OUTSIDER]]);
  const manual = Object.freeze({
    localAgentAddress: CURATOR,
    resolveRemoteAgentAddress: vi.fn(async (peerId: string) => table.get(peerId) ?? null),
  });
  const resolveLocalAgentAddress = vi.fn(async () => CURATOR);
  const resolveRemoteAgentAddress = vi.fn(async (peerId: string) => ownState.get(peerId) ?? null);
  const authority = scopeRfc64CatalogAccessAuthorityV1({
    manual,
    manualContextGraphs,
    resolveLocalAgentAddress,
    resolveRemoteAgentAddress,
  });
  const registry = new Rfc64CatalogAccessPolicyRegistryV1(authority);
  const digests = new Map<ContextGraphIdV1, Digest32V1>();
  for (const contextGraphId of [SELECTED, JOINED]) {
    const policy = privatePolicy(contextGraphId);
    const policyDigest = digestFor(policy);
    registry.accept({ policy, policyDigest, roster: roster(policy, policyDigest) });
    digests.set(contextGraphId, policyDigest);
  }
  const announce = (remotePeerId: string, contextGraphId: ContextGraphIdV1, policyDigest = digests.get(contextGraphId)!) =>
    registry.authorize({ operation: 'announce-inbound', remotePeerId, networkId: NETWORK, contextGraphId, policyDigest });
  return { authority, manual, resolveLocalAgentAddress, resolveRemoteAgentAddress, announce, digests };
}

describe('a manual catalog peer table', () => {
  it('answers alone for the graph it was configured for', async () => {
    const node = curatorNode();

    await expect(node.announce(AUTHOR_PEER, SELECTED)).resolves.toMatchObject({ accessPolicy: 1 });
    // The member is on the graph's roster but not in the table: the table decides.
    await expect(node.announce(MEMBER_PEER, SELECTED)).resolves.toBeNull();
    expect(node.resolveLocalAgentAddress).not.toHaveBeenCalled();
    expect(node.resolveRemoteAgentAddress).not.toHaveBeenCalled();
  });

  it('leaves a private graph it was not configured for to the graph\'s own state', async () => {
    const node = curatorNode();

    // A member that joined later is admitted, as on a node without the table.
    await expect(node.announce(MEMBER_PEER, JOINED)).resolves.toMatchObject({ accessPolicy: 1 });
    expect(node.resolveRemoteAgentAddress).toHaveBeenCalledWith(MEMBER_PEER, JOINED);
    expect(node.resolveLocalAgentAddress).toHaveBeenCalledWith(JOINED, undefined);
    expect(node.manual.resolveRemoteAgentAddress).not.toHaveBeenCalledWith(MEMBER_PEER, JOINED);

    // Every other check still holds: a peer whose agent is not on the roster,
    // a peer nobody knows, and a policy the node has not accepted are denied.
    await expect(node.announce(OUTSIDER_PEER, JOINED)).resolves.toBeNull();
    await expect(node.announce('12D3KooWUnknownPeer', JOINED)).resolves.toBeNull();
    await expect(node.announce(MEMBER_PEER, JOINED, node.digests.get(SELECTED)!)).resolves.toBeNull();
  });

  it('keeps a function authority supplied in code answering for every graph', async () => {
    const node = curatorNode({ functionAuthority: true });

    expect(node.authority).toBe(node.manual);
    await expect(node.announce(MEMBER_PEER, JOINED)).resolves.toBeNull();
    expect(node.resolveRemoteAgentAddress).not.toHaveBeenCalled();
  });

  it('resolves every graph from its own state on a node without a configured authority', async () => {
    const resolveLocalAgentAddress = vi.fn(async () => CURATOR);
    const resolveRemoteAgentAddress = vi.fn(async () => MEMBER);
    const authority = scopeRfc64CatalogAccessAuthorityV1({
      manual: undefined,
      manualContextGraphs: undefined,
      resolveLocalAgentAddress,
      resolveRemoteAgentAddress,
    });

    expect(authority).toEqual({ resolveLocalAgentAddress, resolveRemoteAgentAddress });
  });
});
