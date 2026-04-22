/**
 * Encrypted keystore for DKG node private keys.
 *
 * Encrypts key material at rest using AES-256-GCM with a key derived from a
 * user passphrase via scrypt. Compatible with the Ethereum keystore V3 pattern
 * but simplified for our use case.
 *
 * Usage:
 *   const ks = await encryptKeystore(privateKeyHex, passphrase);
 *   await writeFile('keystore.json', JSON.stringify(ks));
 *   ...
 *   const key = await decryptKeystore(ks, passphrase);
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

export interface EncryptedKeystore {
  version: 1;
  crypto: {
    cipher: 'aes-256-gcm';
    ciphertext: string;
    iv: string;
    tag: string;
    kdf: 'scrypt';
    kdfparams: {
      n: number;
      r: number;
      p: number;
      dklen: number;
      salt: string;
    };
  };
  /** Hex-encoded SHA-256 of the derived key, used for quick passphrase validation. */
  id: string;
}

let SCRYPT_N = 2 ** 18;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DKLEN = 32;

/**
 * CLI-1 (BUGS_FOUND.md dup #11): floor values that `decryptKeystore`
 * MUST enforce on the (untrusted) `kdfparams` block before deriving
 * a key. Without these, an attacker who can write a keystore file
 * can advertise toy scrypt parameters (e.g. N=256, r=1) and force the
 * loader to brute-force in O(1). Production scrypt minimums per
 * draft RFC and OWASP cheat-sheet:
 *   - N ≥ 2^15 (32 768 iterations) — production floor
 *   - r ≥ 8                          — memory-hardness factor
 *   - p ≥ 1                          — parallelism floor
 *   - dklen == 32                    — exact match for AES-256-GCM
 *   - salt ≥ 16 bytes                — defeats precomputed rainbow
 */
const MIN_SCRYPT_N = 2 ** 15;
const MIN_SCRYPT_R = 8;
const MIN_SCRYPT_P = 1;
const REQUIRED_DKLEN = 32;
const MIN_SALT_BYTES = 16;

/** @internal Allow tests to use lighter scrypt params to avoid memory limits */
export function _setScryptN(n: number) { SCRYPT_N = n; }

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params?: { N?: number; r?: number; p?: number; dklen?: number },
): Buffer {
  return scryptSync(passphrase, salt, params?.dklen ?? DKLEN, {
    N: params?.N ?? SCRYPT_N,
    r: params?.r ?? SCRYPT_R,
    p: params?.p ?? SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
}

export async function encryptKeystore(
  privateKeyHex: string,
  passphrase: string,
): Promise<EncryptedKeystore> {
  const salt = randomBytes(32);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(privateKeyHex, 'hex');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);

  return {
    version: 1,
    crypto: {
      cipher: 'aes-256-gcm',
      ciphertext: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      kdf: 'scrypt',
      kdfparams: {
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        dklen: DKLEN,
        salt: salt.toString('hex'),
      },
    },
    id,
  };
}

export async function decryptKeystore(
  keystore: EncryptedKeystore,
  passphrase: string,
): Promise<string> {
  if (keystore.version !== 1) {
    throw new Error(`Unsupported keystore version: ${keystore.version}`);
  }

  const { kdfparams } = keystore.crypto;

  // CLI-1 (BUGS_FOUND.md dup #11): enforce KDF parameter floor BEFORE
  // calling scryptSync. Previously, weak params either (a) produced a
  // generic "Decryption failed" (because `deriveKey` always re-derived
  // with the global SCRYPT_N regardless of what the file advertised —
  // a related bug) or (b) handed pathological values to OpenSSL and
  // crashed with ERR_OUT_OF_RANGE. Either way the operator had no way
  // to know the keystore was forged with an attackable cost factor.
  // We now reject up-front with a crisp "weak keystore" error so the
  // caller can refuse to load the file instead of silently accepting
  // a downgraded KDF.
  if (typeof kdfparams.n !== "number" || kdfparams.n < MIN_SCRYPT_N) {
    throw new Error(
      `Refusing to load weak keystore: KDF parameters below minimum (n=${kdfparams.n} < ${MIN_SCRYPT_N}). scrypt cost too low.`,
    );
  }
  if (typeof kdfparams.r !== "number" || kdfparams.r < MIN_SCRYPT_R) {
    throw new Error(
      `Refusing to load weak keystore: KDF parameters below minimum (r=${kdfparams.r} < ${MIN_SCRYPT_R}). scrypt r too low.`,
    );
  }
  if (typeof kdfparams.p !== "number" || kdfparams.p < MIN_SCRYPT_P) {
    throw new Error(
      `Refusing to load weak keystore: KDF parameters below minimum (p=${kdfparams.p} < ${MIN_SCRYPT_P}). scrypt p too low.`,
    );
  }
  if (kdfparams.dklen !== REQUIRED_DKLEN) {
    throw new Error(
      `Refusing to load weak keystore: dklen must be ${REQUIRED_DKLEN} for AES-256-GCM (got ${kdfparams.dklen}). invalid dklen.`,
    );
  }
  if (
    typeof kdfparams.salt !== "string" ||
    !/^[0-9a-f]*$/i.test(kdfparams.salt) ||
    kdfparams.salt.length / 2 < MIN_SALT_BYTES
  ) {
    throw new Error(
      `Refusing to load weak keystore: salt too short (${kdfparams.salt.length / 2} bytes < ${MIN_SALT_BYTES}). weak keystore.`,
    );
  }

  const salt = Buffer.from(kdfparams.salt, 'hex');
  // Derive with the params actually advertised by the file (now that
  // we've gated them above). The previous code ignored kdfparams and
  // always used the global SCRYPT_N, which was both a correctness bug
  // (any keystore with N != SCRYPT_N would fail to decrypt even with
  // the right passphrase) and the reason a weak-N keystore returned
  // "Decryption failed" instead of "weak keystore".
  const key = deriveKey(passphrase, salt, {
    N: kdfparams.n,
    r: kdfparams.r,
    p: kdfparams.p,
    dklen: kdfparams.dklen,
  });

  const iv = Buffer.from(keystore.crypto.iv, 'hex');
  const tag = Buffer.from(keystore.crypto.tag, 'hex');
  const ciphertext = Buffer.from(keystore.crypto.ciphertext, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('hex');
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupted keystore');
  }
}

export function isEncryptedKeystore(obj: unknown): obj is EncryptedKeystore {
  if (!obj || typeof obj !== 'object') return false;
  const ks = obj as Record<string, unknown>;
  return ks.version === 1 && typeof ks.crypto === 'object' && ks.crypto !== null;
}
