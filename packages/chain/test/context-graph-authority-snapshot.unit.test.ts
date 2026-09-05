// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import type { ContextGraphAuthoritySnapshot } from '../src/chain-adapter.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const AUTHORITY = '0x3333333333333333333333333333333333333333';
const GOVERNANCE = '0x4444444444444444444444444444444444444444';
const SECOND_MEMBER = '0x5555555555555555555555555555555555555555';
const SECOND_AUTHORITY = '0x6666666666666666666666666666666666666666';
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
  adapter.cgRegistryScanPageSize = 10;
  const evidence = {
    filters: [] as Array<readonly [string, ...unknown[]]>,
    ranges: [] as Array<readonly [number, number]>,
    staticCalls: [] as Array<readonly [bigint, { blockTag: number }]>,
    deploymentReads: [] as Array<readonly [string, string, string]>,
  };

  const logs: Record<string, readonly ReturnType<typeof event>[]> = {
    ContextGraphCreated: [event(10, 1, CREATION_HASH, [9n, OWNER, NAME_HASH])],
    Transfer: [
      event(10, 0, CREATION_HASH, [ethers.ZeroAddress, OWNER, 9n]),
      event(15, 0, `0x${'99'.repeat(32)}`, [SECOND_MEMBER, OWNER, 9n]),
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
      (...args: readonly unknown[]) => {
        evidence.filters.push([name, ...args]);
        const expectedArgs = name === 'Transfer'
          ? [null, null, 9n]
          : [9n];
        expect(args).toEqual(expectedArgs);
        return { name, args };
      },
    ])),
    queryFilter: async (filter: { name: string }, fromBlock: number, toBlock: number) => {
      evidence.ranges.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1 > 10) throw new Error('oversized log range');
      return (logs[filter.name] ?? []).filter(
        (entry) => entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock,
      );
    },
    getContextGraph: {
      staticCall: async (contextGraphId: bigint, readOptions: { blockTag: number }) => {
        evidence.staticCalls.push([contextGraphId, readOptions]);
        expect(contextGraphId).toBe(9n);
        expect(readOptions).toEqual({ blockTag: 30 });
        return current;
      },
    },
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
  adapter.resolveContractDeployBlock = async (
    address: string,
    operation: string,
    label: string,
  ) => {
    evidence.deploymentReads.push([address, operation, label]);
    return { fromBlock: 7, head: 30, scanProviders: [] };
  };
  adapter.authorityEvidence = evidence;
  return adapter as EVMChainAdapter;
}

