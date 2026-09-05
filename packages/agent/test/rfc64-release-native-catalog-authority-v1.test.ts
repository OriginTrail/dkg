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
  parseRfc64AuthoritySnapshotV1,
} from '../src/rfc64/release-native-catalog-authority-v1.js';
import { Rfc64CatalogAccessPolicyRegistryV1 } from '../src/rfc64/catalog-access-policy-v1.js';

const NETWORK_ID = 'otp:31337' as NetworkIdV1;
const CONTEXT_GRAPH_ID = (
  '0x1111111111111111111111111111111111111111/release-native'
) as ContextGraphIdV1;
const OWNER = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const MEMBER = '0x2222222222222222222222222222222222222222' as EvmAddressV1;
const CONTRACT = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'44'.repeat(32)}`;
const NAME_HASH = `0x${'55'.repeat(32)}`;

function authoritySnapshot(
  overrides: Partial<ContextGraphAuthoritySnapshot> = {},
): ContextGraphAuthoritySnapshot {
  return {
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
    ...overrides,
  };
}

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
    const snapshot = authoritySnapshot();
    const first = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot: parseRfc64AuthoritySnapshotV1(snapshot, 9n),
    });
    const replay = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot: parseRfc64AuthoritySnapshotV1(
        { ...snapshot, participantAgents: [OWNER, MEMBER, MEMBER] },
        9n,
      ),
    });

    expect(() => assertContextGraphPolicyV1(first.policy)).not.toThrow();
    expect(() => assertMemberRosterV1(first.roster)).not.toThrow();
    expect(first.policyDigest)
      .toBe('0x1c902ee425042462b4ccd4292064d18924efd954fd5649c6cf8119252a852d16');
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

  it('keeps finalized policy ownership separate from private roster membership', async () => {
    const authority = composeRfc64FinalizedCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      snapshot: parseRfc64AuthoritySnapshotV1(authoritySnapshot({
        participantAgents: [MEMBER],
        ownershipEra: '3',
        policyVersion: '5',
        rosterVersion: '4',
        sourceBlockNumber: '43',
      }), 9n),
    });

    expect(authority.policy.publishAuthority).toBe(OWNER);
    expect(authority.roster?.members).toEqual([
      { agentAddress: MEMBER, roles: ['holder', 'provider'] },
    ]);

    const authorizeRemote = async (remoteAgentAddress: EvmAddressV1) => {
      const registry = new Rfc64CatalogAccessPolicyRegistryV1({
        localAgentAddress: MEMBER,
        resolveRemoteAgentAddress: async () => remoteAgentAddress,
      });
      registry.accept(authority);
      return registry.authorize({
        operation: 'fetch-inbound',
        remotePeerId: '12D3KooReleaseNativePeer',
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        policyDigest: authority.policyDigest,
      });
    };
    await expect(authorizeRemote(OWNER)).resolves.toBeNull();
    await expect(authorizeRemote(MEMBER)).resolves.toEqual({
      accessPolicy: 1,
      policyDigest: authority.policyDigest,
    });
  });

  it('normalizes and snapshots a valid finalized authority exactly once', () => {
    const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const member = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const contract = '0xcccccccccccccccccccccccccccccccccccccccc';
    const parsed = parseRfc64AuthoritySnapshotV1(authoritySnapshot({
      governanceContract: contract.toUpperCase().replace('0X', '0x'),
      owner: owner.toUpperCase().replace('0X', '0x'),
      publishAuthority: owner.toUpperCase().replace('0X', '0x'),
      participantAgents: [member.toUpperCase().replace('0X', '0x'), owner, member],
      nameHash: `0x${'AB'.repeat(32)}`,
      sourceBlockHash: `0x${'CD'.repeat(32)}`,
    }), 9n);

    expect(parsed).toMatchObject({
      governanceContract: contract,
      owner,
      publishAuthority: owner,
      nameHash: `0x${'ab'.repeat(32)}`,
      sourceBlockHash: `0x${'cd'.repeat(32)}`,
      participantAgents: [owner, member],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.participantAgents)).toBe(true);
  });

  it('rejects a snapshot whose Context Graph ID differs from the requested ID', () => {
    expect(() => parseRfc64AuthoritySnapshotV1(authoritySnapshot(), 10n))
      .toThrow(/does not match the requested ID/u);
  });

  it('bounds participant arrays before reading or normalizing their entries', () => {
    let readFirst = false;
    let readKeys = false;
    const participants = Array<string>(257).fill(MEMBER);
    Object.defineProperty(participants, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        readFirst = true;
        return MEMBER;
      },
    });

    const guardedParticipants = new Proxy(participants, {
      ownKeys: (target) => {
        readKeys = true;
        return Reflect.ownKeys(target);
      },
    });

    expect(() => parseRfc64AuthoritySnapshotV1(authoritySnapshot({
      participantAgents: guardedParticipants,
    }), 9n)).toThrow(/cannot exceed 256/u);
    expect(readFirst).toBe(false);
    expect(readKeys).toBe(false);
  });

  it('rejects an unregistered authority roster with more than 256 unique members', () => {
    const members = Array.from({ length: 257 }, (_, index) => (
      `0x${(index + 1).toString(16).padStart(40, '0')}` as EvmAddressV1
    ));

    expect(() => composeRfc64UnregisteredCatalogAuthorityV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OWNER,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthorityAccountId: '0',
      memberAddresses: members,
      rosterVersion: '0',
    })).toThrow(/member roster cannot exceed 256/u);
  });

  it.each([
    ['boolean active', { active: 1 }],
    ['access enum', { accessPolicy: 2 }],
    ['publish enum', { publishPolicy: 2 }],
    ['publish tuple', { publishPolicy: 1 }],
    ['canonical decimal', { policyVersion: '04' }],
    ['address', { owner: '0x1234' }],
    ['hash', { sourceBlockHash: '0x1234' }],
  ])('rejects an invalid %s field', (_label, override) => {
    expect(() => parseRfc64AuthoritySnapshotV1(
      authoritySnapshot(override as Partial<ContextGraphAuthoritySnapshot>),
      9n,
    )).toThrow();
  });
});
