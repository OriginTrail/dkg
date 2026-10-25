/**
 * Buyer session-key lifecycle. A session key is an ordinary secp256k1 key the
 * buyer registers on-chain (`fundSubscription`) and uses to sign bounded,
 * seller-specific request authorizations off-chain; the contract `ecrecover`s
 * every claim against the registered key. The key is generated from
 * `node:crypto randomBytes(32)` and ALWAYS persisted by the caller —
 * `Wallet.createRandom` is banned repo-wide (`scripts/audit-create-random.mjs`)
 * because an unpersisted random signing key is unrecoverable.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBytes, hexlify, Wallet } from 'ethers';
import { computeAuthDigest } from './digests.js';
import type { AuthorizationFields, BoundedAuthorization, SessionKeyRecord } from './types.js';

/** Generate a fresh session key; the caller MUST persist the record. */
export function createSessionKey(now: () => number = Date.now): SessionKeyRecord {
  const wallet = new Wallet(hexlify(randomBytes(32)));
  return {
    privateKey: wallet.privateKey,
    address: wallet.address,
    createdAt: new Date(now()).toISOString(),
  };
}

/** Serialize a session key record to its persisted JSON form. */
export function serializeSessionKey(record: SessionKeyRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Parse and validate a persisted session key. The address is recomputed from
 * the private key and must match, so a corrupted or hand-edited file can never
 * silently sign as a different registered key.
 */
export function parseSessionKey(json: string): SessionKeyRecord {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('session key file must contain a JSON object');
  }
  const { privateKey, address, createdAt } = parsed as Record<string, unknown>;
  if (typeof privateKey !== 'string' || typeof address !== 'string' || typeof createdAt !== 'string') {
    throw new Error('session key file must contain { privateKey, address, createdAt } strings');
  }
  const wallet = new Wallet(privateKey);
  if (wallet.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`session key address mismatch: stored ${address}, derived ${wallet.address}`);
  }
  return { privateKey: wallet.privateKey, address: wallet.address, createdAt };
}

/**
 * Persist a session key record (0o600 — it contains a private key).
 * Atomic: written to a same-directory temp file and renamed into place, so a
 * crash mid-write can never leave a truncated key file where a registered
 * key used to be (a load failure would otherwise strand the on-chain bucket).
 */
export function persistSessionKey(filePath: string, record: SessionKeyRecord): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, serializeSessionKey(record), { mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/** Load and validate a persisted session key record. */
export function loadSessionKey(filePath: string): SessionKeyRecord {
  return parseSessionKey(fs.readFileSync(filePath, 'utf8'));
}

/** The signing wallet for a session key record. */
export function sessionKeyWallet(record: SessionKeyRecord): Wallet {
  return new Wallet(record.privateKey);
}

/**
 * Sign a bounded authorization with the session key: compute the auth digest
 * and EIP-191 personal-sign its raw 32 bytes (what the contract recovers).
 */
export async function signAuthorization(
  sessionKey: SessionKeyRecord,
  fields: AuthorizationFields,
): Promise<BoundedAuthorization> {
  const authDigest = computeAuthDigest(fields);
  const signature = await sessionKeyWallet(sessionKey).signMessage(getBytes(authDigest));
  return { ...fields, authDigest, signature };
}
