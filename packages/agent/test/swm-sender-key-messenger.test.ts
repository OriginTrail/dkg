import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  PROTOCOL_SWM_SENDER_KEY,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  decodeSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  type SwmSenderKeyPackageMsg,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';

function makeHarness(sendReliable: ReturnType<typeof vi.fn>) {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.messenger = { sendReliable };
  agent.log = { info: vi.fn(), warn: vi.fn() };
  agent.hasLocalAgent = () => false;
  agent.createSignedSwmSenderKeyPackage = vi.fn(async ({ state, recipient }: any): Promise<SwmSenderKeyPackageMsg> => ({
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_PACKAGE_TYPE,
    contextGraphId: state.contextGraphId,
    subGraphName: state.subGraphName,
    senderAgentAddress: state.senderAgentAddress,
    epochId: state.epochId,
    membershipHash: state.membershipHash,
    recipientAgentAddress: ethers.getAddress(recipient.agentAddress),
    recipientKeyId: recipient.recipientKeyId,
    createdAtMs: state.createdAtMs,
    initialMessageIndex: 0,
    senderSigningPublicKey: new Uint8Array([1, 2, 3]),
    keyAgreementAlgorithm: 'x25519-xsalsa20poly1305',
    ephemeralPublicKey: new Uint8Array([4, 5, 6]),
    nonce: new Uint8Array([7, 8, 9]),
    ciphertext: new Uint8Array([10, 11, 12]),
    signature: new Uint8Array([13, 14, 15]),
  }));
  return agent;
}

describe('DKGAgent SWM sender-key setup over Messenger', () => {
  it('sends setup packages through PROTOCOL_SWM_SENDER_KEY and accepts synchronous acks', async () => {
    const sender = ethers.Wallet.createRandom();
    const recipient = ethers.Wallet.createRandom();
    const sendReliable = vi.fn(async (_peer: string, protocol: string, payload: Uint8Array) => {
      expect(protocol).toBe(PROTOCOL_SWM_SENDER_KEY);
      const pkg = decodeSwmSenderKeyPackage(payload);
      return {
        delivered: true as const,
        response: encodeSwmSenderKeyPackageAck({
          version: SWM_SENDER_KEY_PACKAGE_VERSION,
          type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
          accepted: true,
          contextGraphId: pkg.contextGraphId,
          subGraphName: pkg.subGraphName,
          senderAgentAddress: pkg.senderAgentAddress,
          epochId: pkg.epochId,
          membershipHash: pkg.membershipHash,
          recipientAgentAddress: pkg.recipientAgentAddress,
        }),
        attempts: 1,
        messageId: 'msg-1',
      };
    });
    const agent = makeHarness(sendReliable);

    const state = await agent.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'cg-swm',
      sender: { agentAddress: sender.address, privateKey: sender.privateKey },
      recipients: [{
        agentAddress: recipient.address,
        recipientKeyId: 'key-1',
        peerId: '12D3KooWRecipient',
      }],
      membershipHash: 'membership-hash',
      ctx: { operationName: 'share', operationId: 'test' },
    });

    expect(state.contextGraphId).toBe('cg-swm');
    expect(sendReliable).toHaveBeenCalledTimes(1);
    expect(sendReliable.mock.calls[0][0]).toBe('12D3KooWRecipient');
    expect(agent.createSignedSwmSenderKeyPackage).toHaveBeenCalledTimes(1);
  });

  it('treats queued sender-key setup sends as fatal non-delivery', async () => {
    const sender = ethers.Wallet.createRandom();
    const recipient = ethers.Wallet.createRandom();
    const sendReliable = vi.fn(async () => ({
      delivered: false as const,
      queued: true as const,
      attempts: 1,
      messageId: 'msg-1',
      error: 'ECONNRESET',
    }));
    const agent = makeHarness(sendReliable);

    await expect(agent.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'cg-swm',
      sender: { agentAddress: sender.address, privateKey: sender.privateKey },
      recipients: [{
        agentAddress: recipient.address,
        recipientKeyId: 'key-1',
        peerId: '12D3KooWRecipient',
      }],
      membershipHash: 'membership-hash',
      ctx: { operationName: 'share', operationId: 'test' },
    })).rejects.toThrow(/SWM Sender Key setup rejected.*not synchronously deliverable/s);

    expect(sendReliable).toHaveBeenCalledTimes(1);
  });
});
