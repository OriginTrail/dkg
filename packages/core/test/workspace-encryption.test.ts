import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  ENCRYPTED_WORKSPACE_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM,
  ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM,
  WORKSPACE_ENCRYPTION_KEY_BYTES,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  assertSupportedEncryptedWorkspaceEnvelope,
  decryptWorkspacePayload,
  encryptWorkspacePayload,
  generateWorkspaceRecipientEncryptionKey,
  type EncryptWorkspacePayloadInput,
  type WorkspaceRecipientEncryptionKey,
} from '../src/index.js';

const textEncoder = new TextEncoder();

function deterministicRandomBytes(): (length: number) => Uint8Array {
  let next = 1;
  return (length: number) => new Uint8Array(length).fill(next++);
}

function recipientKey(
  recipientId: string,
  recipientKeyId: string,
  fill: number,
): WorkspaceRecipientEncryptionKey {
  return generateWorkspaceRecipientEncryptionKey(
    recipientId,
    recipientKeyId,
    (length) => new Uint8Array(length).fill(fill),
  );
}

function inputFor(recipients: WorkspaceRecipientEncryptionKey[]): EncryptWorkspacePayloadInput {
  return {
    contextGraphId: 'cg-private',
    senderIdentity: 'did:dkg:agent:0x1234',
    operationId: 'op-1',
    shareOperationId: 'swm-op-1',
    timestampMs: 1_770_000_000_000,
    subGraphName: 'chat',
    plaintext: textEncoder.encode('<urn:s> <urn:p> "secret" .'),
    recipients,
    randomBytes: deterministicRandomBytes(),
  };
}

describe('workspace encrypted payload helpers', () => {
  it('encrypts and decrypts workspace payloads for matching recipient encryption keys', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const bob = recipientKey('did:dkg:agent:bob', 'bob-key-1', 0xb1);
    const envelope = await encryptWorkspacePayload(inputFor([alice, bob]));

    expect(envelope.version).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_VERSION);
    expect(envelope.type).toBe(ENCRYPTED_WORKSPACE_ENVELOPE_TYPE);
    expect(envelope.cipherAlgorithm).toBe(ENCRYPTED_WORKSPACE_CIPHER_ALGORITHM);
    expect(envelope.keyAgreementAlgorithm).toBe(ENCRYPTED_WORKSPACE_KEY_AGREEMENT_ALGORITHM);
    expect(envelope.ephemeralPublicKey).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
    expect(envelope.recipients).toHaveLength(2);
    expect(envelope.recipients[0].algorithm).toBe(ENCRYPTED_WORKSPACE_KEY_WRAP_ALGORITHM);
    expect(envelope.ciphertext).not.toEqual(inputFor([alice]).plaintext);

    const decrypted = await decryptWorkspacePayload(envelope, [bob]);
    expect(decrypted.recipientId).toBe(bob.recipientId);
    expect(decrypted.recipientKeyId).toBe(bob.recipientKeyId);
    expect(new Uint8Array(decrypted.plaintext)).toEqual(inputFor([alice]).plaintext);
  });

  it('rejects unsupported envelope type and version if JavaScript callers pass extra fields', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const unsupportedVersion = {
      ...inputFor([alice]),
      version: '2',
    } as EncryptWorkspacePayloadInput & { version: string };
    const unsupportedType = {
      ...inputFor([alice]),
      type: 'dkg.workspace.future',
    } as EncryptWorkspacePayloadInput & { type: string };

    await expect(encryptWorkspacePayload(unsupportedVersion)).rejects.toThrow(
      'Unsupported encrypted workspace envelope version',
    );
    await expect(encryptWorkspacePayload(unsupportedType)).rejects.toThrow(
      'Unsupported encrypted workspace envelope type',
    );
  });

  it('rejects unsupported encrypted workspace envelope constants before decryption', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const envelope = await encryptWorkspacePayload(inputFor([alice]));

    expect(() => assertSupportedEncryptedWorkspaceEnvelope({ ...envelope, version: '2' })).toThrow(
      'Unsupported encrypted workspace envelope version',
    );
    await expect(decryptWorkspacePayload({ ...envelope, type: 'other' }, [alice])).rejects.toThrow(
      'Unsupported encrypted workspace envelope type',
    );
  });

  it('rejects keys that are not dedicated workspace recipient encryption keys', async () => {
    const wrongPurpose = {
      ...recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1),
      purpose: 'ethereum.signing-key',
    } as WorkspaceRecipientEncryptionKey;

    await expect(encryptWorkspacePayload(inputFor([wrongPurpose]))).rejects.toThrow(
      'Expected a dedicated workspace recipient encryption key',
    );
  });

  it('fails closed when metadata bound into AAD is tampered', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const envelope = await encryptWorkspacePayload(inputFor([alice]));

    await expect(
      decryptWorkspacePayload({ ...envelope, contextGraphId: 'cg-other' }, [alice]),
    ).rejects.toThrow('No matching recipient encryption key could decrypt workspace payload');
  });

  it('does not decrypt with a non-matching recipient key', async () => {
    const alice = recipientKey('did:dkg:agent:alice', 'alice-key-1', 0xa1);
    const mallory = recipientKey('did:dkg:agent:mallory', 'mallory-key-1', 0xa1);
    const envelope = await encryptWorkspacePayload(inputFor([alice]));

    await expect(decryptWorkspacePayload(envelope, [mallory])).rejects.toThrow(
      'No matching recipient encryption key could decrypt workspace payload',
    );
  });

  it('generates dedicated recipient encryption keys with the expected size and purpose', () => {
    const key = generateWorkspaceRecipientEncryptionKey('did:dkg:agent:alice', 'alice-key-1');

    expect(key.purpose).toBe(WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE);
    expect(key.recipientId).toBe('did:dkg:agent:alice');
    expect(key.recipientKeyId).toBe('alice-key-1');
    expect(key.publicKeyBytes).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
    expect(key.privateKeyBytes).toHaveLength(WORKSPACE_ENCRYPTION_KEY_BYTES);
  });
});
