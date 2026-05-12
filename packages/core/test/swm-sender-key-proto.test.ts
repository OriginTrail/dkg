import { describe, expect, it } from 'vitest';
import {
  SWM_SENDER_KEY_CIPHER_ALGORITHM,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
  computeSwmSenderKeyMessageAAD,
  decodeSwmSenderKeyMessage,
  decodeSwmSenderKeyPackage,
  decodeSwmSenderKeyPackageAck,
  encodeSwmSenderKeyMessage,
  encodeSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
} from '../src/index.js';

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('SWM Sender Key proto', () => {
  const pkg: SwmSenderKeyPackageMsg = {
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_PACKAGE_TYPE,
    contextGraphId: 'cg-private',
    subGraphName: 'chat',
    senderAgentAddress: '0x1111111111111111111111111111111111111111',
    epochId: 'epoch-1',
    membershipHash: 'sha256:abc',
    recipientAgentAddress: '0x2222222222222222222222222222222222222222',
    recipientKeyId: 'did:dkg:agent:0x222#x25519',
    createdAtMs: 1_770_000_000_000,
    initialMessageIndex: 0,
    senderSigningPublicKey: bytes(32, 1),
    keyAgreementAlgorithm: SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
    ephemeralPublicKey: bytes(32, 2),
    nonce: bytes(12, 3),
    ciphertext: bytes(48, 4),
    signature: bytes(65, 5),
  };

  const message: SwmSenderKeyMessageMsg = {
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_MESSAGE_TYPE,
    contextGraphId: 'cg-private',
    subGraphName: 'chat',
    senderAgentAddress: '0x1111111111111111111111111111111111111111',
    epochId: 'epoch-1',
    membershipHash: 'sha256:abc',
    messageIndex: 7,
    cipherAlgorithm: SWM_SENDER_KEY_CIPHER_ALGORITHM,
    nonce: bytes(12, 6),
    ciphertext: bytes(64, 7),
    aadHash: bytes(32, 8),
    senderKeySignature: bytes(64, 9),
  };

  it('encodes and decodes setup packages and ACKs', () => {
    const decoded = decodeSwmSenderKeyPackage(encodeSwmSenderKeyPackage(pkg));
    expect(decoded).toMatchObject({
      version: SWM_SENDER_KEY_PACKAGE_VERSION,
      type: SWM_SENDER_KEY_PACKAGE_TYPE,
      contextGraphId: pkg.contextGraphId,
      subGraphName: pkg.subGraphName,
      senderAgentAddress: pkg.senderAgentAddress,
      epochId: pkg.epochId,
      membershipHash: pkg.membershipHash,
      recipientAgentAddress: pkg.recipientAgentAddress,
      recipientKeyId: pkg.recipientKeyId,
      createdAtMs: pkg.createdAtMs,
      initialMessageIndex: pkg.initialMessageIndex,
      keyAgreementAlgorithm: SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
    });
    expect(new Uint8Array(decoded.senderSigningPublicKey)).toEqual(pkg.senderSigningPublicKey);
    expect(new Uint8Array(decoded.ephemeralPublicKey)).toEqual(pkg.ephemeralPublicKey);
    expect(new Uint8Array(decoded.nonce)).toEqual(pkg.nonce);
    expect(new Uint8Array(decoded.ciphertext)).toEqual(pkg.ciphertext);
    expect(new Uint8Array(decoded.signature)).toEqual(pkg.signature);

    const ack = decodeSwmSenderKeyPackageAck(encodeSwmSenderKeyPackageAck({
      version: SWM_SENDER_KEY_PACKAGE_VERSION,
      type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
      accepted: false,
      reason: 'missing key',
      contextGraphId: pkg.contextGraphId,
      subGraphName: pkg.subGraphName,
      senderAgentAddress: pkg.senderAgentAddress,
      epochId: pkg.epochId,
      membershipHash: pkg.membershipHash,
      recipientAgentAddress: pkg.recipientAgentAddress,
    }));
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toBe('missing key');
    expect(ack.type).toBe(SWM_SENDER_KEY_PACKAGE_ACK_TYPE);
  });

  it('encodes and decodes broadcast messages', () => {
    const decoded = decodeSwmSenderKeyMessage(encodeSwmSenderKeyMessage(message));
    expect(decoded).toMatchObject({
      version: SWM_SENDER_KEY_PACKAGE_VERSION,
      type: SWM_SENDER_KEY_MESSAGE_TYPE,
      contextGraphId: message.contextGraphId,
      subGraphName: message.subGraphName,
      senderAgentAddress: message.senderAgentAddress,
      epochId: message.epochId,
      membershipHash: message.membershipHash,
      messageIndex: message.messageIndex,
      cipherAlgorithm: SWM_SENDER_KEY_CIPHER_ALGORITHM,
    });
    expect(new Uint8Array(decoded.nonce)).toEqual(message.nonce);
    expect(new Uint8Array(decoded.ciphertext)).toEqual(message.ciphertext);
    expect(new Uint8Array(decoded.aadHash)).toEqual(message.aadHash);
    expect(new Uint8Array(decoded.senderKeySignature)).toEqual(message.senderKeySignature);
  });

  it('binds message AAD to context, subgraph, sender, epoch, membership, index, algorithm, and nonce', () => {
    const fields = {
      contextGraphId: message.contextGraphId,
      subGraphName: message.subGraphName,
      senderAgentAddress: message.senderAgentAddress,
      epochId: message.epochId,
      membershipHash: message.membershipHash,
      messageIndex: message.messageIndex,
      cipherAlgorithm: message.cipherAlgorithm,
      nonce: message.nonce,
    };
    const base = computeSwmSenderKeyMessageAAD(fields);

    expect(computeSwmSenderKeyMessageAAD(fields)).toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, contextGraphId: 'cg-other' })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, subGraphName: 'tasks' })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, senderAgentAddress: '0x3333333333333333333333333333333333333333' })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, epochId: 'epoch-2' })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, membershipHash: 'sha256:def' })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, messageIndex: 8 })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, cipherAlgorithm: 'other' })).not.toEqual(base);
    expect(computeSwmSenderKeyMessageAAD({ ...fields, nonce: bytes(12, 10) })).not.toEqual(base);
  });
});
