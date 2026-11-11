import { ethers } from 'ethers';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  NODE_KEY_PASSPHRASE_ENV,
  NODE_KEY_SECRET_FILE,
  nodeKeySecret,
  openNodeKey,
  readNodeKeySecret,
  sealNodeKey,
  type NodeKeystore,
} from '@origintrail-official/dkg-core';

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
// The scheme is core's node key store, which the node's other keys use too.
// Test-only escape hatch: skip the legacy-plaintext→encrypted migration on load.
// Set by harnesses/tooling that read the raw `privateKey` field out of
// wallets.json directly and cannot decrypt (e.g. the devnet staking script).
const NO_MIGRATE_ENV = 'DKG_WALLETS_NO_MIGRATE';

interface StoredWalletEntry {
  address: string;
  privateKey?: string;
  keystore?: NodeKeystore;
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
      const secret = hasEncrypted ? await readNodeKeySecret(dataDir) : undefined;
      if (hasEncrypted && !secret) {
        throw new Error(
          `wallets.json holds encrypted wallet keystores but ${NODE_KEY_SECRET_FILE} is missing — cannot decrypt. ` +
            `Restore ${NODE_KEY_SECRET_FILE} (or set ${NODE_KEY_PASSPHRASE_ENV} if it was passphrase-protected) from backup.`,
        );
      }

      let sawLegacyPlaintext = false;
      const resolve = (stored: StoredWalletEntry, path: string): WalletEntry => {
        if (isEncryptedEntry(stored)) {
          const privateKey = openNodeKey(stored.keystore!, secret!);
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
          // PR #2332 review — do NOT promise provisioning: `loadOpWallets`
          // never replenishes an entry, so removing one just leaves fewer
          // wallets (or no admin wallet). Keep it factual and role-neutral —
          // an earlier version selected guidance by comparing the display path
          // to the literal 'adminWallet', which would silently pick the wrong
          // branch if that locator were ever reformatted.
          throw new Error(
            `Wallet entry at ${path} in wallets.json has no key: it carries neither an ` +
              `encrypted \`keystore\` nor a plaintext \`privateKey\`. Restore the key from backup; ` +
              `removing the entry is NOT repaired on load — the node simply starts with that ` +
              `wallet absent.`,
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
  const secret = await nodeKeySecret(dataDir);
  const passphrase = process.env[NODE_KEY_PASSPHRASE_ENV];
  const encEntry = (w: WalletEntry): StoredWalletEntry => ({
    address: w.address,
    keystore: sealNodeKey(w.privateKey, secret, passphrase),
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
 * Describe a rejected key WITHOUT revealing it, and WITHOUT reimplementing
 * ethers' grammar.
 *
 * PR #2332 review — an earlier version classified prefix/hex/length locally to
 * explain WHY a key was refused. That recreated a dependency-owned parser: it
 * already had to be widened once when ethers turned out to accept bare hex, and
 * it then misdiagnosed an uppercase `0X` prefix (which ethers rejects, but whose
 * payload is perfectly in range) as an out-of-range scalar. `ethers.Wallet`
 * owns validity; this reports only what is knowable locally and safe to print.
 */
function describeRejectedKey(value: unknown): string {
  if (value === undefined || value === null) return 'is missing';
  if (typeof value !== 'string') return `is a ${typeof value}, not a string`;
  if (value.length === 0) return 'is empty';
  return 'is not a key ethers accepts (expected 64 hex characters, optionally 0x-prefixed)';
}

/**
 * `address` is UNTRUSTED until it parses. A malformed wallets.json can carry
 * key material in that field, and this message goes to console and daemon logs
 * — so print it only once it is a well-formed public address (PR #2332 review).
 */
function safeAddressForDiagnostic(address: unknown): string {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address)
    ? address
    : '(missing or malformed)';
}

/**
 * A wallets.json entry as PARSED, before validation. `privateKey` is `unknown`
 * because the file is untrusted input: declaring it a `string` forced callers
 * into an `as string` cast and split validation across two places.
 */
interface CandidateWalletEntry {
  address: string;
  privateKey: unknown;
}

function validateWalletEntry(entry: CandidateWalletEntry, path: string): WalletEntry {
  // GH#1432 — `new ethers.Wallet(...)` throws INVALID_ARGUMENT with the value
  // redacted, naming neither the file nor the offending entry, so `dkg wallet`
  // died with a message an operator could not act on. Let ethers decide what is
  // valid, and add the context its error lacks. Neither the key nor an
  // unvalidated address is ever echoed.
  let derived: ethers.Wallet;
  try {
    derived = new ethers.Wallet(entry.privateKey as string);
  } catch {
    throw new Error(
      `Invalid operational wallet key at ${path} in wallets.json: privateKey ` +
        `${describeRejectedKey(entry.privateKey)}. Address on the entry: ` +
        `${safeAddressForDiagnostic(entry.address)}.`,
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
