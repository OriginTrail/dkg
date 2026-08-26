import { describe, it, expect, beforeAll } from 'vitest';
import {
  encryptKeystore,
  decryptKeystore,
  isEncryptedKeystore,
  _setScryptN,
  SCRYPT_KDF_POLICY,
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
  _setScryptN(SCRYPT_KDF_POLICY.minN);
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
    const { maxWorkingSetBytes } = SCRYPT_KDF_POLICY;
    const workingSetBytes = SCRYPT_KDF_POLICY.workingSetBytes.bind(SCRYPT_KDF_POLICY);
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
    // Cheap acceptance-policy half: dklen is validated after the cost policy,
    // so an invalid dklen stops execution before scrypt. The error text
    // discriminates — a memory rejection would name the cost. The execution
    // half — that OpenSSL actually serves this cost — is the test below.
    const { maxWorkingSetBytes } = SCRYPT_KDF_POLICY;
    const workingSetBytes = SCRYPT_KDF_POLICY.workingSetBytes.bind(SCRYPT_KDF_POLICY);
    const atN = maxWorkingSetBytes / (128 * 8);
    expect(workingSetBytes(atN, 8)).toBe(maxWorkingSetBytes);
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.n = atN;
    ks.crypto.kdfparams.r = 8;
    ks.crypto.kdfparams.dklen = 16;
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(/dklen/);
  });

  it('executes real scrypt at the exact accepted ceiling', async () => {
    // The policy promises every accepted cost is executable; this reaches
    // OpenSSL at the maximum accepted working set. The keystore is encrypted
    // cheaply, then re-advertises the at-ceiling parameters: derivation now
    // produces a WRONG key, so reaching the AES tag check ("Decryption
    // failed") proves scrypt ran the full 512 MiB cost under
    // `executionMaxmemBytes`. An insufficient overhead allowance fails
    // differently and fails this test — OpenSSL raises
    // ERR_CRYPTO_INVALID_SCRYPT_PARAMS before any key exists. One expensive
    // derivation total; vitest runs same-file tests serially, so the
    // allocation never overlaps the production round-trip below.
    const { maxWorkingSetBytes } = SCRYPT_KDF_POLICY;
    const atN = maxWorkingSetBytes / (128 * 8);
    const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
    ks.crypto.kdfparams.n = atN;
    ks.crypto.kdfparams.r = 8;
    await expect(decryptKeystore(ks, PASSPHRASE)).rejects.toThrow(/Decryption failed/);
  }, 120000);

  it('pins the intended ceilings as literals, independent of the implementation', () => {
    // Every other assertion reads the policy object; if the object itself
    // drifted (512 MiB quietly becoming 512 GiB), those would follow it.
    // These are the review-approved numbers, restated as literals.
    expect(SCRYPT_KDF_POLICY.maxWorkingSetBytes).toBe(512 * 1024 * 1024);
    expect(SCRYPT_KDF_POLICY.maxP).toBe(16);
    expect(SCRYPT_KDF_POLICY.production).toEqual({ n: 2 ** 18, r: 8, p: 1 });
    expect(SCRYPT_KDF_POLICY.minN).toBe(2 ** 15);
  });

  it('accepts p at the ceiling and rejects p one above it', async () => {
    const { maxP } = SCRYPT_KDF_POLICY;
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

  it('budgets enough memory for the production parameters to actually derive', async () => {
    // The regression this pins shipped: `deriveKey` passed a hardcoded maxmem of
    // 256 MiB while production N=2**18, r=8 needs a working set of exactly
    // 256 MiB, and OpenSSL bounds `workingSet + overhead <= maxmem` — so the
    // module's own parameters failed with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
    // The suite lowers N, so no round-trip test could catch it; this asserts
    // the policy arithmetic, which is where the bug lived. All values come from
    // the ONE production-consumed policy object — there is no separate
    // test-facing copy left to drift.
    const { production, executionMaxmemBytes, maxWorkingSetBytes } = SCRYPT_KDF_POLICY;
    const productionWorkingSet = SCRYPT_KDF_POLICY.workingSetBytes(production.n, production.r);
    expect(productionWorkingSet).toBeLessThanOrEqual(maxWorkingSetBytes);
    // Strictly greater: equality is exactly what OpenSSL rejects.
    expect(executionMaxmemBytes).toBeGreaterThan(productionWorkingSet);
    expect(executionMaxmemBytes).toBeGreaterThan(maxWorkingSetBytes);
    // And production parameters must pass the acceptance policy unchanged.
    expect(() =>
      SCRYPT_KDF_POLICY.assertCostWithinLimits(production.n, production.r, production.p),
    ).not.toThrow();
  });

  it('round-trips a keystore at the production parameters the policy declares', async () => {
    // Must go through encryptKeystore/decryptKeystore — i.e. through deriveKey —
    // or it proves nothing: a direct scryptSync call using the policy constant
    // passes even when deriveKey ignores that constant, which is precisely the
    // divergence that shipped. Restoring the override to the POLICY's production
    // N (not a literal) also pins that encryption cannot emit a different
    // production value than the policy reports: the emitted kdfparams must
    // equal SCRYPT_KDF_POLICY.production exactly. Allocates the real 256 MiB
    // working set once; the suite otherwise runs at minN to stay parallel-safe.
    _setScryptN(SCRYPT_KDF_POLICY.production.n);
    try {
      const ks = await encryptKeystore(TEST_KEY, PASSPHRASE);
      expect(ks.crypto.kdfparams.n).toBe(SCRYPT_KDF_POLICY.production.n);
      expect(ks.crypto.kdfparams.r).toBe(SCRYPT_KDF_POLICY.production.r);
      expect(ks.crypto.kdfparams.p).toBe(SCRYPT_KDF_POLICY.production.p);
      expect(await decryptKeystore(ks, PASSPHRASE)).toBe(TEST_KEY);
    } finally {
      _setScryptN(SCRYPT_KDF_POLICY.minN);
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
