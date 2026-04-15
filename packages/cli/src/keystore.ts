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

/** @internal Allow tests to use lighter scrypt params to avoid memory limits */
export function _setScryptN(n: number) { SCRYPT_N = n; }

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
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
  const salt = Buffer.from(kdfparams.salt, 'hex');
  const key = deriveKey(passphrase, salt);

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
