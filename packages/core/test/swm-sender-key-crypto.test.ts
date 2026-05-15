import { describe, expect, it } from 'vitest';
import {
  SWM_SENDER_KEY_CIPHER_ALGORITHM,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_TYPE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  computeSwmSenderKeyMembershipHash,
  decryptSwmSenderKeyMessage,
  decryptSwmSenderKeyPackage,
  encryptSwmSenderKeyMessage,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  generateWorkspaceRecipientEncryptionKey,
  ratchetSwmSenderChainKey,
  type WorkspaceRecipientEncryptionKey,
} from '../src/index.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function deterministicRandomBytes(): (length: number) => Uint8Array {
  let next = 1;
  return (length: number) => new Uint8Array(length).fill(next++);
}

function recipientKey(agentAddress: string, fill: number): WorkspaceRecipientEncryptionKey {
  return generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${agentAddress}`,
    `did:dkg:agent:${agentAddress}#x25519`,
    (length) => new Uint8Array(length).fill(fill),
  );
}

describe('SWM Sender Key crypto', () => {
  it('encrypts setup packages to one DKG agent X25519 key', async () => {
    const recipient = recipientKey('0x2222222222222222222222222222222222222222', 0x22);
    const signingKeypair = await generateEd25519Keypair();
    const chainKey = generateSwmSenderChainKey(() => new Uint8Array(32).fill(0x44));
    const pkg = await encryptSwmSenderKeyPackage({
      contextGraphId: 'cg-private',
      subGraphName: 'chat',
      senderAgentAddress: '0x1111111111111111111111111111111111111111',
      epochId: generateSwmSenderEpochId(() => new Uint8Array(16).fill(0x55)),
      membershipHash: 'sha256:abc',
      recipientAgentAddress: '0x2222222222222222222222222222222222222222',
      recipientKeyId: recipient.recipientKeyId,
      createdAtMs: 1_770_000_000_000,
      initialMessageIndex: 0,
      chainKey,
      senderSigningPublicKey: signingKeypair.publicKey,
      recipientPublicKey: recipient.publicKeyBytes!,
      randomBytes: deterministicRandomBytes(),
    });

    expect(pkg.version).toBe(SWM_SENDER_KEY_PACKAGE_VERSION);
    expect(pkg.type).toBe(SWM_SENDER_KEY_PACKAGE_TYPE);
    expect(pkg.keyAgreementAlgorithm).toBe(SWM_SENDER_KEY_SETUP_KEY_AGREEMENT_ALGORITHM);
    expect(pkg.ciphertext).not.toEqual(chainKey);

    const secret = await decryptSwmSenderKeyPackage({ package: pkg, recipientKey: recipient });
    expect(secret.contextGraphId).toBe(pkg.contextGraphId);
    expect(secret.epochId).toBe(pkg.epochId);
    expect(new Uint8Array(secret.chainKey)).toEqual(chainKey);
    expect(new Uint8Array(secret.senderSigningPublicKey)).toEqual(signingKeypair.publicKey);

    const wrongRecipient = {
      ...recipientKey('0x3333333333333333333333333333333333333333', 0x33),
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    };
    await expect(decryptSwmSenderKeyPackage({ package: pkg, recipientKey: wrongRecipient }))
      .rejects.toThrow('recipient does not match');
  });

  it('encrypts one ratcheted broadcast ciphertext and rejects context tampering', async () => {
    const signingKeypair = await generateEd25519Keypair();
    const chainKey = generateSwmSenderChainKey(() => new Uint8Array(32).fill(0x11));
    const plaintext = textEncoder.encode('<urn:private> <urn:p> "secret" .');
    const first = await encryptSwmSenderKeyMessage({
      chainKey,
      plaintext,
      senderSigningSecretKey: signingKeypair.secretKey,
      contextGraphId: 'cg-private',
      subGraphName: 'chat',
      senderAgentAddress: '0x1111111111111111111111111111111111111111',
      epochId: 'epoch-1',
      membershipHash: 'sha256:abc',
      messageIndex: 0,
    });
    const second = await encryptSwmSenderKeyMessage({
      chainKey: first.nextChainKey,
      plaintext,
      senderSigningSecretKey: signingKeypair.secretKey,
      contextGraphId: 'cg-private',
      subGraphName: 'chat',
      senderAgentAddress: '0x1111111111111111111111111111111111111111',
      epochId: 'epoch-1',
      membershipHash: 'sha256:abc',
      messageIndex: 1,
    });

    expect(first.message.type).toBe(SWM_SENDER_KEY_MESSAGE_TYPE);
    expect(first.message.cipherAlgorithm).toBe(SWM_SENDER_KEY_CIPHER_ALGORITHM);
    expect(textDecoder.decode(first.message.ciphertext)).not.toContain('secret');
    expect(first.message.ciphertext).not.toEqual(second.message.ciphertext);
    expect(first.message.nonce).not.toEqual(second.message.nonce);
    expect(first.nextChainKey).toEqual(ratchetSwmSenderChainKey(chainKey));

    const decrypted = await decryptSwmSenderKeyMessage({
      chainKey,
      message: first.message,
      senderSigningPublicKey: signingKeypair.publicKey,
    });
    expect(new Uint8Array(decrypted.plaintext)).toEqual(plaintext);

    await expect(decryptSwmSenderKeyMessage({
      chainKey,
      message: { ...first.message, contextGraphId: 'cg-other' },
      senderSigningPublicKey: signingKeypair.publicKey,
    })).rejects.toThrow();
  });

  it('computes membership hash from sorted DKG agent addresses and recipient key IDs', () => {
    const base = computeSwmSenderKeyMembershipHash({
      contextGraphId: 'cg-private',
      subGraphName: 'chat',
      members: [
        { agentAddress: '0x2222222222222222222222222222222222222222', recipientKeyId: 'b' },
        { agentAddress: '0x1111111111111111111111111111111111111111', recipientKeyId: 'a' },
      ],
    });
    const reordered = computeSwmSenderKeyMembershipHash({
      contextGraphId: 'cg-private',
      subGraphName: 'chat',
      members: [
        { agentAddress: '0x1111111111111111111111111111111111111111', recipientKeyId: 'a' },
        { agentAddress: '0x2222222222222222222222222222222222222222', recipientKeyId: 'b' },
      ],
    });

    expect(base).toBe(reordered);
    expect(computeSwmSenderKeyMembershipHash({
      contextGraphId: 'cg-private',
      subGraphName: 'tasks',
      members: [
        { agentAddress: '0x1111111111111111111111111111111111111111', recipientKeyId: 'a' },
        { agentAddress: '0x2222222222222222222222222222222222222222', recipientKeyId: 'b' },
      ],
    })).not.toBe(base);
  });
});
