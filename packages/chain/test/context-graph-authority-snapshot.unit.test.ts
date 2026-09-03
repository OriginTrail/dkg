// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const AUTHORITY = '0x3333333333333333333333333333333333333333';
const GOVERNANCE = '0x4444444444444444444444444444444444444444';
const FINALIZED_HASH = `0x${'55'.repeat(32)}`;
const CREATION_HASH = `0x${'66'.repeat(32)}`;
const POLICY_HASH = `0x${'77'.repeat(32)}`;
const NAME_HASH = `0x${'88'.repeat(32)}`;

function event(
  blockNumber: number,
  index: number,
  blockHash: string,
  args: readonly unknown[] = [],
) {
  return { blockNumber, index, blockHash, args };
}

function makeEvmAuthorityAdapter(options: { reorg?: boolean } = {}) {
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:1',
    hubAddress: GOVERNANCE,
    privateKey: `0x${'11'.repeat(32)}`,
    allowNoAdminSigner: true,
    chainId: 'evm:31337',
  });
  adapter.initialized = true;
  adapter.init = async () => {};

  const logs: Record<string, readonly ReturnType<typeof event>[]> = {
    ContextGraphCreated: [event(10, 1, CREATION_HASH, [9n, OWNER, NAME_HASH])],
    Transfer: [
      event(10, 0, CREATION_HASH),
      event(15, 0, `0x${'99'.repeat(32)}`),
    ],
    PublishPolicyUpdated: [event(20, 0, POLICY_HASH)],
    PublishAuthorityUpdated: [event(21, 0, POLICY_HASH)],
    AgentParticipantAdded: [event(22, 0, `0x${'aa'.repeat(32)}`)],
    AgentParticipantRemoved: [event(23, 0, `0x${'bb'.repeat(32)}`)],
  };
  const current = Object.assign(
    [OWNER, [MEMBER, OWNER], 0n, true, 0n, 1n, 0n, AUTHORITY, 7n],
    {
      owner: OWNER,
      participantAgents: [MEMBER, OWNER],
      active: true,
      accessPolicy: 1n,
      publishPolicy: 0n,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 7n,
    },
  );
  const contract = {
    filters: Object.fromEntries(Object.keys(logs).map((name) => [
      name,
      (...args: readonly unknown[]) => ({ name, args }),
    ])),
    queryFilter: async (filter: { name: string }) => logs[filter.name] ?? [],
    getContextGraph: { staticCall: async () => current },
    getAddress: async () => GOVERNANCE,
  };
  const provider = {
    getBlock: async (tag: string | number) => tag === 'finalized'
      ? { number: 30, hash: FINALIZED_HASH }
      : { number: 30, hash: options.reorg ? `0x${'cc'.repeat(32)}` : FINALIZED_HASH },
    getNetwork: async () => ({ chainId: 31337n }),
  };
  adapter.contracts = {
    contextGraphStorage: { connect: () => contract },
  };
  adapter.readTipProvider = async (
    _label: string,
    read: (selectedProvider: typeof provider) => Promise<unknown>,
  ) => read(provider);
  return adapter as EVMChainAdapter;
}

describe('RFC-64 Context Graph authority snapshots', () => {
  it('reads one stable finalized EVM generation and derives monotonic epochs', async () => {
    const snapshot = await makeEvmAuthorityAdapter()
      .getContextGraphAuthoritySnapshot(9n);

    expect(snapshot).toEqual({
      chainId: '31337',
      governanceContract: GOVERNANCE,
      contextGraphId: '9',
      owner: OWNER,
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: '7',
      participantAgents: [OWNER, MEMBER],
      nameHash: NAME_HASH,
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
      sourceBlockNumber: '21',
      sourceBlockHash: POLICY_HASH,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.participantAgents)).toBe(true);
  });

  it('rejects a finalized anchor that changes while the generation is read', async () => {
    await expect(makeEvmAuthorityAdapter({ reorg: true })
      .getContextGraphAuthoritySnapshot(9n))
      .rejects.toThrow('anchor changed');
  });

  it('provides the same authority surface in offline mock-chain mode', async () => {
    const mock = new MockChainAdapter('mock:31337', OWNER);
    const created = await mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 0n,
      participantAgents: [MEMBER],
      nameHash: NAME_HASH,
    });

    await expect(mock.getContextGraphAuthoritySnapshot(created.contextGraphId))
      .resolves.toMatchObject({
        chainId: '31337',
        contextGraphId: created.contextGraphId.toString(10),
        owner: OWNER,
        accessPolicy: 1,
        publishPolicy: 0,
        publishAuthority: AUTHORITY,
        participantAgents: [MEMBER],
        nameHash: NAME_HASH,
        ownershipEra: '0',
        policyVersion: '0',
        rosterVersion: '0',
      });
  });
});
