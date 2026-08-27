import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  createOperationContext,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKGAgent,
  FANOUT_RESPONSE_REJECTED,
  FANOUT_RESPONSE_RETRYABLE,
} from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

const SELF_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PRIVATE_RETRY_ROSTER = [
  '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw',
  '12D3KooWCV9mkCJkKkyNLvvPNRTsvpGMstN5E4C5jtXUK61S3xan',
  '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb',
  '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu',
  '12D3KooWFq5KMnSMyYr8Z8t8a6Vh1Y6N6KkF5UZjLpCqUkBJsAaa',
  '12D3KooWGiQrwo1jXJsHaQK4kFYx3xVDp5tWHPEnpUUEUbygP4WL',
  '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ',
  '12D3KooWLb1bH9NfMSjJDmsZxufmw5UFD8wajVKnvD5HfL3VbqGq',
  '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh',
  '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a',
] as const;

class CapturingGossip {
  publishes: Array<{ topic: string; bytes: number }> = [];

  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(
    _topic: string,
    _handler: (topic: string, data: Uint8Array, from?: string) => void | Promise<void>,
  ): void {}

  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.publishes.push({ topic, bytes: data.byteLength });
  }

  getSubscribers(_topic: string): string[] {
    return [];
  }
}

function stubMessengerSendReliable(
  results: Map<string, ReliableSendResult> | ((peerId: string) => ReliableSendResult | Error),
): { calls: Array<{ peerId: string; protocolId: string; bytes: number }>; install: (agent: DKGAgent) => void } {
  const calls: Array<{ peerId: string; protocolId: string; bytes: number }> = [];
  const lookup = typeof results === 'function'
    ? results
    : (peerId: string): ReliableSendResult | Error => {
      const result = results.get(peerId);
      return result ?? new Error(`No result configured for peerId=${peerId}`);
    };
  return {
    calls,
    install(agent: DKGAgent): void {
      (agent as unknown as { messenger: object }).messenger = {
        sendReliable: async (
          peerId: string,
          protocolId: string,
          payload: Uint8Array,
        ): Promise<ReliableSendResult> => {
          calls.push({ peerId, protocolId, bytes: payload.byteLength });
          const result = lookup(peerId);
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  };
}

async function createAgent(name: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `${name}-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
  });
  Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
    value: SELF_PEER,
    configurable: true,
  });
  return agent;
}

async function seedVerifiedPrivateAgentRoster(
  agent: DKGAgent,
  contextGraphId: string,
  peerId: string,
): Promise<string> {
  const wallet = ethers.Wallet.createRandom();
  const recipientId = `did:dkg:agent:${ethers.getAddress(wallet.address)}`;
  const key = generateWorkspaceRecipientEncryptionKey(
    recipientId,
    `${recipientId}#fanout-integration-x25519`,
  );
  const publicKeyBytes = key.publicKeyBytes!;
  const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: wallet.address,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const proof = wallet.signingKey.sign(ethers.hashMessage(proofPayload)).serialized;

  await agent.store.insert([
    {
      subject: contextGraphDataUri(contextGraphId),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${ethers.getAddress(wallet.address)}"`,
      graph: contextGraphMetaUri(contextGraphId),
    },
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
      object: `"${encodeWorkspaceEncryptionKey(publicKeyBytes)}"`,
      graph: 'did:dkg:system/agents',
    },
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
      object: `"${WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
      graph: 'did:dkg:system/agents',
    },
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
      object: `"${proof}"`,
      graph: 'did:dkg:system/agents',
    },
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: `"${peerId}"`,
      graph: 'did:dkg:system/agents',
    },
  ]);
  return recipientId;
}

describe('DKGAgent private SWM agent-roster fan-out', () => {
  it('sends private SWM reliably to authorized agent peers with gossip off', async () => {
    const agent = await createAgent('PrivateAgentRosterFanout');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const receiverPeerId = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
    const { calls, install } = stubMessengerSendReliable(new Map([
      [receiverPeerId, {
        delivered: true,
        response: new Uint8Array(),
        attempts: 1,
        messageId: 'private-agent-roster-delivered',
      }],
    ]));
    install(agent);
    await seedVerifiedPrivateAgentRoster(agent, 'cg-private-agent-roster', receiverPeerId);

    const encryptedBody = new Uint8Array(180_000).fill(0xa5);
    await agent.publishWorkspaceGossip(
      'cg-private-agent-roster',
      { mode: 'plaintext', message: encryptedBody },
      createOperationContext('share'),
      null,
    );
    await agent.awaitInFlightSubstrateFanOuts();

    expect(calls).toEqual([{
      peerId: receiverPeerId,
      protocolId: '/dkg/10.0.1/swm-update',
      bytes: encryptedBody.byteLength,
    }]);
    expect(gossip.publishes).toEqual([]);
    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({
      'cg-private-agent-roster': 1,
    });
  });

  it('refreshes the production private roster immediately after a real profile write', async () => {
    const agent = await createAgent('PrivateAgentRosterRefresh');
    const contextGraphId = 'cg-private-agent-roster-refresh';
    const oldPeerId = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
    const newPeerId = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const recipientId = await seedVerifiedPrivateAgentRoster(agent, contextGraphId, oldPeerId);
    const internals = agent as unknown as {
      store: TripleStore;
      getOrCreateCGMemberEnumerator(): { enumerate: (cgId: string) => Promise<unknown> };
    };

    await expect(internals.getOrCreateCGMemberEnumerator().enumerate(contextGraphId)).resolves.toEqual({
      source: 'agent-roster', members: [oldPeerId], complete: true,
    });
    await internals.store.deleteByPattern({
      graph: 'did:dkg:system/agents', subject: recipientId, predicate: DKG_ONTOLOGY.DKG_PEER_ID,
    });
    await internals.store.insert([{
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: `"${newPeerId}"`,
      graph: 'did:dkg:system/agents',
    }]);
    await expect(internals.getOrCreateCGMemberEnumerator().enumerate(contextGraphId)).resolves.toEqual({
      source: 'agent-roster', members: [newPeerId], complete: true,
    });

    await internals.store.deleteByPattern({
      graph: 'did:dkg:system/agents', subject: recipientId, predicate: DKG_ONTOLOGY.DKG_PEER_ID,
    });
    await internals.store.insert([{
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: '"not-a-peer-id"',
      graph: 'did:dkg:system/agents',
    }]);
    await expect(internals.getOrCreateCGMemberEnumerator().enumerate(contextGraphId)).resolves.toEqual({
      source: 'agent-roster', members: [], complete: false,
    });
  });

  it('uses the exact encrypted-operation recipient snapshot without resolving membership twice', async () => {
    const agent = await createAgent('PrivateSnapshotFanout');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const receiverPeerId = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
    const { calls, install } = stubMessengerSendReliable(new Map([
      [receiverPeerId, {
        delivered: true,
        response: new Uint8Array(),
        attempts: 1,
        messageId: 'private-snapshot-delivered',
      }],
    ]));
    install(agent);
    const internals = agent as unknown as {
      getOrCreateCGMemberEnumerator(): { enumerate: (cgId: string) => Promise<unknown> };
    };
    internals.getOrCreateCGMemberEnumerator().enumerate = async () => {
      throw new Error('recipient membership must not be resolved twice');
    };

    const encryptedBody = new Uint8Array(2_048).fill(0x5a);
    await agent.publishWorkspaceGossip(
      'cg-private-operation-snapshot',
      {
        mode: 'agent-encrypted',
        message: encryptedBody,
        fanoutSnapshot: { source: 'agent-roster', members: [receiverPeerId], complete: true },
      },
      createOperationContext('share'),
      null,
    );
    await agent.awaitInFlightSubstrateFanOuts();

    expect(calls).toEqual([{
      peerId: receiverPeerId,
      protocolId: '/dkg/10.0.1/swm-update',
      bytes: encryptedBody.byteLength,
    }]);
    expect(gossip.publishes).toEqual([]);
  });

  it('keeps a substrate-only retry alive after nine of ten peers deliver', async () => {
    const agent = await createAgent('PrivateSnapshotRetryable');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const retryPeerId = PRIVATE_RETRY_ROSTER[PRIVATE_RETRY_ROSTER.length - 1];
    (agent as unknown as { isPeerDialable: (peerId: string) => Promise<boolean> })
      .isPeerDialable = async (_peerId: string) => true;

    const sentPayloads = new Map<string, Uint8Array[]>();
    (agent as unknown as { messenger: object }).messenger = {
      sendReliable: async (peerId: string, _protocolId: string, payload: Uint8Array) => {
        const attempts = sentPayloads.get(peerId) ?? [];
        attempts.push(payload.slice());
        sentPayloads.set(peerId, attempts);
        return {
          delivered: true,
          response: peerId === retryPeerId && attempts.length === 1
            ? FANOUT_RESPONSE_RETRYABLE
            : new Uint8Array(),
          attempts: 1,
          messageId: `private-retry-${peerId}-${attempts.length}`,
        };
      },
    };

    const shareOperationId = 'private-substrate-only-retry';
    await agent.publishWorkspaceGossip(
      'cg-private-retryable-snapshot',
      {
        mode: 'agent-encrypted',
        message: new Uint8Array(2_048).fill(0x4d),
        fanoutSnapshot: {
          source: 'agent-roster',
          members: PRIVATE_RETRY_ROSTER,
          complete: true,
        },
      },
      createOperationContext('share', shareOperationId),
      null,
      shareOperationId,
    );
    await agent.awaitInFlightSubstrateFanOuts();
    expect([...sentPayloads.values()].flat()).toHaveLength(PRIVATE_RETRY_ROSTER.length);
    expect(agent.getSwmAckQuorumStats()).toMatchObject({ tracked: 1, completed: 0, pending: 1 });

    (agent as unknown as {
      getOrCreateSwmAckQuorum: () => { tick: (nowMs?: number) => void };
    }).getOrCreateSwmAckQuorum().tick(Date.now() + 30_001);
    for (let i = 0; i < 20 && sentPayloads.get(retryPeerId)?.length !== 2; i += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }

    expect(sentPayloads.get(retryPeerId)).toHaveLength(2);
    expect(sentPayloads.get(retryPeerId)?.[1]).toEqual(sentPayloads.get(retryPeerId)?.[0]);
    for (const peerId of PRIVATE_RETRY_ROSTER.slice(0, -1)) {
      expect(sentPayloads.get(peerId)).toHaveLength(1);
    }
    expect(agent.getSwmAckQuorumStats()).toMatchObject({ tracked: 1, completed: 1, pending: 0 });
    expect(gossip.publishes).toEqual([]);
  });

  it('drops a terminal substrate-only rejection and never retries it', async () => {
    const agent = await createAgent('PrivateSnapshotTerminal');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const deliveredPeerId = PRIVATE_RETRY_ROSTER[0];
    const rejectedPeerId = PRIVATE_RETRY_ROSTER[1];
    const calls: string[] = [];
    (agent as unknown as { messenger: object }).messenger = {
      sendReliable: async (peerId: string) => {
        calls.push(peerId);
        return {
          delivered: true,
          response: peerId === rejectedPeerId ? FANOUT_RESPONSE_REJECTED : new Uint8Array(),
          attempts: 1,
          messageId: `private-terminal-${peerId}`,
        };
      },
    };

    const shareOperationId = 'private-substrate-only-terminal';
    await agent.publishWorkspaceGossip(
      'cg-private-terminal-snapshot',
      {
        mode: 'agent-encrypted',
        message: new Uint8Array(512).fill(0x5e),
        fanoutSnapshot: {
          source: 'agent-roster',
          members: [deliveredPeerId, rejectedPeerId],
          complete: true,
        },
      },
      createOperationContext('share', shareOperationId),
      null,
      shareOperationId,
    );
    await agent.awaitInFlightSubstrateFanOuts();
    expect(calls.sort()).toEqual([deliveredPeerId, rejectedPeerId].sort());
    expect(agent.getSwmAckQuorumStats()).toMatchObject({ tracked: 1, completed: 1, pending: 0 });

    (agent as unknown as {
      getOrCreateSwmAckQuorum: () => { tick: (nowMs?: number) => void };
    }).getOrCreateSwmAckQuorum().tick(Date.now() + 30_001);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(calls.sort()).toEqual([deliveredPeerId, rejectedPeerId].sort());
    expect(gossip.publishes).toEqual([]);
  });

  it('keeps the deprecated raw-byte call on enumerator-based fan-out', async () => {
    const agent = await createAgent('LegacyRawWorkspaceGossip');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const receiverPeerId = PRIVATE_RETRY_ROSTER[0];
    const { calls, install } = stubMessengerSendReliable(new Map([
      [receiverPeerId, {
        delivered: true,
        response: new Uint8Array(),
        attempts: 1,
        messageId: 'legacy-raw-delivered',
      }],
    ]));
    install(agent);
    const internals = agent as unknown as {
      getOrCreateCGMemberEnumerator(): { enumerate: (cgId: string) => Promise<unknown> };
    };
    internals.getOrCreateCGMemberEnumerator().enumerate = async () => ({
      source: 'agent-roster',
      members: [receiverPeerId],
      complete: true,
    });

    const rawMessage = new Uint8Array(256).fill(0x2a);
    await agent.publishWorkspaceGossip(
      'cg-legacy-raw-workspace-gossip',
      rawMessage,
      createOperationContext('share'),
      null,
    );
    await agent.awaitInFlightSubstrateFanOuts();

    expect(calls).toEqual([{
      peerId: receiverPeerId,
      protocolId: '/dkg/10.0.1/swm-update',
      bytes: rawMessage.byteLength,
    }]);
    expect(gossip.publishes).toEqual([]);
  });

  it('rejects encrypted payloads missing their fan-out snapshot before transport', async () => {
    const agent = await createAgent('PrivateSnapshotRequired');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const { calls, install } = stubMessengerSendReliable(() => ({
      delivered: true,
      response: new Uint8Array(),
      attempts: 1,
      messageId: 'must-not-send',
    }));
    install(agent);

    await expect((agent.publishWorkspaceGossip as any)(
      'cg-private-missing-operation-snapshot',
      { mode: 'agent-encrypted', message: new Uint8Array(128).fill(0x7c) },
      createOperationContext('share'),
      null,
    )).rejects.toThrow(/requires a complete encoded payload/);
    expect(calls).toEqual([]);
    expect(gossip.publishes).toEqual([]);
  });

  it('uses reliable delivery and gossip together for an incomplete roster', async () => {
    const agent = await createAgent('PrivateMixedSnapshotFanout');
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const knownPeerId = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';
    const { calls, install } = stubMessengerSendReliable(new Map([
      [knownPeerId, {
        delivered: true,
        response: new Uint8Array(),
        attempts: 1,
        messageId: 'private-mixed-delivered',
      }],
    ]));
    install(agent);

    const encryptedBody = new Uint8Array(2_048).fill(0x6b);
    await agent.publishWorkspaceGossip(
      'cg-private-mixed-operation-snapshot',
      {
        mode: 'agent-encrypted',
        message: encryptedBody,
        fanoutSnapshot: { source: 'agent-roster', members: [knownPeerId], complete: false },
      },
      createOperationContext('share'),
      null,
    );
    await agent.awaitInFlightSubstrateFanOuts();

    expect(calls).toEqual([{
      peerId: knownPeerId,
      protocolId: '/dkg/10.0.1/swm-update',
      bytes: encryptedBody.byteLength,
    }]);
    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.bytes).toBe(encryptedBody.byteLength);
  });
});
