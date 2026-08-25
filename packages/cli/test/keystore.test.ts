import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptKeystore,
  decryptKeystore,
  isEncryptedKeystore,
  _setScryptN,
  _scryptCostPolicy,
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

  it('rejects a KDF memory cost immediately above the declared ceiling', async () => {
    // Boundary, not a wild value: n/r chosen so the working set is exactly one
    // scrypt block over MAX_WORKING_SET. A ceiling raised or lowered by any
    // amount fails this pair, which a 2**30 smoke test would not.
    const { maxWorkingSetBytes, workingSetBytes } = _scryptCostPolicy();
    const overN = (maxWorkingSetBytes / (128 * 8)) * 2; // r=8 => 2x ceiling
    expect(workingSetBytes(overN, 8)).toBeGreaterThan(maxWorkingSetBytes);
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.n = overN;
    ks.crypto.kdfparams.r = 8;
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(
      /memory cost too high/,
    );
  });

  it('accepts a KDF memory cost exactly at the declared ceiling', async () => {
    // Proves the ceiling is inclusive without allocating it: dklen is validated
    // after the cost policy, so an invalid dklen stops execution before scrypt.
    // The error text discriminates — a memory rejection would name the cost.
    const { maxWorkingSetBytes, workingSetBytes } = _scryptCostPolicy();
    const atN = maxWorkingSetBytes / (128 * 8);
    expect(workingSetBytes(atN, 8)).toBe(maxWorkingSetBytes);
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.n = atN;
    ks.crypto.kdfparams.r = 8;
    ks.crypto.kdfparams.dklen = 16;
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(/dklen/);
  });

  it('accepts p at the ceiling and rejects p one above it', async () => {
    const { maxP } = _scryptCostPolicy();
    const atCeiling = await encryptKeystore(TEST_KEY, PASSPHRASE);
    atCeiling.crypto.kdfparams.p = maxP;
    atCeiling.crypto.kdfparams.dklen = 16;
    await expect(decryptKeystore(atCeiling, PASSPHRASE)).rejects.toThrow(/dklen/);

    const overCeiling = await encryptKeystore(TEST_KEY, PASSPHRASE);
    overCeiling.crypto.kdfparams.p = maxP + 1;
    await expect(decryptKeystore(overCeiling, PASSPHRASE)).rejects.toThrow(
      /p too high/,
    );
  });

  it('rejects keystore declaring a non-power-of-two scrypt N', async () => {
    // scrypt requires N to be a power of two; without this check the value is
    // handed to OpenSSL and fails there with an opaque error.
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.n = (2 ** 15) + 1;
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(
      /power of two/,
    );
  });

  it('budgets enough memory for the CLI production parameters to actually derive', async () => {
    // The regression this pins is a shipped one: `deriveKey` passed a hardcoded
    // maxmem of 256 MiB while production N=2**18, r=8 needs a working set of
    // exactly 256 MiB, and OpenSSL bounds `workingSet + overhead <= maxmem`.
    // Production keystores therefore failed with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
    // The suite lowers N to 2**15, so no round-trip test could ever catch it —
    // this asserts the policy arithmetic instead, which is where the bug lived.
    const { executionMaxmemBytes, productionWorkingSetBytes, maxWorkingSetBytes, assertWithinLimits } =
      _scryptCostPolicy();
    expect(productionWorkingSetBytes).toBe(128 * (2 ** 18) * 8);
    expect(productionWorkingSetBytes).toBeLessThanOrEqual(maxWorkingSetBytes);
    // Strictly greater: equality is exactly what OpenSSL rejects.
    expect(executionMaxmemBytes).toBeGreaterThan(productionWorkingSetBytes);
    expect(executionMaxmemBytes).toBeGreaterThan(maxWorkingSetBytes);
    // And production parameters must pass the acceptance policy unchanged.
    expect(() => assertWithinLimits(2 ** 18, 8, 1)).not.toThrow();
  });

  it('round-trips a keystore at the CLI production parameters', async () => {
    // Must go through encryptKeystore/decryptKeystore — i.e. through deriveKey —
    // or it proves nothing. A direct scryptSync call using the policy constant
    // passes even when deriveKey ignores that constant, which is precisely the
    // divergence that shipped. Allocates the real 256 MiB production working
    // set once; the suite otherwise runs at N=2**15 to stay parallel-safe.
    _setScryptN(2 ** 18);
    try {
      const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
      expect(ks.crypto.kdfparams.n).toBe(2 ** 18);
      expect(await decryptKeystore(ks, PASSPHRASE)).toBe(TEST_KEY);
    } finally {
      _setScryptN(2 ** 15);
    }
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
