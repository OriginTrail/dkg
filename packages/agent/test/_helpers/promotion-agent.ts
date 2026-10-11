import { vi } from 'vitest';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../src/dkg-agent.js';

/** A "process" over a durable store: fresh in-memory agent + publisher objects. */
export async function createPromotionAgentForTest(
  store: TripleStore,
  { agentAddress, peerId }: { agentAddress: string; peerId: string },
) {
  const publisher = new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.defaultAgentAddress = agentAddress;
  agent.node = { peerId: { toString: () => peerId } };
  agent.store = store;
  agent.publisher = publisher;
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.prepareAtomicAssertionShare = async () => undefined;
  agent.buildCuratorAckConfirmer = async () => undefined;
  agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
  agent.resolveWorkspaceRecipientsGated = async () => ({ requiresEncryption: false, recipients: [] });
  agent.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0 });
  agent.publishWorkspaceGossip = vi.fn(async () => undefined);
  agent.scheduleRfc64SwmInventoryObserverV1 = vi.fn();
  return { agent, publisher };
}