describe('RFC-64 Context Graph authority snapshots', () => {
  it('reads one stable finalized EVM generation and derives monotonic epochs', async () => {
    const adapter = makeEvmAuthorityAdapter();
    const snapshot = await adapter.getContextGraphAuthoritySnapshot(9n);

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
    const evidence = (adapter as any).authorityEvidence;
    expect(evidence.staticCalls).toEqual([[9n, { blockTag: 30 }]]);
    expect(evidence.deploymentReads).toEqual([[
      GOVERNANCE,
      'getContextGraphAuthoritySnapshot',
      'ContextGraphStorage',
    ]]);
    expect(evidence.filters).toEqual([
      ['ContextGraphCreated', 9n],
      ['Transfer', null, null, 9n],
      ['PublishPolicyUpdated', 9n],
      ['PublishAuthorityUpdated', 9n],
      ['AgentParticipantAdded', 9n],
      ['AgentParticipantRemoved', 9n],
    ]);
    expect(evidence.ranges).toHaveLength(18);
    expect(evidence.ranges).toEqual(expect.arrayContaining([
      [7, 16],
      [17, 26],
      [27, 30],
    ]));
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

  it('advances mock authority high-waters and source evidence across every mutation class', async () => {
    const mock = new MockChainAdapter('mock:31337', OWNER);
    const created = await mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: AUTHORITY,
      publishAuthorityAccountId: 0n,
      participantAgents: [MEMBER],
      nameHash: NAME_HASH,
    });
    let accepted: ContextGraphAuthoritySnapshot | undefined;
    const accept = (snapshot: ContextGraphAuthoritySnapshot) => {
      if (accepted !== undefined) {
        const policyChanged = snapshot.owner !== accepted.owner
          || snapshot.publishPolicy !== accepted.publishPolicy
          || snapshot.publishAuthority !== accepted.publishAuthority
          || snapshot.publishAuthorityAccountId !== accepted.publishAuthorityAccountId;
        const rosterChanged = snapshot.participantAgents.join(',')
          !== accepted.participantAgents.join(',');
        if (policyChanged) {
          expect(BigInt(snapshot.sourceBlockNumber))
            .toBeGreaterThan(BigInt(accepted.sourceBlockNumber));
          expect(snapshot.sourceBlockHash).not.toBe(accepted.sourceBlockHash);
          expect(BigInt(snapshot.policyVersion))
            .toBeGreaterThan(BigInt(accepted.policyVersion));
        } else {
          expect(snapshot.sourceBlockNumber).toBe(accepted.sourceBlockNumber);
          expect(snapshot.sourceBlockHash).toBe(accepted.sourceBlockHash);
          expect(snapshot.policyVersion).toBe(accepted.policyVersion);
        }
        if (snapshot.owner !== accepted.owner) {
          expect(BigInt(snapshot.ownershipEra))
            .toBeGreaterThan(BigInt(accepted.ownershipEra));
        }
        if (rosterChanged) {
          expect(BigInt(snapshot.rosterVersion))
            .toBeGreaterThan(BigInt(accepted.rosterVersion));
        }
      }
      accepted = snapshot;
    };
    const readAndAccept = async () => {
      const snapshot = await mock.getContextGraphAuthoritySnapshot(created.contextGraphId);
      accept(snapshot);
      return snapshot;
    };
    const expectSource = (
      snapshot: ContextGraphAuthoritySnapshot,
      tx: { blockNumber: number },
    ) => {
      expect(snapshot.sourceBlockNumber).toBe(tx.blockNumber.toString(10));
      expect(snapshot.sourceBlockHash)
        .toBe(`0x${tx.blockNumber.toString(16).padStart(64, '0')}`);
    };

    const initial = await readAndAccept();
    expect(initial).toMatchObject({
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
    });
    expectSource(initial, created);

    await mock.addContextGraphParticipantAgent(
      created.contextGraphId,
      SECOND_MEMBER,
    );
    const afterAdd = await readAndAccept();
    expect(afterAdd).toMatchObject({
      participantAgents: [MEMBER, SECOND_MEMBER],
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '1',
    });
    expect(afterAdd.sourceBlockNumber).toBe(initial.sourceBlockNumber);
    expect(afterAdd.sourceBlockHash).toBe(initial.sourceBlockHash);

    await mock.removeContextGraphParticipantAgent(
      created.contextGraphId,
      SECOND_MEMBER,
    );
    const afterRemove = await readAndAccept();
    expect(afterRemove).toMatchObject({
      participantAgents: [MEMBER],
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '2',
    });
    expect(afterRemove.sourceBlockNumber).toBe(initial.sourceBlockNumber);
    expect(afterRemove.sourceBlockHash).toBe(initial.sourceBlockHash);

    const authorityUpdated = await mock.__updateContextGraphPublishAuthority(
      created.contextGraphId,
      SECOND_AUTHORITY,
    );
    const afterAuthority = await readAndAccept();
    expect(afterAuthority).toMatchObject({
      publishAuthority: SECOND_AUTHORITY,
      ownershipEra: '0',
      policyVersion: '1',
      rosterVersion: '2',
    });
    expectSource(afterAuthority, authorityUpdated);

    const policyUpdated = await mock.__updateContextGraphPublishPolicy(
      created.contextGraphId,
      1,
    );
    const afterPolicy = await readAndAccept();
    expect(afterPolicy).toMatchObject({
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      ownershipEra: '0',
      policyVersion: '2',
      rosterVersion: '2',
    });
    expectSource(afterPolicy, policyUpdated);

    const transferred = await mock.__transferContextGraphOwnership(
      created.contextGraphId,
      SECOND_MEMBER,
    );
    const afterTransfer = await readAndAccept();
    expect(afterTransfer).toMatchObject({
      owner: SECOND_MEMBER,
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
    });
    expectSource(afterTransfer, transferred);

    const ownerCuratedMock = new MockChainAdapter('mock:31338', OWNER);
    const ownerCurated = await ownerCuratedMock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: OWNER,
      publishAuthorityAccountId: 0n,
      participantAgents: [MEMBER],
      nameHash: NAME_HASH,
    });
    const ownerCuratedInitial = await ownerCuratedMock.getContextGraphAuthoritySnapshot(
      ownerCurated.contextGraphId,
    );
    expect(ownerCuratedInitial).toMatchObject({
      owner: OWNER,
      publishAuthority: OWNER,
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
    });

    const ownerCuratedTransfer = await ownerCuratedMock.__transferContextGraphOwnership(
      ownerCurated.contextGraphId,
      SECOND_MEMBER,
    );
    const ownerCuratedAfterTransfer = await ownerCuratedMock.getContextGraphAuthoritySnapshot(
      ownerCurated.contextGraphId,
    );
    expect(ownerCuratedAfterTransfer).toMatchObject({
      owner: SECOND_MEMBER,
      publishAuthority: SECOND_MEMBER,
      publishAuthorityAccountId: '0',
      ownershipEra: '1',
      policyVersion: '2',
      rosterVersion: '1',
    });
    expectSource(ownerCuratedAfterTransfer, ownerCuratedTransfer);
  });
});
