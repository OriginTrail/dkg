import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  PROTOCOL_SWM_SENDER_KEY,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  contextGraphDataUri,
  contextGraphMetaUri,
  decodeSwmSenderKeyMessage,
  decodeSwmSenderKeyPackage,
  decryptSwmSenderKeyMessage,
  decryptSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  generateWorkspaceRecipientEncryptionKey,
  ratchetSwmSenderChainKey,
  uint64ForProto,
  type OperationContext,
  type SwmSenderKeyMessageMsg,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  type AgentKeyRecord,
} from '../src/index.js';
import {
  deserializeSwmSenderSendState,
  serializeSwmSenderSendState,
  swmSenderStateKey,
} from '../src/dkg-agent-swm-state.js';
import type { LocalSwmSenderKeySendState } from '../src/dkg-agent-types.js';
import type { WorkspaceAgentRecipient } from '@origintrail-official/dkg-publisher';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

// A node shares several assets into one private context graph at the same
// moment whenever publications are queued. Each share is one Sender Key
// message: a message index and the chain key of that index. A recipient
// follows the chain from the epoch's first key, so the two must advance
// together on the sender.

const SELF_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const REMOTE_PEER = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const CTX: OperationContext = { operationId: 'overlapping-shares', operationName: 'share' };

interface SenderKeyInternals {
  node: { peerId: { toString(): string } };
  messenger: {
    sendReliable(
      peerId: string,
      protocolId: string,
      payload: Uint8Array,
      options?: { messageId?: string },
    ): Promise<ReliableSendResult>;
  };
  swmSenderKeyStateLoaded: boolean;
  swmSenderKeySendStates: Map<string, LocalSwmSenderKeySendState>;
  defaultAgentAddress?: string;
  getLocalWorkspaceRecipientPrivateKeys(options?: {
    activeOnly?: boolean;
  }): WorkspaceRecipientEncryptionKey[];
  encryptWorkspacePayloadWithSenderKey(input: {
    contextGraphId: string;
    plaintext: Uint8Array;
    senderAgentAddress: string;
    operationId: string;
    shareOperationId: string;
    timestampMs: number;
    publisherPeerId: string;
    resolution: {
      requiresEncryption: true;
      recipients: readonly [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]];
    };
  }): Promise<Uint8Array>;
  decryptWorkspacePayloadWithSenderKey(
    message: SwmSenderKeyMessageMsg,
    contextGraphId: string,
    ctx: OperationContext,
  ): Promise<Uint8Array>;
}

