// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Contract, ethers, Wallet } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import type { ContextGraphAuthorityIndexStore } from '../src/context-graph-authority-index-checkpoint.js';

import {
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  makeAdapterConfig,
  revertSnapshot,
  takeSnapshot,
} from './evm-test-context.js';

describe('EVM Context Graph authority snapshot ABI integration', () => {
  let fileSnapshotId: string;

  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
  });

  afterAll(async () => {
    await revertSnapshot(fileSnapshotId);
  });

  it('materializes current authority and every generation from finalized events', async () => {
    const provider = createProvider();
    const { rpcUrl, hubAddress } = getSharedContext();
    let checkpoint: Readonly<{ token: number; value: unknown | null }> | undefined;
    const store: ContextGraphAuthorityIndexStore = {
      load: async () => checkpoint,
      compareAndSwap: async (_scope, expectedToken, value) => {
        if (checkpoint?.token !== expectedToken) return undefined;
        const nextToken = expectedToken === undefined ? 1 : expectedToken + 1;
        checkpoint = Object.freeze({ token: nextToken, value });
        return nextToken;
      },
      invalidate: async (_scope, expectedToken) => {
        if (checkpoint?.token !== expectedToken) return undefined;
        const nextToken = expectedToken + 1;
        checkpoint = Object.freeze({ token: nextToken, value: null });
        return nextToken;
      },
    };
    const adapter = new EVMChainAdapter({
      ...makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.CORE_OP),
      localContextGraphAuthorityIndexStore: store,
    });
    const owner = adapter.getSignerAddress();
    const retainedAgent = new Wallet(HARDHAT_KEYS.EXTRA1).address;
    const removedAgent = new Wallet(HARDHAT_KEYS.EXTRA2).address;
    const addedAgent = new Wallet(HARDHAT_KEYS.PUBLISHER2).address;
    const initialAuthority = new Wallet(HARDHAT_KEYS.EXTRA3).address;
    const rotatedAuthority = new Wallet(HARDHAT_KEYS.PUBLISHER).address;
    const newOwner = new Wallet(HARDHAT_KEYS.REC3_ADMIN).address;
    const nameHash = ethers.keccak256(
      ethers.toUtf8Bytes('rfc64-authority-snapshot-abi-integration'),
    );

    const created = await adapter.createOnChainContextGraph({
      participantAgents: [removedAgent, retainedAgent],
      metadataBatchId: 0n,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: initialAuthority,
      publishAuthorityAccountId: 0n,
      nameHash,
    });
    expect(created.success).toBe(true);

    const creationBlock = await provider.getBlock(created.blockNumber);
    expect(creationBlock?.hash).toBeTruthy();

    const initial = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(initial).toMatchObject({
      chainId: '31337',
      contextGraphId: created.contextGraphId.toString(10),
      owner: owner.toLowerCase(),
      active: true,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: initialAuthority.toLowerCase(),
      publishAuthorityAccountId: '0',
      nameHash: nameHash.toLowerCase(),
      ownershipEra: '0',
      policyVersion: '0',
      rosterVersion: '0',
      sourceBlockNumber: created.blockNumber.toString(10),
      sourceBlockHash: creationBlock!.hash!.toLowerCase(),
    });
    expect(initial.participantAgents).toEqual(
      [removedAgent, retainedAgent].map((address) => address.toLowerCase()).sort(),
    );

    await adapter.addContextGraphParticipantAgent(
      created.contextGraphId,
      addedAgent,
    );
    const afterAdd = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterAdd).toMatchObject({
      rosterVersion: '1',
      policyVersion: '0',
      sourceBlockNumber: initial.sourceBlockNumber,
      sourceBlockHash: initial.sourceBlockHash,
    });
    expect(afterAdd.participantAgents).toEqual(
      [addedAgent, removedAgent, retainedAgent]
        .map((address) => address.toLowerCase())
        .sort(),
    );

    await adapter.removeContextGraphParticipantAgent(
      created.contextGraphId,
      removedAgent,
    );
    const afterRemove = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterRemove).toMatchObject({
      rosterVersion: '2',
      policyVersion: '0',
      sourceBlockNumber: initial.sourceBlockNumber,
      sourceBlockHash: initial.sourceBlockHash,
    });
    expect(afterRemove.participantAgents).toEqual(
      [addedAgent, retainedAgent].map((address) => address.toLowerCase()).sort(),
    );

    const contextGraphs = await adapter.getContract('ContextGraphs');
    const authorityReceipt = await (
      await contextGraphs.updatePublishAuthority(
        created.contextGraphId,
        rotatedAuthority,
        0n,
      )
    ).wait();
    const afterAuthority = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterAuthority).toMatchObject({
      publishPolicy: 0,
      publishAuthority: rotatedAuthority.toLowerCase(),
      policyVersion: '1',
      rosterVersion: '2',
      sourceBlockNumber: authorityReceipt.blockNumber.toString(10),
      sourceBlockHash: authorityReceipt.blockHash.toLowerCase(),
    });

    const policyReceipt = await (
      await contextGraphs.updatePublishPolicy(
        created.contextGraphId,
        1,
        ethers.ZeroAddress,
        0n,
      )
    ).wait();
    const afterPolicy = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterPolicy).toMatchObject({
      active: true,
      nameHash: nameHash.toLowerCase(),
      accessPolicy: 1,
      publishPolicy: 1,
      publishAuthority: null,
      publishAuthorityAccountId: '0',
      policyVersion: '2',
      rosterVersion: '2',
      sourceBlockNumber: policyReceipt.blockNumber.toString(10),
      sourceBlockHash: policyReceipt.blockHash.toLowerCase(),
    });

    const hub = new Contract(
      getSharedContext().hubAddress,
      ['function getAssetStorageAddress(string) view returns (address)'],
      provider,
    );
    const storage = new Contract(
      await hub.getAssetStorageAddress('ContextGraphStorage'),
      ['function transferFrom(address,address,uint256) external'],
      new Wallet(HARDHAT_KEYS.CORE_OP, provider),
    );
    const selfTransferReceipt = await (
      await storage.transferFrom(owner, owner, created.contextGraphId)
    ).wait();
    const afterSelfTransfer = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterSelfTransfer).toMatchObject({
      owner: owner.toLowerCase(),
      ownershipEra: afterPolicy.ownershipEra,
      policyVersion: afterPolicy.policyVersion,
      rosterVersion: afterPolicy.rosterVersion,
      sourceBlockNumber: afterPolicy.sourceBlockNumber,
      sourceBlockHash: afterPolicy.sourceBlockHash,
    });
    expect(BigInt(afterSelfTransfer.sourceBlockNumber))
      .toBeLessThan(BigInt(selfTransferReceipt.blockNumber));

    const transferReceipt = await (
      await storage.transferFrom(owner, newOwner, created.contextGraphId)
    ).wait();
    const afterTransfer = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterTransfer).toMatchObject({
      owner: newOwner.toLowerCase(),
      active: true,
      nameHash: nameHash.toLowerCase(),
      accessPolicy: 1,
      publishPolicy: 1,
      publishAuthority: null,
      participantAgents: [addedAgent, retainedAgent]
        .map((address) => address.toLowerCase())
        .sort(),
      ownershipEra: '1',
      policyVersion: '3',
      rosterVersion: '3',
      sourceBlockNumber: transferReceipt.blockNumber.toString(10),
      sourceBlockHash: transferReceipt.blockHash.toLowerCase(),
    });

    const finalized = await provider.getBlock('finalized');
    expect(finalized?.hash).toBe(transferReceipt.blockHash);
    expect(BigInt(afterTransfer.sourceBlockNumber))
      .toBeLessThanOrEqual(BigInt(finalized!.number));

    const deactivator = new Contract(
      await hub.getAssetStorageAddress('ContextGraphStorage'),
      ['function deactivateContextGraph(uint256 contextGraphId) external'],
      new Wallet(HARDHAT_KEYS.DEPLOYER, provider),
    );
    await (await deactivator.deactivateContextGraph(created.contextGraphId)).wait();
    const afterDeactivation = await adapter.getContextGraphAuthoritySnapshot(
      created.contextGraphId,
    );
    expect(afterDeactivation).toMatchObject({
      active: false,
      owner: newOwner.toLowerCase(),
      ownershipEra: afterTransfer.ownershipEra,
      policyVersion: afterTransfer.policyVersion,
      rosterVersion: afterTransfer.rosterVersion,
      sourceBlockNumber: afterTransfer.sourceBlockNumber,
      sourceBlockHash: afterTransfer.sourceBlockHash,
    });
  }, 120_000);
});
