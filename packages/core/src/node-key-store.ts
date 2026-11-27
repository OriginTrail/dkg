// SPDX-License-Identifier: Apache-2.0

/**
 * How the node keeps private keys at rest: the operational wallets' keys in
 * `wallets.json`, and any other key it holds, such as the marketplace's session
 * keys (GH #11).
 *
 * A key is encrypted with AES-256-GCM under a machine-local 32-byte secret in
 * `wallets.key` in the node's data directory, made on first use with mode 0600
 * (no operator interaction). When `DKG_WALLETS_PASSPHRASE` is set, it is mixed
 * in through scrypt as a second factor against a compromised host file system,
 * and a key sealed so opens only with it.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const NODE_KEY_SECRET_FILE = 'wallets.key';
export const NODE_KEY_PASSPHRASE_ENV = 'DKG_WALLETS_PASSPHRASE';

/** One sealed key, as `wallets.json` stores it in an entry's `keystore`. */
export interface NodeKeystore {
  v: number;
  alg: 'aes-256-gcm';
  kdf: 'raw' | 'scrypt';
  iv: string;
  ct: string;
  tag: string;
}

/** The 32-byte AES key: the raw machine-local secret, optionally strengthened with a scrypt pass over the passphrase. */
function deriveAtRestKey(secret: Buffer, kdf: 'raw' | 'scrypt', passphrase?: string): Buffer {
  if (kdf === 'scrypt') {
    if (!passphrase) {
      throw new Error(`${NODE_KEY_PASSPHRASE_ENV} is required to derive the wallet key for a passphrase-protected keystore`);
    }
    return scryptSync(passphrase, secret, 32, { N: 16384, r: 8, p: 1 });
  }
  return secret;
}

/** Seal `privateKey` under `secret`, and under `passphrase` when one is given. */
export function sealNodeKey(privateKey: string, secret: Buffer, passphrase?: string): NodeKeystore {
  const kdf: 'raw' | 'scrypt' = passphrase ? 'scrypt' : 'raw';
  const key = deriveAtRestKey(secret, kdf, passphrase);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    kdf,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Open a sealed key; one sealed with the passphrase needs `DKG_WALLETS_PASSPHRASE` set to it. */
export function openNodeKey(keystore: NodeKeystore, secret: Buffer): string {
  const passphrase = process.env[NODE_KEY_PASSPHRASE_ENV];
  if (keystore.kdf === 'scrypt' && !passphrase) {
    throw new Error(
      `wallet keystore was encrypted with ${NODE_KEY_PASSPHRASE_ENV} which is not currently set — refusing to decrypt`,
    );
  }
  const key = deriveAtRestKey(secret, keystore.kdf, passphrase);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(keystore.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(keystore.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(keystore.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** The machine-local secret in `dataDir`, or undefined when there is none. */
export async function readNodeKeySecret(dataDir: string): Promise<Buffer | undefined> {
  try {
    const raw = await readFile(join(dataDir, NODE_KEY_SECRET_FILE), 'utf-8');
    const buf = Buffer.from(raw.trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error(`${NODE_KEY_SECRET_FILE} is malformed (expected a 32-byte base64 secret)`);
    }
    return buf;
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * The machine-local secret in `dataDir`, made (32 random bytes, mode 0600)
 * when there is none. It is independent of any key it seals, so it never
 * leaks one.
 */
export async function nodeKeySecret(dataDir: string): Promise<Buffer> {
  const existing = await readNodeKeySecret(dataDir);
  if (existing) return existing;
  await mkdir(dataDir, { recursive: true });
  const secret = randomBytes(32);
  const secretPath = join(dataDir, NODE_KEY_SECRET_FILE);
  try {
    // Exclusive create: a secret another writer made first is never replaced, so nothing sealed under it is lost.
    await writeFile(secretPath, secret.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
    return (await readNodeKeySecret(dataDir))!;
  }
  await chmod(secretPath, 0o600);
  return secret;
}
