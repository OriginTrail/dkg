import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptV10PublishPayload,
  decryptV10PublishPayload,
  isEncryptedV10PublishPayload,
  V10_PUBLISH_PAYLOAD_MAGIC,
} from '../src/index.js';

function rb(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

describe('v10-publish-payload', () => {
  const chainKey = rb(32);
  const cgId = '42';
  const plaintext = new TextEncoder().encode(
    [
      '<urn:entity:a> <urn:p> <urn:o1> <urn:g> .',
      '<urn:entity:a> <urn:p> <urn:o2> <urn:g> .',
      '<urn:entity:b> <urn:p> <urn:o3> <urn:g> .',
    ].join('\n'),
  );

  it('round-trip recovers the plaintext exactly', () => {
    const encrypted = encryptV10PublishPayload({ chainKey, contextGraphId: cgId, plaintext });
    expect(isEncryptedV10PublishPayload(encrypted)).toBe(true);

    const recovered = decryptV10PublishPayload({
      chainKey,
      contextGraphId: cgId,
      encryptedPayload: encrypted,
    });
    expect(Buffer.from(recovered).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('emits the V10P magic prefix and stable wire layout (magic | nonce | ct | tag)', () => {
    const fixedNonce = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const encrypted = encryptV10PublishPayload({
      chainKey,
      contextGraphId: cgId,
      plaintext,
      nonce: fixedNonce,
    });
    // magic == 'V10P'
    expect(encrypted.slice(0, 4)).toEqual(V10_PUBLISH_PAYLOAD_MAGIC);
    // nonce echoed verbatim at offset 4
    expect(Array.from(encrypted.slice(4, 16))).toEqual(Array.from(fixedNonce));
    // remaining = ciphertext (plaintext.length bytes) + 16-byte GCM tag
    expect(encrypted.length).toBe(4 + 12 + plaintext.length + 16);
  });

  it('different cgIds produce different ciphertexts (HKDF domain-separation)', () => {
    const fixedNonce = new Uint8Array(12).fill(7);
    const a = encryptV10PublishPayload({ chainKey, contextGraphId: '42', plaintext, nonce: fixedNonce });
    const b = encryptV10PublishPayload({ chainKey, contextGraphId: '43', plaintext, nonce: fixedNonce });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('decrypt rejects ciphertext encrypted under a different chainKey', () => {
    const encrypted = encryptV10PublishPayload({ chainKey, contextGraphId: cgId, plaintext });
    expect(() => decryptV10PublishPayload({
      chainKey: rb(32),
      contextGraphId: cgId,
      encryptedPayload: encrypted,
    })).toThrow();
  });

  it('decrypt rejects ciphertext encrypted for a different cgId', () => {
    const encrypted = encryptV10PublishPayload({ chainKey, contextGraphId: cgId, plaintext });
    expect(() => decryptV10PublishPayload({
      chainKey,
      contextGraphId: '99',
      encryptedPayload: encrypted,
    })).toThrow();
  });

  it('decrypt rejects truncated / corrupted ciphertexts', () => {
    const encrypted = encryptV10PublishPayload({ chainKey, contextGraphId: cgId, plaintext });
    // Flip a byte in the ciphertext middle (AEAD tag verification should fail)
    const corrupted = new Uint8Array(encrypted);
    corrupted[20] ^= 0xff;
    expect(() => decryptV10PublishPayload({
      chainKey,
      contextGraphId: cgId,
      encryptedPayload: corrupted,
    })).toThrow();

    // Truncate below header length
    const truncated = encrypted.slice(0, 10);
    expect(() => decryptV10PublishPayload({
      chainKey,
      contextGraphId: cgId,
      encryptedPayload: truncated,
    })).toThrow(/too short/);

    // Wrong magic prefix
    const wrongMagic = new Uint8Array(encrypted);
    wrongMagic[0] = 0xaa;
    expect(() => decryptV10PublishPayload({
      chainKey,
      contextGraphId: cgId,
      encryptedPayload: wrongMagic,
    })).toThrow(/magic prefix mismatch/);
  });

  it('rejects chainKey of wrong length', () => {
    expect(() => encryptV10PublishPayload({
      chainKey: rb(16),
      contextGraphId: cgId,
      plaintext,
    })).toThrow(/chainKey must be 32 bytes/);
  });

  it('isEncryptedV10PublishPayload returns true only for magic-prefixed buffers', () => {
    expect(isEncryptedV10PublishPayload(new Uint8Array([0x56, 0x31, 0x30, 0x50, 0xff]))).toBe(true);
    expect(isEncryptedV10PublishPayload(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(isEncryptedV10PublishPayload(new Uint8Array([0x56, 0x31, 0x30]))).toBe(false);
  });
});
