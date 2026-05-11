import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  DKG_ONTOLOGY,
  contextGraphWorkspaceTopic,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../src/index.js';

const LOCAL_PEER_ID = '12D3KooWAgentGateLocal';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  canReadContextGraph(contextGraphId: string): Promise<boolean>;
  canUseSharedMemoryForContextGraph(
    contextGraphId: string,
    opts?: { callerAgentAddress?: string },
  ): Promise<boolean>;
  reconcileSharedMemoryGossipSubscription(contextGraphId: string): Promise<void>;
}

class FakeGossip {
  readonly subscribed = new Set<string>();

  subscribe(topic: string): void {
    this.subscribed.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscribed.delete(topic);
  }

  onMessage(): void {}

  async publish(): Promise<void> {}
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function createAgent(): Promise<{ agent: DKGAgent; internals: DKGAgentInternals; gossip: FakeGossip }> {
  const agent = await DKGAgent.create({
    name: `SwmAgentGateAccess-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
  });
  const gossip = new FakeGossip();
  Object.defineProperty(agent, 'peerId', { value: LOCAL_PEER_ID, configurable: true });
  (agent as unknown as { gossip: FakeGossip }).gossip = gossip;
  return { agent, internals: agent as unknown as DKGAgentInternals, gossip };
}

async function insertAccessMeta(
  agent: DKGAgent,
  contextGraphId: string,
  options: {
    accessPolicy?: 'private' | 'public';
    allowedPeers?: string[];
    agentGatePredicate?: string;
    agentAddress?: string;
  },
): Promise<void> {
  const contextGraphUri = contextGraphDataUri(contextGraphId);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const quads = [
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: metaGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: `"${options.accessPolicy ?? 'private'}"`,
      graph: metaGraph,
    },
  ];

  for (const peerId of options.allowedPeers ?? []) {
    quads.push({
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${peerId}"`,
      graph: metaGraph,
    });
  }

  if (options.agentGatePredicate && options.agentAddress) {
    quads.push({
      subject: contextGraphUri,
      predicate: options.agentGatePredicate,
      object: `"${options.agentAddress}"`,
      graph: metaGraph,
    });
  }

  await agent.store.insert(quads);
}

async function insertOntologyContextGraph(agent: DKGAgent, contextGraphId: string): Promise<void> {
  await agent.store.insert([{
    subject: contextGraphDataUri(contextGraphId),
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
    graph: contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
  }]);
}

async function insertSharedMemorySecret(agent: DKGAgent, contextGraphId: string, value: string): Promise<string> {
  const subject = `urn:test:${contextGraphId}:root:secret`;
  await agent.store.insert([{
    subject,
    predicate: 'https://schema.org/name',
    object: `"${value}"`,
    graph: contextGraphSharedMemoryUri(contextGraphId),
  }]);
  return subject;
}

async function querySharedMemoryName(
  agent: DKGAgent,
  contextGraphId: string,
  subject: string,
  opts: { callerAgentAddress?: string } = {},
) {
  return agent.query(
    `SELECT ?name WHERE { <${subject}> <https://schema.org/name> ?name }`,
    { contextGraphId, view: 'shared-working-memory', ...opts },
  );
}

