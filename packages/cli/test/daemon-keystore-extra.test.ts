/**
 * Extra keystore hardening tests.
 *
 * Covers audit findings from `.test-audit/BUGS_FOUND.md` → `packages/cli (BURA)`:
 *   - CLI-1  (CRITICAL, dup #11) — scrypt KDF parameter floor is not enforced.
 *     A keystore file with dangerously weak N/r/p parameters loads successfully,
 *     defeating the whole point of scrypt memory-hardness.
 *
 * The existing `keystore.test.ts` only covers the happy path (encrypt → decrypt,
 * wrong passphrase throws, wire format stability). It has no negative tests for
 * parameter choice. This file adds those.
 *
 * NOTE (PROD-BUG): as of audit, `decryptKeystore` reads `kdfparams.n / r / p`
 * verbatim and derives the key with whatever values the (untrusted) keystore
 * file provides. There is no minimum-cost gate. Until a floor check lands in
 * `src/keystore.ts`, the "refuse weak" assertions stay RED — see
 * `.test-audit/BUGS_FOUND.md` CLI-1 (dup of open issue #11).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  encryptKeystore,
  decryptKeystore,
  isEncryptedKeystore,
  _setScryptN,
  type EncryptedKeystore,
} from '../src/keystore.js';

const PRIVKEY = 'deadbeef'.repeat(8); // 32 bytes
const PASSPHRASE = 'correct horse battery staple';

// scrypt N must be a power of two; 2**15 is the existing production floor for
// the non-test code path — 2**18 is the real prod value, lowered via `_setScryptN`
// for tests to avoid OOM on small CI workers.
const SAFE_N = 2 ** 15;

// Weak params. If the decrypt path does not floor-check, these still "work".
const WEAK_N = 2 ** 8; // toy value
const WEAK_R = 1;
const WEAK_P = 1;

afterEach(() => {
  // Restore test-friendly N so subsequent tests in this file don't pay the
  // 128 MB prod cost.
  _setScryptN(SAFE_N);
});

function withKdfParams(
  ks: EncryptedKeystore,
  overrides: Partial<EncryptedKeystore['crypto']['kdfparams']>,
): EncryptedKeystore {
  return {
    ...ks,
    crypto: {
      ...ks.crypto,
      kdfparams: { ...ks.crypto.kdfparams, ...overrides },
    },
  };
}

describe('keystore wire format is stable', () => {
  it('emits a V1 keystore that type-guards as EncryptedKeystore', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);
    expect(isEncryptedKeystore(ks)).toBe(true);
    expect(ks.version).toBe(1);
    expect(ks.crypto.cipher).toBe('aes-256-gcm');
    expect(ks.crypto.kdf).toBe('scrypt');
    expect(ks.crypto.kdfparams.dklen).toBe(32);
    // Salt, iv, tag are hex strings of the expected lengths
    expect(ks.crypto.kdfparams.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(ks.crypto.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(ks.crypto.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(ks.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('CLI-1 — scrypt KDF parameter floor (PROD-BUG: not enforced)', () => {
  it('refuses to decrypt a keystore whose advertised N is below 2**15 (minimum scrypt cost)', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);

    await expect(() => _setScryptN(WEAK_N)).toThrow(/Unsupported scrypt N/);

    // Sanity: the "strong" keystore is rejected if we lie about its N.
    // The loader should fail at KDF validation before attempting GCM.
    await expect(
      decryptKeystore(withKdfParams(ks, { n: WEAK_N }), PASSPHRASE),
    ).rejects.toThrow(/KDF parameters below minimum|scrypt N too low|weak keystore/i);

    await expect(decryptKeystore(withKdfParams(ks, { n: WEAK_N }), PASSPHRASE)).rejects.toThrow(
      /KDF parameters below minimum|scrypt cost too low|weak keystore/i,
    );
  });

  it('refuses to decrypt a keystore whose r factor is below 8 (memory-hardness)', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);

    // We cannot actually re-derive with r=1 via the public API (r is fixed
    // at 8 in the module), but an attacker could hand-craft such a file.
    // Assert that the loader refuses it BEFORE attempting a derive — a
    // correct implementation rejects at the kdfparams validation step and
    // never calls scryptSync with a pathological r.
    const tampered = withKdfParams(ks, { r: WEAK_R });

    // PROD-BUG: decryptKeystore has no param-floor check, so it simply
    // re-derives with r=1, gets the wrong key, and throws the generic
    // "Decryption failed — wrong passphrase or corrupted keystore" error.
    // That's the wrong error *class*: the true reason is "unsafe KDF
    // parameters", and the file should be rejected up-front.
    await expect(decryptKeystore(tampered, PASSPHRASE)).rejects.toThrow(
      /KDF parameters below minimum|scrypt r too low|weak keystore/i,
    );
  });

  it('refuses to decrypt a keystore whose p factor is below 1 (parallelism floor)', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);

    // p=0 is definitionally nonsense — but the loader currently passes it
    // straight through to scryptSync, which throws a low-level
    // ERR_OUT_OF_RANGE from Node's OpenSSL binding. The loader should
    // catch and replace that with a clear "weak keystore" error.
    const tampered = withKdfParams(ks, { p: 0 });

    await expect(decryptKeystore(tampered, PASSPHRASE)).rejects.toThrow(
      /KDF parameters below minimum|scrypt p too low|weak keystore/i,
    );
  });

  it('refuses KDF parameters above the supported envelope before calling scrypt', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);

    await expect(decryptKeystore(withKdfParams(ks, { n: 2 ** 30 }), PASSPHRASE))
      .rejects.toThrow(/memory cost too high|unsupported keystore/i);
    await expect(decryptKeystore(withKdfParams(ks, { r: 65 }), PASSPHRASE))
      .rejects.toThrow(/memory cost too high|unsupported keystore/i);
    await expect(decryptKeystore(withKdfParams(ks, { p: 64 }), PASSPHRASE))
      .rejects.toThrow(/scrypt p too high|unsupported keystore/i);
  });

  it('refuses to decrypt a keystore with a short salt (<16 bytes)', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);
    // 8 zero bytes — eligible for precomputed rainbow attacks.
    const tampered = withKdfParams(ks, { salt: '00'.repeat(8) });

    // PROD-BUG (dup #11): the loader currently happily derives from any
    // salt length and lets GCM decide if the plaintext matches. A weak
    // salt should be rejected up front.
    await expect(decryptKeystore(tampered, PASSPHRASE)).rejects.toThrow(
      /salt too short|weak keystore|KDF parameters below minimum/i,
    );
  });

  it('refuses to decrypt a keystore with a wrong dklen (must equal 32 for AES-256)', async () => {
    _setScryptN(SAFE_N);
    const ks = await encryptKeystore(PRIVKEY, PASSPHRASE);
    const tampered = withKdfParams(ks, { dklen: 16 });

    // A dklen != 32 is structurally incompatible with aes-256-gcm and
    // should produce a crisp validation error (NOT a generic "Decryption
    // failed" after a silent key-length mismatch).
    await expect(decryptKeystore(tampered, PASSPHRASE)).rejects.toThrow(
      /dklen must be 32|invalid dklen|weak keystore/i,
    );
  });
});

describe('isEncryptedKeystore — structural guard', () => {
  it('rejects objects that look keystore-shaped but are not version 1', () => {
    expect(isEncryptedKeystore({ version: 2, crypto: {} })).toBe(false);
    expect(isEncryptedKeystore({ version: 'v1', crypto: {} })).toBe(false);
    expect(isEncryptedKeystore(null)).toBe(false);
    expect(isEncryptedKeystore('keystore')).toBe(false);
  });

  it('accepts the canonical shape', () => {
    expect(
      isEncryptedKeystore({
        version: 1,
        crypto: { cipher: 'aes-256-gcm' },
        id: 'x',
      }),
    ).toBe(true);
  });
});
