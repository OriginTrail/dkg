import { ethers } from 'ethers';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

export interface WalletEntry {
  address: string;
  privateKey: string;
}

export interface OpWalletsConfig {
  /** Administrative wallet used for profile/key-management transactions. */
  adminWallet?: WalletEntry;
  /** Hot operational wallets used for node operations and publishing. */
  wallets: WalletEntry[];
}

const DEFAULT_WALLET_COUNT = 3;

// GH #11 — operational wallet private keys are encrypted at rest (AES-256-GCM)
// so `wallets.json` never carries a plaintext key. The key is derived from a
// machine-local 32-byte secret in `wallets.key` (zero operator interaction);
// when `DKG_WALLETS_PASSPHRASE` is set it is mixed in via scrypt for an extra
// factor against host-FS compromise. `address` stays plaintext so every
// address-only reader (faucet, openclaw setup, status) keeps working, and
// `loadOpWallets` still returns decrypted keys in memory for the chain config.
const WALLET_SECRET_FILE = 'wallets.key';
const PASSPHRASE_ENV = 'DKG_WALLETS_PASSPHRASE';
// Test-only escape hatch: skip the legacy-plaintext→encrypted migration on load.
// Set by harnesses/tooling that read the raw `privateKey` field out of
// wallets.json directly and cannot decrypt (e.g. the devnet staking script).
const NO_MIGRATE_ENV = 'DKG_WALLETS_NO_MIGRATE';

interface EncryptedKeystore {
  v: number;
  alg: 'aes-256-gcm';
  kdf: 'raw' | 'scrypt';
  iv: string;
  ct: string;
  tag: string;
}

interface StoredWalletEntry {
  address: string;
  privateKey?: string;
  keystore?: EncryptedKeystore;
}

/**
 * Load admin + operational wallets from `wallets.json` in the data directory.
 * Legacy files without `adminWallet` remain readable, but profile
 * key-management/repair features need the real admin key to be added.
 * If the file doesn't exist, generates one admin wallet plus `count`
 * operational wallets and saves them.
 * The file is human-readable JSON — users can add/remove/replace keys
 * (e.g. import into MetaMask, replace admin with a hardware-wallet-backed key,
 * etc.).
 */
