/**
 * `DKGAgent.create` feeds the write-preflight generation from the store its agent works through
 * (OT-RFC-73 S4a): a context graph created through the agent moves the stamp, a probe of another graph
 * keeps its own key, and an agent not built by `create` hands out no identity.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

const agents: DKGAgent[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map((agent) => agent.stop())); });

async function createAgent(): Promise<DKGAgent> {
  const wallet = Wallet.createRandom();
  const chain = new MockChainAdapter('mock:31337', wallet.address);
  chain.setMockACKSigner(wallet);
  const agent = await DKGAgent.create({
    name: 'PreflightIdentity', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge',
    chainAdapter: chain, kaNumberAllocator: makeTestKaNumberAllocator(),
    rfc64CatalogActivation: { enabled: false },
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

describe('the write-preflight identity of a real agent', () => {
  it('moves when a context graph is created through the agent', async () => {
    const agent = await createAgent();
    const caller = Wallet.createRandom().address;
    const before = agent.writePreflightIdentity('identity-cg', caller);
    expect(before).toBeDefined();
    expect(agent.writePreflightIdentity('identity-cg', caller)).toEqual(before);

    await agent.createContextGraph({ id: 'identity-cg', name: 'identity-cg' });

    const after = agent.writePreflightIdentity('identity-cg', caller)!;
    expect(after.key).toBe(before!.key);
    expect(after.stamp).not.toBe(before!.stamp);
    // Another graph is another key.
    expect(agent.writePreflightIdentity('another-cg', caller)!.key).not.toBe(after.key);
  });

  it('moves with a policy write through the store the agent works through, not with a content write', async () => {
    const agent = await createAgent();
    const caller = Wallet.createRandom().address;
    const graph = 'some-cg';
    const stamp = () => agent.writePreflightIdentity(graph, caller)!.stamp;
    const initial = stamp();

    await agent.store.insert([{
      subject: `did:dkg:context-graph:${graph}`, predicate: 'urn:test:content', object: '"x"',
      graph: `${contextGraphDataGraphUri(graph)}/tasks`,
    }]);
    expect(stamp()).toBe(initial);

    await agent.store.insert([{
      subject: `did:dkg:context-graph:${graph}`, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"',
      graph: contextGraphMetaGraphUri(graph),
    }]);
    expect(stamp()).not.toBe(initial);
  });

  it('moves when the participant list of a graph\'s subscription is flipped and put back', async () => {
    const agent = await createAgent();
    const caller = Wallet.createRandom().address;
    const [first, second] = [Wallet.createRandom().address, Wallet.createRandom().address];
    const graph = 'participants-cg';
    const subscribe = (participantAgents: string[]) =>
      agent.setContextGraphSubscription(graph, { subscribed: true, synced: true, participantAgents }, { persist: false });
    subscribe([first]);
    const before = agent.writePreflightIdentity(graph, caller)!.stamp;
    expect(agent.writePreflightIdentity(graph, caller)!.stamp).toBe(before);

    subscribe([first, second]);
    subscribe([first]);

    // The row is equal to what it was; the stamp is not, so a probe that began before cannot be joined.
    expect(agent.getSubscribedContextGraphs().get(graph)?.participantAgents).toEqual([first]);
    expect(agent.writePreflightIdentity(graph, caller)!.stamp).not.toBe(before);
    // Another graph's subscription does not move it.
    const after = agent.writePreflightIdentity(graph, caller)!.stamp;
    agent.setContextGraphSubscription('unrelated-cg', { subscribed: true, synced: true }, { persist: false });
    expect(agent.writePreflightIdentity(graph, caller)!.stamp).toBe(after);
  });

  it('keeps the caller as the probe judges it in the key', async () => {
    const agent = await createAgent();
    const caller = Wallet.createRandom().address;
    expect(agent.writePreflightIdentity('identity-cg', caller.toLowerCase())!.key)
      .toBe(agent.writePreflightIdentity('identity-cg', `did:dkg:agent:${caller}`)!.key);
    expect(agent.writePreflightIdentity('identity-cg', caller)!.key)
      .not.toBe(agent.writePreflightIdentity('identity-cg', null)!.key);
  });

  it('is absent from an agent whose store observer was not built by create', () => {
    const unattached = Object.create(DKGAgent.prototype) as DKGAgent;
    expect(unattached.writePreflightIdentity('identity-cg', null)).toBeUndefined();
  });
});