describe('DKGAgent SWM agent-gate access', () => {
  it('does not subscribe to the SWM topic before context graph metadata is confirmed', async () => {
    const { agent, gossip } = await createAgent();
    const contextGraphId = 'swm-agent-unknown';

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(false);
  });

  it('does not subscribe to SWM for explicit private context graphs without an enforceable allowlist', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'swm-private-no-allowlist';
    await insertAccessMeta(agent, contextGraphId, {
      accessPolicy: 'private',
    });
    const subject = await insertSharedMemorySecret(agent, contextGraphId, 'NoAllowlistSecret');

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(await internals.canReadContextGraph(contextGraphId)).toBe(true);
    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId)).toBe(false);
    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(false);
    const result = await querySharedMemoryName(agent, contextGraphId, subject);
    expect(result.bindings).toHaveLength(0);
  });

  it('subscribes to SWM for ontology-confirmed open context graphs without local _meta', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'swm-open-ontology-only';
    await insertOntologyContextGraph(agent, contextGraphId);

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(await internals.canReadContextGraph(contextGraphId)).toBe(true);
    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId)).toBe(true);
    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(true);
  });

  it('preserves peer-only SWM access for a DKG_ALLOWED_PEER context graph', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'swm-peer-invite-read';
    await insertAccessMeta(agent, contextGraphId, {
      allowedPeers: [agent.peerId],
    });
    const subject = await insertSharedMemorySecret(agent, contextGraphId, 'PeerInviteSecret');

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(await internals.canReadContextGraph(contextGraphId)).toBe(true);
    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId)).toBe(true);
    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(true);
    const result = await querySharedMemoryName(agent, contextGraphId, subject);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.['name']).toBe('"PeerInviteSecret"');
  });

  it('scopes SWM queries to the authenticated caller agent on multi-agent nodes', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'swm-agent-caller-scope';
    const allowedWallet = ethers.Wallet.createRandom();
    const deniedWallet = ethers.Wallet.createRandom();
    const allowedRecord = agentFromPrivateKey(allowedWallet.privateKey, 'allowed');
    const deniedRecord = agentFromPrivateKey(deniedWallet.privateKey, 'denied');
    internals.localAgents.set(allowedRecord.agentAddress, allowedRecord);
    internals.localAgents.set(deniedRecord.agentAddress, deniedRecord);
    internals.defaultAgentAddress = allowedRecord.agentAddress;
    await insertAccessMeta(agent, contextGraphId, {
      agentGatePredicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      agentAddress: allowedRecord.agentAddress,
    });
    const subject = await insertSharedMemorySecret(agent, contextGraphId, 'CallerScopeSecret');

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(true);
    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId, {
      callerAgentAddress: deniedRecord.agentAddress,
    })).toBe(false);
    const deniedResult = await querySharedMemoryName(agent, contextGraphId, subject, {
      callerAgentAddress: deniedRecord.agentAddress,
    });
    expect(deniedResult.bindings).toHaveLength(0);
    const allowedResult = await querySharedMemoryName(agent, contextGraphId, subject, {
      callerAgentAddress: allowedRecord.agentAddress,
    });
    expect(allowedResult.bindings).toHaveLength(1);
    expect(allowedResult.bindings[0]?.['name']).toBe('"CallerScopeSecret"');
  });

  it('unsubscribes from SWM when the local agent loses its allowlist entry', async () => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = 'swm-agent-revoked';
    const allowedWallet = ethers.Wallet.createRandom();
    const allowedRecord = agentFromPrivateKey(allowedWallet.privateKey, 'allowed');
    internals.localAgents.set(allowedRecord.agentAddress, allowedRecord);
    internals.defaultAgentAddress = allowedRecord.agentAddress;
    await insertAccessMeta(agent, contextGraphId, {
      agentGatePredicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      agentAddress: allowedRecord.agentAddress,
    });

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(true);

    await agent.store.deleteByPattern({
      graph: contextGraphMetaUri(contextGraphId),
      subject: contextGraphDataUri(contextGraphId),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${allowedRecord.agentAddress}"`,
    });
    await internals.reconcileSharedMemoryGossipSubscription(contextGraphId);

    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId)).toBe(false);
    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(false);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('denies peer-allowed/no-agent SWM receive, sync, and query for %s', async (_label, predicate) => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = `swm-agent-deny-${_label.toLowerCase()}`;
    const allowed = ethers.Wallet.createRandom();
    await insertAccessMeta(agent, contextGraphId, {
      allowedPeers: [agent.peerId],
      agentGatePredicate: predicate,
      agentAddress: allowed.address,
    });
    const subject = await insertSharedMemorySecret(agent, contextGraphId, `${_label}Secret`);

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(await internals.canReadContextGraph(contextGraphId)).toBe(false);
    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId)).toBe(false);
    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(false);
    await expect(agent.syncSharedMemoryFromPeer('12D3KooWAgentGateRemote', [contextGraphId])).resolves.toBe(0);
    const result = await querySharedMemoryName(agent, contextGraphId, subject);
    expect(result.bindings).toHaveLength(0);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('allows SWM read/query only when DKG_ALLOWED_PEER and %s both pass', async (_label, predicate) => {
    const { agent, internals, gossip } = await createAgent();
    const contextGraphId = `swm-agent-allow-${_label.toLowerCase()}`;
    const allowedWallet = ethers.Wallet.createRandom();
    const allowedRecord = agentFromPrivateKey(allowedWallet.privateKey, 'allowed');
    internals.localAgents.set(allowedRecord.agentAddress, allowedRecord);
    internals.defaultAgentAddress = allowedRecord.agentAddress;
    await insertAccessMeta(agent, contextGraphId, {
      allowedPeers: [agent.peerId],
      agentGatePredicate: predicate,
      agentAddress: allowedRecord.agentAddress,
    });
    const subject = await insertSharedMemorySecret(agent, contextGraphId, `${_label}Secret`);

    agent.subscribeToContextGraph(contextGraphId);
    await flushAsync();

    expect(await internals.canReadContextGraph(contextGraphId)).toBe(true);
    expect(await internals.canUseSharedMemoryForContextGraph(contextGraphId)).toBe(true);
    expect(gossip.subscribed.has(contextGraphWorkspaceTopic(contextGraphId))).toBe(true);
    const result = await querySharedMemoryName(agent, contextGraphId, subject);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.['name']).toBe(`"${_label}Secret"`);
  });
});