export async function loadOpWallets(
  dataDir: string,
  count: number = DEFAULT_WALLET_COUNT,
): Promise<OpWalletsConfig> {
  const filePath = join(dataDir, 'wallets.json');

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { adminWallet?: StoredWalletEntry; wallets?: StoredWalletEntry[] } | StoredWalletEntry[];
    const existingWallets = Array.isArray(parsed) ? parsed : parsed.wallets;
    if (!Array.isArray(existingWallets)) {
      throw new Error('wallets.json must contain a wallets array');
    }
    if (existingWallets.length === 0) {
      throw new Error('wallets.json must contain at least one operational wallet');
    }

    {
      const adminStored = !Array.isArray(parsed) ? parsed.adminWallet : undefined;
      // Decrypt any keystore entries before validating addresses. The secret is
      // only required when at least one entry is encrypted; legacy plaintext
      // files load with no secret and are opportunistically re-encrypted below.
      const hasEncrypted = existingWallets.some(isEncryptedEntry)
        || (adminStored ? isEncryptedEntry(adminStored) : false);
      const secret = hasEncrypted ? await loadWalletSecret(dataDir) : undefined;
      if (hasEncrypted && !secret) {
        throw new Error(
          `wallets.json holds encrypted wallet keystores but ${WALLET_SECRET_FILE} is missing — cannot decrypt. ` +
            `Restore ${WALLET_SECRET_FILE} (or set ${PASSPHRASE_ENV} if it was passphrase-protected) from backup.`,
        );
      }

      let sawLegacyPlaintext = false;
      const resolve = (stored: StoredWalletEntry, path: string): WalletEntry => {
        if (isEncryptedEntry(stored)) {
          const privateKey = decryptKey(stored.keystore!, secret!);
          return validateWalletEntry({ address: stored.address, privateKey }, path);
        }
        // Legacy plaintext entry — accepted (back-compat), and flagged for
        // opportunistic migration to an encrypted keystore below.
        // GH#1432 — an entry with NEITHER `keystore` nor `privateKey` lands
        // here too (isEncryptedEntry only tests `keystore`), and the old
        // cast handed `undefined` straight to ethers. Only count it as legacy
        // plaintext once we know a key is actually present; anything present
        // but malformed goes to validateWalletEntry, which lets ethers judge it
        // and reports the entry path.
        if (stored.privateKey === undefined || stored.privateKey === null || stored.privateKey === '') {
          // PR #2332 review — do NOT promise provisioning. `loadOpWallets` never
          // replenishes an entry in an existing file: deleting one just leaves
          // fewer wallets, and deleting `adminWallet` leaves it undefined.
          // Say what actually happens, and say it differently for the two cases.
          const consequence =
            path === 'adminWallet'
              ? 'Removing it leaves the node with no admin wallet; it is NOT regenerated on load. ' +
                'Restore the key from backup, or remove the entry deliberately and re-provision ' +
                'the admin wallet with the documented procedure.'
              : 'Removing it leaves the node with one fewer operational wallet; a replacement is ' +
                'NOT provisioned on load. Restore the key from backup, or remove the entry ' +
                'deliberately, accepting the reduced wallet count.';
          throw new Error(
            `Operational wallet at ${path} in wallets.json has no key: it carries neither an ` +
              `encrypted \`keystore\` nor a plaintext \`privateKey\`. ${consequence}`,
          );
        }
        sawLegacyPlaintext = true;
        // A present-but-malformed key falls through to validateWalletEntry, which
        // reports the specific defect (wrong type / wrong length) rather than the
        // generic "no key" above.
        return validateWalletEntry({ address: stored.address, privateKey: stored.privateKey }, path);
      };

      const wallets = existingWallets.map((w, index) => resolve(w, `wallets[${index}]`));
      const adminWallet = adminStored ? resolve(adminStored, 'adminWallet') : undefined;

      if (adminWallet) {
        const adminKey = adminWallet.address.toLowerCase();
        for (const wallet of wallets) {
          if (wallet.address.toLowerCase() === adminKey) {
            throw new Error('adminWallet in wallets.json must be distinct from operational wallets');
          }
        }
      }

      const config = { adminWallet, wallets };
      // GH #11 migration — an upgraded node that still has a LEGACY plaintext
      // wallets.json (the deployed wallets most likely to hold real funds) gets
      // its keys transparently re-saved as encrypted keystores after a
      // successful load (same keys, same addresses — no rotation, no lockout).
      // This closes the plaintext-at-rest exposure for existing operators, not
      // just fresh installs. Opt OUT via `DKG_WALLETS_NO_MIGRATE=1` for test
      // harnesses / provisioning tooling that reads the raw `privateKey` field
      // directly (e.g. the devnet staking script) and cannot decrypt. The
      // re-save is best-effort: a write failure must not block loading.
      if (sawLegacyPlaintext && process.env[NO_MIGRATE_ENV] !== '1') {
        try {
          await saveOpWallets(dataDir, config);
        } catch {
          /* keep serving the loaded keys even if the migration re-save fails */
        }
      }
      return config;
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  const config = generateWallets(count);
  await saveOpWallets(dataDir, config);
  return config;
}

export function generateWallets(count: number): OpWalletsConfig {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('wallet count must be at least 1');
  }
  const adminWallet = createWalletEntry();
  const wallets: WalletEntry[] = [];
  for (let i = 0; i < count; i++) {
    wallets.push(createWalletEntry());
  }
  return { adminWallet, wallets };
}

