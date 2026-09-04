// SPDX-License-Identifier: Apache-2.0

import {
  assertContextGraphPolicyV1,
  assertMemberRosterV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import type { ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';

import {
  composeRfc64FinalizedCatalogAuthorityV1,
  composeRfc64RegisteredRosterVersionV1,
  composeRfc64UnregisteredCatalogAuthorityV1,
} from '../src/rfc64/release-native-catalog-authority-v1.js';

const NETWORK_ID = 'otp:31337' as NetworkIdV1;
const CONTEXT_GRAPH_ID = (
  '0x1111111111111111111111111111111111111111/release-native'
) as ContextGraphIdV1;
const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const MEMBER = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const CONTRACT = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const NAME_HASH = `0x${'55'.repeat(32)}`;

describe('release-native RFC-64 catalog authority', () => {
  it('orders registered roster generations across local and chain changes', () => {
    expect(composeRfc64RegisteredRosterVersionV1('0', '1788482000000'))
      .toBe('1788482000000');
    expect(composeRfc64RegisteredRosterVersionV1('1', '0'))
      .toBe('10000000000000');
    expect(BigInt(composeRfc64RegisteredRosterVersionV1('1', '1788482000001')))
      .toBeGreaterThan(BigInt(composeRfc64RegisteredRosterVersionV1('1', '1788482000000')));
    expect(() => composeRfc64RegisteredRosterVersionV1('0', '10000000000000'))
      .toThrow(/generation lane/u);
  });

  it.each([
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const)('composes and validates unregistered policy cell %i%i', (accessPolicy, publishPolicy) => {
    const first = composeRfc64UnregisteredCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OWNER,
      accessPolicy,
      publishPolicy,
      publishAuthorityAccountId: '7',
      memberAddresses: [MEMBER, OWNER, MEMBER],
      rosterVersion: '9',
    });
    const replay = composeRfc64UnregisteredCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OWNER,
      accessPolicy,
      publishPolicy,
      publishAuthorityAccountId: '7',
      memberAddresses: [MEMBER, OWNER],
      rosterVersion: '9',
    });

    expect(() => assertContextGraphPolicyV1(first.policy)).not.toThrow();
    expect(first.policyDigest).toBe(replay.policyDigest);
    expect(first.policy).toMatchObject({
      accessPolicy,
      publishPolicy,
      publishAuthority: publishPolicy === 0 ? OWNER : null,
      publishAuthorityAccountId: publishPolicy === 0 ? '7' : '0',
      source: { kind: 'owner-signed-unregistered', ownerAddress: OWNER },
    });
    if (accessPolicy === 0) {
      expect(first.roster).toBeNull();
    } else {
      expect(() => assertMemberRosterV1(first.roster)).not.toThrow();
      expect(first.roster?.policyDigest).toBe(first.policyDigest);
      expect(first.roster?.version).toBe('9');
      expect(first.roster?.members).toEqual([
        { agentAddress: OWNER, roles: ['holder', 'provider'] },
        { agentAddress: MEMBER, roles: ['holder', 'provider'] },
      ]);
    }
  });

  it('derives a deterministic finalized generation and policy-bound roster', () => {
    const snapshot: ContextGraphAuthoritySnapshot = {
      chainId: '31337',
      governanceContract: CONTRACT,
      contextGraphId: '9',
      owner: OWNER,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: OWNER,
      publishAuthorityAccountId: '7',
      participantAgents: [MEMBER, OWNER],
      nameHash: NAME_HASH,
      ownershipEra: '2',
      policyVersion: '4',
      rosterVersion: '3',
      sourceBlockNumber: '42',
      sourceBlockHash: BLOCK_HASH,
    };
    const first = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot,
    });
    const replay = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot: { ...snapshot, participantAgents: [OWNER, MEMBER, MEMBER] },
    });

    expect(() => assertContextGraphPolicyV1(first.policy)).not.toThrow();
    expect(() => assertMemberRosterV1(first.roster)).not.toThrow();
    expect(first.policyDigest).toBe(replay.policyDigest);
    expect(first.policy).toMatchObject({
      era: '2',
      version: '4',
      source: {
        kind: 'finalized-chain',
        blockNumber: '42',
        blockHash: BLOCK_HASH,
      },
    });
    expect(first.roster).toMatchObject({
      era: '2',
      version: '3',
      policyDigest: first.policyDigest,
    });
  });
});