function recipientFromKey(
  agentAddress: string,
  key: WorkspaceRecipientEncryptionKey,
  peerId: string,
): WorkspaceAgentRecipient {
  return {
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    recipientId: key.recipientId,
    recipientKeyId: key.recipientKeyId,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: key.publicKeyBytes,
    agentAddress: ethers.getAddress(agentAddress),
    peerId,
  };
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('SWM Sender Key: shares that overlap', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  /** A sender node, one remote member, and the setup packages that member was sent. */
  async function senderWithOneMember(name: string) {
    agent = await DKGAgent.create({ name, chainAdapter: new MockChainAdapter() });
    const internals = agent as unknown as SenderKeyInternals;
    Object.defineProperty(internals.node, 'peerId', {
      value: { toString: () => SELF_PEER },
      configurable: true,
    });
    internals.swmSenderKeyStateLoaded = true;

    const sender = await agent.registerAgent(`${name}-sender`) as AgentKeyRecord;
    internals.defaultAgentAddress = sender.agentAddress;
    const localKey = internals.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true })
      .find((key) => key.recipientId.toLowerCase() === `did:dkg:agent:${sender.agentAddress}`.toLowerCase());
    if (!localKey) throw new Error('missing local workspace recipient key');

    const memberWallet = ethers.Wallet.createRandom();
    const memberId = `did:dkg:agent:${memberWallet.address}`;
    const memberKey = generateWorkspaceRecipientEncryptionKey(memberId, `${memberId}#overlap-key`);
    const recipients: [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]] = [
      recipientFromKey(sender.agentAddress, localKey, SELF_PEER),
      recipientFromKey(memberWallet.address, memberKey, REMOTE_PEER),
    ];
    const contextGraphId = `test-cg/${name}`;
    for (const address of [sender.agentAddress, memberWallet.address]) {
      await agent.store.insert([{
        subject: contextGraphDataUri(contextGraphId),
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${ethers.getAddress(address)}"`,
        graph: contextGraphMetaUri(contextGraphId),
      }]);
    }

    const setupsSentToMember: Uint8Array[] = [];
    internals.messenger = {
      sendReliable: async (peerId, protocolId, payload): Promise<ReliableSendResult> => {
        expect(protocolId).toBe(PROTOCOL_SWM_SENDER_KEY);
        expect(peerId).toBe(REMOTE_PEER);
        setupsSentToMember.push(Uint8Array.from(payload));
        return {
          delivered: true,
          response: encodeSwmSenderKeyPackageAck({
            version: SWM_SENDER_KEY_PACKAGE_VERSION,
            type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
            accepted: true,
          }),
          attempts: 1,
          messageId: `setup-${setupsSentToMember.length}`,
        };
      },
    };

    const share = async (plaintext: string): Promise<SwmSenderKeyMessageMsg> => decodeSwmSenderKeyMessage(
      await internals.encryptWorkspacePayloadWithSenderKey({
        contextGraphId,
        plaintext: new TextEncoder().encode(plaintext),
        senderAgentAddress: sender.agentAddress,
        operationId: `overlap-${plaintext}`,
        shareOperationId: `overlap-${plaintext}`,
        timestampMs: Date.now(),
        publisherPeerId: SELF_PEER,
        resolution: { requiresEncryption: true, recipients },
      }),
    );
    /** What the member holds for an epoch: its first chain key and the sender's signing key. */
    const memberSecretFor = async (epochId: string) => {
      const setup = setupsSentToMember.map(decodeSwmSenderKeyPackage).find((pkg) => pkg.epochId === epochId);
      if (!setup) throw new Error(`the member was sent no setup for epoch ${epochId}`);
      return decryptSwmSenderKeyPackage({ package: setup, recipientKey: memberKey });
    };
    const sendState = (): LocalSwmSenderKeySendState => {
      const state = internals.swmSenderKeySendStates.get(
        swmSenderStateKey(contextGraphId, undefined, sender.agentAddress),
      );
      if (!state) throw new Error('missing sender-key send state');
      return state;
    };
    return { internals, contextGraphId, share, memberSecretFor, sendState, setupsSentToMember };
  }

  it('gives each overlapping share its own message index and the chain key of that index', async () => {
    const rig = await senderWithOneMember('sender-key-overlap-sequence');

    const first = await rig.share('first');
    const overlapping = await Promise.all(['a', 'b', 'c'].map((plaintext) => rig.share(plaintext)));
    const after = await rig.share('after');

    expect(uint64ForProto(first.messageIndex)).toBe(0);
    expect(overlapping.map((message) => uint64ForProto(message.messageIndex)).sort()).toEqual([1, 2, 3]);
    expect(uint64ForProto(after.messageIndex)).toBe(4);
    expect(new Set([first, ...overlapping, after].map((message) => message.epochId)).size).toBe(1);

    // The member follows the chain from the epoch's first key: every message
    // must open with the key that many steps along it.
    const secret = await rig.memberSecretFor(first.epochId);
    const keyAt = (index: number): Uint8Array => {
      let key = secret.chainKey;
      for (let step = 0; step < index; step++) key = ratchetSwmSenderChainKey(key);
      return key;
    };
    const opened: string[] = [];
    for (const message of [first, ...overlapping, after]) {
      const result = await decryptSwmSenderKeyMessage({
        chainKey: keyAt(uint64ForProto(message.messageIndex)),
        message,
        senderSigningPublicKey: secret.senderSigningPublicKey,
      });
      opened.push(text(result.plaintext));
    }
    expect(opened).toEqual(['first', 'a', 'b', 'c', 'after']);

    // The sender's saved state is the next pair of that same chain.
    expect(rig.sendState().nextMessageIndex).toBe(5);
    expect(Buffer.from(rig.sendState().chainKey).equals(Buffer.from(keyAt(5)))).toBe(true);
  });

  it('lets a recipient node open overlapping shares in any arrival order', async () => {
    const rig = await senderWithOneMember('sender-key-overlap-arrival');

    // The sender is a recipient of its own epoch, so its node holds the same
    // receive state a remote member would.
    const first = await rig.share('first');
    const overlapping = await Promise.all(['a', 'b', 'c', 'd'].map((plaintext) => rig.share(plaintext)));
    const after = await rig.share('after');

    const byIndex = new Map([first, ...overlapping, after].map((message) => [uint64ForProto(message.messageIndex), message]));
    expect([...byIndex.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const opened: number[] = [];
    for (const index of [0, 3, 1, 4, 2, 5]) {
      await rig.internals.decryptWorkspacePayloadWithSenderKey(byIndex.get(index)!, rig.contextGraphId, CTX);
      opened.push(index);
    }
    expect(opened).toEqual([0, 3, 1, 4, 2, 5]);
  });

  it('replaces, once, an epoch saved before the index and the key were advanced together', async () => {
    const rig = await senderWithOneMember('sender-key-overlap-saved-state');

    const first = await rig.share('first');
    expect(rig.sendState().chainKeyMatchesIndex).toBe(true);

    // What a node holds after an upgrade: an epoch whose saved state says
    // nothing about how it was advanced. Its key may be behind its index, and
    // no recipient can open a message from such a pair.
    delete rig.sendState().chainKeyMatchesIndex;
    rig.sendState().nextMessageIndex += 3;

    const replaced = await rig.share('after-upgrade');
    expect(replaced.epochId).not.toBe(first.epochId);
    expect(uint64ForProto(replaced.messageIndex)).toBe(0);
    expect(rig.sendState().chainKeyMatchesIndex).toBe(true);
    const secret = await rig.memberSecretFor(replaced.epochId);
    const result = await decryptSwmSenderKeyMessage({
      chainKey: secret.chainKey,
      message: replaced,
      senderSigningPublicKey: secret.senderSigningPublicKey,
    });
    expect(text(result.plaintext)).toBe('after-upgrade');

    const next = await rig.share('next');
    expect(next.epochId).toBe(replaced.epochId);
    expect(uint64ForProto(next.messageIndex)).toBe(1);
  });

  it('keeps the mark across a save and reads saved state without it as unmarked', async () => {
    const rig = await senderWithOneMember('sender-key-overlap-persistence');
    await rig.share('first');

    const saved = serializeSwmSenderSendState(rig.sendState());
    expect(deserializeSwmSenderSendState(saved).chainKeyMatchesIndex).toBe(true);

    const savedByAnEarlierBuild = { ...saved };
    delete savedByAnEarlierBuild.chainKeyMatchesIndex;
    expect(deserializeSwmSenderSendState(savedByAnEarlierBuild).chainKeyMatchesIndex).toBeUndefined();
    expect(deserializeSwmSenderSendState({ ...saved, chainKeyMatchesIndex: 'yes' }).chainKeyMatchesIndex).toBeUndefined();
  });
});