async function saveOpWallets(dataDir: string, config: OpWalletsConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const secret = await loadOrCreateWalletSecret(dataDir);
  const passphrase = process.env[PASSPHRASE_ENV];
  const encEntry = (w: WalletEntry): StoredWalletEntry => ({
    address: w.address,
    keystore: encryptKey(w.privateKey, secret, passphrase),
  });
  const stored: { adminWallet?: StoredWalletEntry; wallets: StoredWalletEntry[] } = {
    ...(config.adminWallet ? { adminWallet: encEntry(config.adminWallet) } : {}),
    wallets: config.wallets.map(encEntry),
  };
  const filePath = join(dataDir, 'wallets.json');
  await writeFile(filePath, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function createWalletEntry(): WalletEntry {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

/**
 * Describe a rejected key WITHOUT revealing it.
 *
 * PR #2332 review — an earlier version kept a local regex copy of ethers'
 * private-key grammar. That duplicated a dependency-owned contract for the
 * sake of an error message: it already had to be widened once when ethers
 * turned out to accept bare hex, and it still admitted values ethers rejects
 * (all-zero, or a scalar at/above the secp256k1 order). `ethers.Wallet` stays
 * the canonical validator; this only supplies the context its error lacks.
 */
function describeRejectedKey(value: unknown): string {
  if (value === undefined || value === null) return 'is missing';
  if (typeof value !== 'string') return `is a ${typeof value}, not a string`;
  if (value.length === 0) return 'is empty';
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(hex)) return 'contains non-hexadecimal characters';
  if (hex.length !== 64) {
    return `is ${hex.length} hex characters (expected 64, optionally 0x-prefixed)`;
  }
  // Correct shape, still refused: out of range for secp256k1 (zero, or >= n).
  return 'is not a valid secp256k1 key (out of range)';
}

/**
 * A wallets.json entry as PARSED, before validation. `privateKey` is `unknown`
 * because the file is untrusted input: the previous signature declared it a
 * `string`, which forced callers into an `as string` cast and split the
 * validation across two places (PR #2332 review).
 */
interface CandidateWalletEntry {
  address: string;
  privateKey: unknown;
}

function validateWalletEntry(entry: CandidateWalletEntry, path: string): WalletEntry {
  // GH#1432 — `new ethers.Wallet(...)` throws INVALID_ARGUMENT with the value
  // redacted, naming neither the file nor the offending entry, so `dkg wallet`
  // died with a message an operator could not act on. Let ethers decide what is
  // valid, and translate its refusal into something addressable. The key itself
  // is never echoed.
  let derived: ethers.Wallet;
  try {
    derived = new ethers.Wallet(entry.privateKey as string);
  } catch {
    throw new Error(
      `Invalid operational wallet key at ${path} in wallets.json: privateKey ` +
        `${describeRejectedKey(entry.privateKey)}. Address on the entry: ` +
        `${entry.address ?? '(none)'}.`,
    );
  }
  if (derived.address.toLowerCase() !== entry.address.toLowerCase()) {
    throw new Error(
      `Address mismatch in wallets.json ${path}: expected ${derived.address} but got ${entry.address}`,
    );
  }
  return { address: derived.address, privateKey: derived.privateKey };
}

// ── GH #11 — at-rest encryption helpers ────────────────────────────────────

function isEncryptedEntry(entry: StoredWalletEntry): boolean {
  return !!entry && typeof entry === 'object' && !!entry.keystore;
}

/** Derive the 32-byte AES key: the raw machine-local secret, optionally
 *  strengthened with a scrypt pass over an operator passphrase. */
function deriveAtRestKey(secret: Buffer, kdf: 'raw' | 'scrypt', passphrase?: string): Buffer {
  if (kdf === 'scrypt') {
    if (!passphrase) {
      throw new Error(`${PASSPHRASE_ENV} is required to derive the wallet key for a passphrase-protected keystore`);
    }
    return scryptSync(passphrase, secret, 32, { N: 16384, r: 8, p: 1 });
  }
  return secret;
}

function encryptKey(privateKey: string, secret: Buffer, passphrase?: string): EncryptedKeystore {
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

function decryptKey(keystore: EncryptedKeystore, secret: Buffer): string {
  const passphrase = process.env[PASSPHRASE_ENV];
  if (keystore.kdf === 'scrypt' && !passphrase) {
    throw new Error(
      `wallet keystore was encrypted with ${PASSPHRASE_ENV} which is not currently set — refusing to decrypt`,
    );
  }
  const key = deriveAtRestKey(secret, keystore.kdf, passphrase);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(keystore.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(keystore.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(keystore.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

/** Read the machine-local wallet secret, or undefined if it doesn't exist. */
async function loadWalletSecret(dataDir: string): Promise<Buffer | undefined> {
  try {
    const raw = await readFile(join(dataDir, WALLET_SECRET_FILE), 'utf-8');
    const buf = Buffer.from(raw.trim(), 'base64');
    if (buf.length !== 32) {
      throw new Error(`${WALLET_SECRET_FILE} is malformed (expected a 32-byte base64 secret)`);
    }
    return buf;
  } catch (err: any) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Read or create the machine-local wallet secret (32 random bytes, mode 0600).
 *  The secret is independent of any wallet key, so it never leaks a private key. */
async function loadOrCreateWalletSecret(dataDir: string): Promise<Buffer> {
  const existing = await loadWalletSecret(dataDir);
  if (existing) return existing;
  await mkdir(dataDir, { recursive: true });
  const secret = randomBytes(32);
  const secretPath = join(dataDir, WALLET_SECRET_FILE);
  await writeFile(secretPath, secret.toString('base64') + '\n', { mode: 0o600 });
  await chmod(secretPath, 0o600);
  return secret;
}
