import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  computeGossipSigningPayload,
  decodeGossipEnvelope,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_ENVELOPE_VERSION,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../src/index.js';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  encodeWorkspaceGossipMessage(contextGraphId: string, message: Uint8Array): Promise<Uint8Array>;
}

describe('DKGAgent SWM gossip signing', () => {
  it('wraps open-graph SWM gossip with a local agent key even when the default cannot sign', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmFallbackSigner',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as DKGAgentInternals;

    const defaultRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'default');
    delete defaultRecord.privateKey;
    const fallbackRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'fallback');

    internals.localAgents.set(defaultRecord.agentAddress, defaultRecord);
    internals.localAgents.set(fallbackRecord.agentAddress, fallbackRecord);
    internals.defaultAgentAddress = defaultRecord.agentAddress;

    const contextGraphId = 'open-swm-cg';
    const payload = new TextEncoder().encode('raw shared-memory payload');
    const wireMessage = await internals.encodeWorkspaceGossipMessage(contextGraphId, payload);
    const envelope = decodeGossipEnvelope(wireMessage);

    expect(envelope.version).toBe(GOSSIP_ENVELOPE_VERSION);
    expect(envelope.type).toBe(GOSSIP_TYPE_WORKSPACE_PUBLISH);
    expect(envelope.contextGraphId).toBe(contextGraphId);
    expect(envelope.agentAddress).toBe(fallbackRecord.agentAddress);
    expect(Array.from(envelope.payload)).toEqual(Array.from(payload));

    const recovered = ethers.verifyMessage(
      computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, envelope.payload),
      ethers.hexlify(envelope.signature),
    );
    expect(recovered).toBe(fallbackRecord.agentAddress);
  });
});
