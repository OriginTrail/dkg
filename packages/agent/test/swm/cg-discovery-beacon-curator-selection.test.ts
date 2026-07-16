/**
 * Codex review on PR #916 (commit `a15f25d`) — multi-agent curator
 * selection regression.
 *
 * Bug: `getWorkspaceGossipSigningAgent()` picked the default/first
 * local agent regardless of which agent actually created the CG via
 * `createContextGraph(opts.callerAgentAddress)`. On multi-agent
 * nodes the beacon was therefore signed by the wrong agent and the
 * pre-registration host-catchup path authorized only the
 * beacon-pinned curator, so envelopes from the real creating agent
 * were rejected until chain metadata caught up.
 *
 * Fix: thread `callerAgentAddress` from `createContextGraph` into
 * `registerCgForBeaconAnnouncement` and prefer the matching local
 * agent over the workspace default. When the caller pinned an
 * agent that isn't actually a local custodial agent, drop the
 * registration entirely (silently pinning a different agent would
 * misalign beacon vs. catchup signers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../../src/index.js';
import { BEACON_ACCESS_POLICY_CURATED } from '../../src/swm/cg-discovery-beacon.js';

class InMemoryGossipBus {
  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(_topic: string, _handler: unknown): void {}
  offMessage(_topic: string, _handler: unknown): void {}
  async publish(_topic: string, _data: Uint8Array, _from?: string): Promise<void> {}
  getSubscribers(_topic: string): string[] { return []; }
}

interface AgentInternals {
  gossip: InMemoryGossipBus;
  beaconRegistry: Map<string, {
    wireId: string;
    curatorEoa: string;
    signerPrivateKey?: string;
    accessPolicy: number;
  }>;
  registerCgForBeaconAnnouncement(
    localCgId: string,
    accessPolicy: number,
    curatorAgentAddress?: string,
  ): Promise<void>;
}

describe('beacon registration — multi-agent curator selection (PR #916)', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
  });

  it('uses the caller-pinned local agent over the workspace default', async () => {
    const node = await DKGAgent.create({ name: 'MultiAgentCurator', listenHost: '127.0.0.1' });
    agents.push(node);
    (node as unknown as AgentInternals).gossip = new InMemoryGossipBus();

    // Register two custodial agents; the FIRST one becomes the
    // default (matches `defaultAgentAddress`). The SECOND one is
    // the actual curator the test pins via `callerAgentAddress`.
    const defaultAgent = await node.registerAgent('default-agent');
    const curatorAgent = await node.registerAgent('curator-agent');
    expect(defaultAgent.agentAddress).not.toEqual(curatorAgent.agentAddress);

    const cgId = 'multi-agent-curator-cg';
    const expectedWireId = ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();

    await (node as unknown as AgentInternals).registerCgForBeaconAnnouncement(
      cgId,
      BEACON_ACCESS_POLICY_CURATED,
      curatorAgent.agentAddress,
    );

    const entry = (node as unknown as AgentInternals).beaconRegistry.get(cgId);
    expect(entry).toBeDefined();
    expect(entry?.wireId).toBe(expectedWireId);
    expect(entry?.curatorEoa).toBe(curatorAgent.agentAddress.toLowerCase());
    // The signer private key MUST be the curator's, not the default's,
    // so the host-catchup path (which recovers the EOA from the
    // signature) authorizes the same identity the beacon pinned.
    expect(entry?.signerPrivateKey).toBe(curatorAgent.privateKey);
    expect(entry?.signerPrivateKey).not.toBe(defaultAgent.privateKey);
  });

  it('falls back to the workspace default when no curator is pinned', async () => {
    const node = await DKGAgent.create({ name: 'NoPinFallback', listenHost: '127.0.0.1' });
    agents.push(node);
    (node as unknown as AgentInternals).gossip = new InMemoryGossipBus();

    const defaultAgent = await node.registerAgent('default-agent');
    await node.registerAgent('secondary-agent');

    const cgId = 'no-pin-fallback-cg';
    await (node as unknown as AgentInternals).registerCgForBeaconAnnouncement(
      cgId,
      BEACON_ACCESS_POLICY_CURATED,
    );

    const entry = (node as unknown as AgentInternals).beaconRegistry.get(cgId);
    expect(entry).toBeDefined();
    expect(entry?.curatorEoa).toBe(defaultAgent.agentAddress.toLowerCase());
    expect(entry?.signerPrivateKey).toBe(defaultAgent.privateKey);
  });

  it('skips registration when the caller pinned an agent with no local signer', async () => {
    const node = await DKGAgent.create({ name: 'UnknownCuratorSkip', listenHost: '127.0.0.1' });
    agents.push(node);
    (node as unknown as AgentInternals).gossip = new InMemoryGossipBus();

    await node.registerAgent('default-agent');
    const stranger = ethers.Wallet.createRandom();

    const cgId = 'unknown-curator-cg';
    await (node as unknown as AgentInternals).registerCgForBeaconAnnouncement(
      cgId,
      BEACON_ACCESS_POLICY_CURATED,
      stranger.address,
    );

    // Better to skip than to silently pin the default agent's EOA
    // here: that would cause the host-catchup verification to deny
    // every envelope the actual curator (who is off-node) signs.
    expect((node as unknown as AgentInternals).beaconRegistry.has(cgId)).toBe(false);
  });
});
