// SPDX-License-Identifier: Apache-2.0

/**
 * A wallet that moves to a new node, over real libp2p gossip and real sync:
 * a second run of the same agent wallet must replace the first in another
 * node's phonebook, without leaving the dead peer listed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { agentFromPrivateKey, DKGAgent, type AgentKeyRecord } from '../src/index.js';

interface AgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
}

async function startAgent(name: string, privateKey?: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    listenPort: 0,
    skills: [],
    chainAdapter: new MockChainAdapter(),
  });
  if (privateKey !== undefined) {
    const record = agentFromPrivateKey(privateKey, name);
    const internals = agent as unknown as AgentInternals;
    internals.localAgents.set(record.agentAddress, record);
    internals.defaultAgentAddress = record.agentAddress;
  }
  await agent.start();
  return agent;
}

describe('an agent wallet that moves to a new node', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('is listed at the new peer only, once the new run\'s gossiped profile arrives', async () => {
    const wallet = ethers.Wallet.createRandom();
    const observer = await startAgent('Observer');
    agents.push(observer);

    const firstRun = await startAgent('FirstRun', wallet.privateKey);
    agents.push(firstRun);
    await firstRun.connectTo(observer.multiaddrs[0]!);
    const peersOfWallet = async () => (
      await observer.discovery.findAgentPeerPageByAddress(wallet.address, { limit: 8 })
    ).peerIds;
    await vi.waitFor(async () => {
      await firstRun.publishProfile();
      expect(await peersOfWallet()).toEqual([firstRun.peerId]);
    }, { timeout: 20_000, interval: 500 });

    await firstRun.stop();

    const secondRun = await startAgent('SecondRun', wallet.privateKey);
    agents.push(secondRun);
    await secondRun.connectTo(observer.multiaddrs[0]!);
    await vi.waitFor(async () => {
      await secondRun.publishProfile();
      expect(await peersOfWallet()).toEqual([secondRun.peerId]);
    }, { timeout: 20_000, interval: 500 });
    await expect(observer.discovery.findCurrentAgentPeerIds(wallet.address, { limit: 8 })).resolves.toEqual([secondRun.peerId]);
  }, 60_000);
});
