/**
 * GH #787 (regression) — `getWorkspaceGossipSigningAgent` must skip a local key
 * record that has a privateKey but NO valid `agentAddress` (a node-level
 * operational identity, not an agent). Such a record can't be a usable gossip
 * signer: `encodeWorkspaceGossipMessage` emits `agentAddress` into the envelope
 * and the host-mode authority check rejects a missing one.
 *
 * The #306/#787 daemon test exercises only the HTTP quad-shape validation, which
 * now short-circuits at the route boundary BEFORE the signer is selected — so it
 * would NOT catch a revert of this guard. This test drives the signer selection
 * directly: a keyless-agent record placed AHEAD of a valid signer must be
 * skipped (no `toLowerCase()`-of-undefined crash, and not chosen as fallback).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../src/index.js';

interface Internals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  getWorkspaceGossipSigningAgent(): (AgentKeyRecord & { privateKey: string }) | null;
  encodeWorkspaceGossipMessage(cg: string, msg: Uint8Array): Promise<Uint8Array>;
}

function keylessAgentRecord(label: string): AgentKeyRecord {
  const rec = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, label);
  // A node-level operational key: has a privateKey but no agent identity.
  delete (rec as { agentAddress?: string }).agentAddress;
  return rec;
}

describe('GH #787 — gossip signer selection skips keyless-agent records', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => { if (agent) { await agent.stop().catch(() => {}); agent = null; } });

  it('keyless record placed FIRST + default match present → returns the valid signer (no throw)', async () => {
    agent = await DKGAgent.create({ name: 'Signer787A', chainAdapter: new MockChainAdapter() });
    const g = agent as unknown as Internals;
    g.localAgents.clear();
    const keyless = keylessAgentRecord('node-op');
    const valid = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'agent');
    g.localAgents.set('node-op-key', keyless); // FIRST — pre-fix this crashed on `.toLowerCase()` of undefined
    g.localAgents.set(valid.agentAddress, valid);
    g.defaultAgentAddress = valid.agentAddress;

    const signer = g.getWorkspaceGossipSigningAgent();
    expect(signer).not.toBeNull();
    expect(signer!.agentAddress).toBe(valid.agentAddress);
    // And signing actually works end to end (a real signed envelope, not a crash
    // or the raw-payload passthrough that happens with no usable signer).
    const env = await g.encodeWorkspaceGossipMessage('cg-787', new TextEncoder().encode('payload'));
    expect(env.length).toBeGreaterThan(64);
  });

  it('keyless record FIRST + NO default match → falls back to the valid signer (skips the keyless one)', async () => {
    agent = await DKGAgent.create({ name: 'Signer787B', chainAdapter: new MockChainAdapter() });
    const g = agent as unknown as Internals;
    g.localAgents.clear();
    g.localAgents.set('node-op-key', keylessAgentRecord('node-op'));
    const valid = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'agent');
    g.localAgents.set(valid.agentAddress, valid);
    g.defaultAgentAddress = undefined; // no default → exercise fallback selection

    const signer = g.getWorkspaceGossipSigningAgent();
    expect(signer?.agentAddress).toBe(valid.agentAddress);
  });

  it('ONLY keyless-agent records → no usable signer (null, no throw)', async () => {
    agent = await DKGAgent.create({ name: 'Signer787C', chainAdapter: new MockChainAdapter() });
    const g = agent as unknown as Internals;
    g.localAgents.clear();
    g.localAgents.set('k1', keylessAgentRecord('k1'));
    g.defaultAgentAddress = undefined;
    expect(g.getWorkspaceGossipSigningAgent()).toBeNull();
  });
});
