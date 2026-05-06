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

async function createAgent(chainAdapter: ChainAdapter, operationalKeys?: string[]) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name: 'AckProviderTestAgent',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter,
    chainConfig: operationalKeys
      ? {
          rpcUrl: 'http://127.0.0.1:8545',
          hubAddress: ethers.ZeroAddress,
          operationalKeys,
        }
      : undefined,
    nodeRole: 'core',
  });
  await agent.start();
  return { agent, store, chain: chainAdapter };
}

function delayedAdapterPublisherAddress(chain: ChainAdapter, address: string): { chain: ChainAdapter; unlock: () => void } {
  let unlocked = false;
  return {
    chain: new Proxy(chain, {
    get(target, prop, receiver) {
      if (prop === 'getOperationalPrivateKey') return undefined;
      if (prop === 'getAuthorizedPublisherAddress') return undefined;
      if (prop === 'getSignerAddress') return undefined;
      if (prop === 'getSignerAddresses') {
        return () => {
          if (!unlocked) throw new Error('signer address unavailable during startup');
          return [address];
        };
      }
      if (prop === 'signMessage') {
        const sign = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          if (!unlocked) throw new Error('signer locked during startup');
          return sign.apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    }) as ChainAdapter,
    unlock: () => { unlocked = true; },
  };
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
    // PR #253: createContextGraph is a local-only primitive. On-chain
    // registration must now be an explicit follow-up call — tests that
    // publish need a numeric onChainId to exist first.
    await agent.registerContextGraph(cgId);

    const result = await agent.publish(cgId, [
      { subject: 'urn:test:ack-provider', predicate: 'http://schema.org/name', object: '"ACK"', graph: '' },
    ]);

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(typeof result.onChainResult!.batchId).toBe('bigint');
  });

  it('uses adapter-backed publisher signing when chainAdapter does not expose a private key', async () => {
    const expectedAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    const delayed = delayedAdapterPublisherAddress(createEVMAdapter(HARDHAT_KEYS.CORE_OP), expectedAddress);
    const chain = delayed.chain;
    ({ agent } = await createAgent(chain));

    const cgId = 'adapter-backed-publisher-cg';
    await agent.createContextGraph({ id: cgId, name: 'Adapter-backed Publisher CG' });
    await agent.registerContextGraph(cgId, { callerAgentAddress: expectedAddress });
    delayed.unlock();

    const result = await agent.publish(cgId, [
      { subject: 'urn:test:adapter-backed-agent', predicate: 'http://schema.org/name', object: '"Adapter backed"', graph: '' },
    ]);

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('publishes tentatively when chain does not support V10 but a publisher key is configured', async () => {
    ({ agent } = await createAgent(new NoChainAdapter(), [HARDHAT_KEYS.CORE_OP]));

    const result = await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:no-ack-provider', predicate: 'http://schema.org/name', object: '"No ACK"', graph: '' },
    ]);

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
  });

  it('publishes tentatively without chain config using a non-zero local publisher address', async () => {
    ({ agent } = await createAgent(new NoChainAdapter()));

    const result = await agent.publish(SYSTEM_PARANETS.ONTOLOGY, [
      { subject: 'urn:test:no-publisher-key', predicate: 'http://schema.org/name', object: '"No key"', graph: '' },
    ]);

    const match = result.ual.match(/^did:dkg:none\/(0x[0-9a-fA-F]{40})\/t/);
    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(match?.[1]).toBeDefined();
    expect(match![1]).not.toBe(ethers.ZeroAddress);
  });
});
