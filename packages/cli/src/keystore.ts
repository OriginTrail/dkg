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
const MIN_SCRYPT_N = 2 ** 15;
const MIN_SCRYPT_R = 8;
const MIN_SCRYPT_P = 1;
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_SCRYPT_P = 16;
const MIN_SALT_BYTES = 16;

/** @internal Allow tests to use lighter scrypt params to avoid memory limits */
export function _setScryptN(n: number) {
  const estimatedMemoryBytes = 128 * n * SCRYPT_R;
  if (!Number.isSafeInteger(n) || !isPowerOfTwo(n) || n < MIN_SCRYPT_N || estimatedMemoryBytes > MAX_SCRYPT_MEMORY_BYTES) {
    throw new Error('Unsupported scrypt N for keystore encryption');
  }
  SCRYPT_N = n;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && Number.isInteger(Math.log2(value));
}

function assertSafeKdfParams(kdfparams: EncryptedKeystore['crypto']['kdfparams']): void {
  if (!Number.isSafeInteger(kdfparams.n) || !isPowerOfTwo(kdfparams.n) || kdfparams.n < MIN_SCRYPT_N) {
    throw new Error('KDF parameters below minimum: scrypt N too low');
  }
  if (!Number.isSafeInteger(kdfparams.r) || kdfparams.r < MIN_SCRYPT_R) {
    throw new Error('KDF parameters below minimum: scrypt r too low');
  }
  if (!Number.isSafeInteger(kdfparams.p) || kdfparams.p < MIN_SCRYPT_P) {
    throw new Error('KDF parameters below minimum: scrypt p too low');
  }
  const estimatedMemoryBytes = 128 * kdfparams.n * kdfparams.r;
  if (!Number.isSafeInteger(estimatedMemoryBytes) || estimatedMemoryBytes > MAX_SCRYPT_MEMORY_BYTES) {
    throw new Error('Unsupported keystore KDF parameters: scrypt memory cost too high');
  }
  if (kdfparams.p > MAX_SCRYPT_P) {
    throw new Error('Unsupported keystore KDF parameters: scrypt p too high');
  }
  if (kdfparams.dklen !== DKLEN) {
    throw new Error(`Invalid dklen: dklen must be ${DKLEN}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(kdfparams.salt) || kdfparams.salt.length % 2 !== 0 || kdfparams.salt.length < MIN_SALT_BYTES * 2) {
    throw new Error(`KDF parameters below minimum: salt too short (minimum ${MIN_SALT_BYTES} bytes)`);
  }
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: Pick<EncryptedKeystore['crypto']['kdfparams'], 'n' | 'r' | 'p' | 'dklen'>,
): Buffer {
  return scryptSync(passphrase, salt, DKLEN, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export async function encryptKeystore(
  privateKeyHex: string,
  passphrase: string,
): Promise<EncryptedKeystore> {
  const salt = randomBytes(32);
  const key = deriveKey(passphrase, salt, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dklen: DKLEN,
  });
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
  assertSafeKdfParams(kdfparams);
  const salt = Buffer.from(kdfparams.salt, 'hex');
  const key = deriveKey(passphrase, salt, kdfparams);

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
