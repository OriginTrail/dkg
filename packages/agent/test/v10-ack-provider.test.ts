import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { NoChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SYSTEM_PARANETS } from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

async function createAgent(chainAdapter: ChainAdapter) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'AckProviderTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter,
    nodeRole: 'core',
  });
  await agent.start();
  return { agent, store, chain: chainAdapter };
}

describe('v10 ACK provider wiring', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
  });

  it('uses V10 publish path when chain supports V10 (EVMChainAdapter)', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    ({ agent } = await createAgent(chain));

    const cgId = 'v10-ack-test-cg';
    await agent.createContextGraph({ id: cgId, name: 'V10 ACK Test CG' });

    const result = await agent.publish(cgId, [
      { subject: 'urn:test:ack-provider', predicate: 'http://schema.org/name', object: '"ACK"', graph: '' },
    ]);

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(typeof result.onChainResult!.batchId).toBe('bigint');
  });

  it('publishes tentatively when chain does not support V10 (NoChainAdapter)', async () => {
    ({ agent } = await createAgent(new NoChainAdapter()));

    const result = await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:no-ack-provider', predicate: 'http://schema.org/name', object: '"No ACK"', graph: '' },
    ]);

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
  });
});
