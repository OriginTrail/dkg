import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptKeystore,
  decryptKeystore,
  isEncryptedKeystore,
  _setScryptN,
  type EncryptedKeystore,
} from '../src/keystore.js';

beforeAll(() => {
  _setScryptN(2 ** 14);
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
