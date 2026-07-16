import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptV10PublishPayload,
  decryptV10PublishPayload,
  isEncryptedV10PublishPayload,
  encryptChunked,
  decryptChunked,
  deriveChunkNonce,
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

describe('deriveChunkNonce — determinism + domain separation', () => {
  it('returns 12 bytes', () => {
    expect(deriveChunkNonce('op-1', 0)).toHaveLength(12);
  });

  it('is deterministic across calls with the same inputs', () => {
    const a = deriveChunkNonce('op-1', 7);
    const b = deriveChunkNonce('op-1', 7);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('differs across chunkIndex values for the same publishOperationId', () => {
    const a = deriveChunkNonce('op-1', 0);
    const b = deriveChunkNonce('op-1', 1);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('differs across publishOperationIds at the same chunkIndex', () => {
    const a = deriveChunkNonce('op-1', 3);
    const b = deriveChunkNonce('op-2', 3);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('throws on empty publishOperationId or negative/non-integer chunkIndex', () => {
    expect(() => deriveChunkNonce('', 0)).toThrow(/non-empty/);
    expect(() => deriveChunkNonce('op-1', -1)).toThrow(/non-negative integer/);
    expect(() => deriveChunkNonce('op-1', 1.5)).toThrow(/non-negative integer/);
  });
});

describe('encryptChunked / decryptChunked', () => {
  const chainKey = rb(32);
  const cgId = '42';
  const publishOperationId = 'publish-op-abc';
  const plaintextChunks = [
    new TextEncoder().encode('<urn:entity:a> <urn:p> <urn:o1> <urn:g> .'),
    new TextEncoder().encode('<urn:entity:b> <urn:p> <urn:o2> <urn:g> .'),
    new TextEncoder().encode('<urn:entity:c> <urn:p> <urn:o3> <urn:g> .'),
  ];

  it('round-trips every chunk to the original plaintext, in order', () => {
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    expect(ciphertextChunks).toHaveLength(plaintextChunks.length);

    const { plaintextChunks: recovered } = decryptChunked({
      chainKey,
      contextGraphId: cgId,
      ciphertextChunks,
    });
    expect(recovered).toHaveLength(plaintextChunks.length);
    for (let i = 0; i < plaintextChunks.length; i++) {
      expect(Buffer.from(recovered[i]).equals(Buffer.from(plaintextChunks[i]))).toBe(true);
    }
  });

  it('every chunk carries the V10P magic + 12-byte nonce + 16-byte GCM tag layout', () => {
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    for (let i = 0; i < ciphertextChunks.length; i++) {
      const chunk = ciphertextChunks[i];
      expect(chunk.slice(0, 4)).toEqual(V10_PUBLISH_PAYLOAD_MAGIC);
      expect(chunk.length).toBe(4 + 12 + plaintextChunks[i].length + 16);
      const expectedNonce = deriveChunkNonce(publishOperationId, i);
      expect(Array.from(chunk.slice(4, 16))).toEqual(Array.from(expectedNonce));
    }
  });

  it('is byte-identical across re-runs with the same publishOperationId (retry-safe)', () => {
    const a = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    const b = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    expect(a.ciphertextChunks).toHaveLength(b.ciphertextChunks.length);
    for (let i = 0; i < a.ciphertextChunks.length; i++) {
      expect(Buffer.from(a.ciphertextChunks[i]).equals(Buffer.from(b.ciphertextChunks[i]))).toBe(true);
    }
  });

  it('changes byte-for-byte when the publishOperationId rotates', () => {
    const a = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    const b = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId: 'publish-op-different',
    });
    for (let i = 0; i < a.ciphertextChunks.length; i++) {
      expect(Buffer.from(a.ciphertextChunks[i]).equals(Buffer.from(b.ciphertextChunks[i]))).toBe(false);
    }
  });

  it('changes byte-for-byte when the cgId rotates (HKDF key domain separation)', () => {
    const a = encryptChunked({
      chainKey,
      contextGraphId: '42',
      plaintextChunks,
      publishOperationId,
    });
    const b = encryptChunked({
      chainKey,
      contextGraphId: '43',
      plaintextChunks,
      publishOperationId,
    });
    for (let i = 0; i < a.ciphertextChunks.length; i++) {
      expect(Buffer.from(a.ciphertextChunks[i]).equals(Buffer.from(b.ciphertextChunks[i]))).toBe(false);
    }
  });

  it('produces ciphertext that the legacy single-blob decryptor can also unwrap (shared wire layout)', () => {
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    // Each chunk is structurally a `V10PublishPayload` — decryptV10PublishPayload
    // should unwrap a single chunk identically to decryptChunked on a 1-element array.
    const viaLegacy = decryptV10PublishPayload({
      chainKey,
      contextGraphId: cgId,
      encryptedPayload: ciphertextChunks[1],
    });
    expect(Buffer.from(viaLegacy).equals(Buffer.from(plaintextChunks[1]))).toBe(true);
  });

  it('decryptChunked rejects ciphertext encrypted under a different chainKey', () => {
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    expect(() => decryptChunked({
      chainKey: rb(32),
      contextGraphId: cgId,
      ciphertextChunks,
    })).toThrow();
  });

  it('decryptChunked rejects ciphertext encrypted for a different cgId', () => {
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks,
      publishOperationId,
    });
    expect(() => decryptChunked({
      chainKey,
      contextGraphId: '99',
      ciphertextChunks,
    })).toThrow();
  });

  it('handles 0-chunk input → 0-chunk output (empty curated publish)', () => {
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks: [],
      publishOperationId,
    });
    expect(ciphertextChunks).toHaveLength(0);
    const { plaintextChunks: recovered } = decryptChunked({
      chainKey,
      contextGraphId: cgId,
      ciphertextChunks,
    });
    expect(recovered).toHaveLength(0);
  });

  it('handles same-bytes-twice plaintext at distinct chunkIds with distinct ciphertexts (nonce decorrelates)', () => {
    const dup = new TextEncoder().encode('identical');
    const { ciphertextChunks } = encryptChunked({
      chainKey,
      contextGraphId: cgId,
      plaintextChunks: [dup, dup],
      publishOperationId,
    });
    expect(Buffer.from(ciphertextChunks[0]).equals(Buffer.from(ciphertextChunks[1]))).toBe(false);
    const { plaintextChunks: recovered } = decryptChunked({
      chainKey,
      contextGraphId: cgId,
      ciphertextChunks,
    });
    expect(Buffer.from(recovered[0]).equals(Buffer.from(dup))).toBe(true);
    expect(Buffer.from(recovered[1]).equals(Buffer.from(dup))).toBe(true);
  });
});
