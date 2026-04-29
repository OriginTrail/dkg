import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptKeystore,
  decryptKeystore,
  isEncryptedKeystore,
  _setScryptN,
  type EncryptedKeystore,
} from '../src/keystore.js';

beforeAll(() => {
  // Production scrypt N for the keystore is 2^18, but that's ~128 MB
  // per derivation which OOMs constrained CI workers running 4 vitest
  // shards in parallel. Use 2^15 — the *minimum production floor*
  // enforced by `decryptKeystore` (see CLI-1 in
  // . test-audit/. This keeps the test fast while still
  // exercising a parameter set that the production-hardened loader
  // accepts (a previous value of 2^14 was below the floor and would
  // now correctly be refused as a weak keystore).
  _setScryptN(2 ** 15);
});

const TEST_KEY = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';
const PASSPHRASE = 'test-passphrase-123';

describe('encryptKeystore / decryptKeystore round-trip', () => {
  it('decrypts to the original key', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    const decrypted = await decryptKeystore(ks, PASSPHRASE);
    expect(decrypted).toBe(TEST_KEY);
  });

  it('works with a short key', async () => {
    const shortKey = 'deadbeef';
    const ks = await encryptKeystore(shortKey, PASSPHRASE);
    const decrypted = await decryptKeystore(ks, PASSPHRASE);
    expect(decrypted).toBe(shortKey);
  });
});

describe('encryptKeystore output structure', () => {
  it('has the correct shape', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    expect(ks.version).toBe(1);
    expect(ks.crypto.cipher).toBe('aes-256-gcm');
    expect(ks.crypto.kdf).toBe('scrypt');
    expect(typeof ks.crypto.ciphertext).toBe('string');
    expect(typeof ks.crypto.iv).toBe('string');
    expect(typeof ks.crypto.tag).toBe('string');
    expect(typeof ks.crypto.kdfparams.salt).toBe('string');
    expect(ks.crypto.kdfparams.dklen).toBe(32);
    expect(typeof ks.id).toBe('string');
  });

  it('produces different ciphertexts for the same key (random salt/IV)', async () => {
    const a = await encryptKeystore(TEST_KEY, PASSPHRASE);
    const b = await encryptKeystore(TEST_KEY, PASSPHRASE);
    expect(a.crypto.ciphertext).not.toBe(b.crypto.ciphertext);
    expect(a.crypto.iv).not.toBe(b.crypto.iv);
    expect(a.crypto.kdfparams.salt).not.toBe(b.crypto.kdfparams.salt);
  });
});

describe('decryptKeystore error handling', () => {
  it('throws on wrong passphrase', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    await expect(decryptKeystore(ks, 'wrong-password')).rejects.toThrow(
      /Decryption failed/,
    );
  });

  it('throws on unsupported version', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    const tampered = { ...ks, version: 99 } as unknown as EncryptedKeystore;
    await expect(decryptKeystore(tampered, PASSPHRASE)).rejects.toThrow(
      /Unsupported keystore version/,
    );
  });

  it('throws on tampered ciphertext', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.ciphertext = 'ff'.repeat(ks.crypto.ciphertext.length / 2);
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(
      /Decryption failed/,
    );
  });

  it('throws on tampered auth tag', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.tag = '00'.repeat(16);
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(
      /Decryption failed/,
    );
  });

  it('rejects keystore whose hex salt has odd length (silent-truncation guard)', async () => {
    // a 33-character hex salt advertises
    // floor(33/2)=16 bytes (>= MIN_SALT_BYTES under integer division) so
    // the previous length check let it through, but `Buffer.from(s, 'hex')`
    // silently drops the dangling nibble and derives from a 16-byte salt
    // instead of the 17 the operator believed they had configured.
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.salt = 'a'.repeat(33);
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(
      /weak keystore/,
    );
  });

  it('rejects keystore whose hex salt has non-hex characters', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.salt = 'zz'.repeat(20);
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(
      /weak keystore/,
    );
  });
});

describe('isEncryptedKeystore', () => {
  it('returns true for a valid keystore object', async () => {
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    expect(isEncryptedKeystore(ks)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isEncryptedKeystore(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isEncryptedKeystore(undefined)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isEncryptedKeystore({})).toBe(false);
  });

  it('returns false for wrong version', () => {
    expect(isEncryptedKeystore({ version: 2, crypto: {} })).toBe(false);
  });

  it('returns false for missing crypto', () => {
    expect(isEncryptedKeystore({ version: 1 })).toBe(false);
  });
});
