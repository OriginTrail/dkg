import { ethers } from 'ethers';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
    const parsed = JSON.parse(raw) as Partial<OpWalletsConfig> | WalletEntry[];
    const existingWallets = Array.isArray(parsed) ? parsed : parsed.wallets;
    if (!Array.isArray(existingWallets)) {
      throw new Error('wallets.json must contain a wallets array');
    }
    if (existingWallets.length === 0) {
      throw new Error('wallets.json must contain at least one operational wallet');
    }

    {
      const wallets = existingWallets.map((w, index) =>
        validateWalletEntry(w, `wallets[${index}]`),
      );
      const adminWallet = !Array.isArray(parsed) && parsed.adminWallet
        ? validateWalletEntry(parsed.adminWallet, 'adminWallet')
        : undefined;

      if (adminWallet) {
        const adminKey = adminWallet.address.toLowerCase();
        for (const wallet of wallets) {
          if (wallet.address.toLowerCase() === adminKey) {
            throw new Error('adminWallet in wallets.json must be distinct from operational wallets');
          }
        }
      }

      return { adminWallet, wallets };
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
  const filePath = join(dataDir, 'wallets.json');
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function createWalletEntry(): WalletEntry {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

function validateWalletEntry(entry: WalletEntry, path: string): WalletEntry {
  const derived = new ethers.Wallet(entry.privateKey);
  if (derived.address.toLowerCase() !== entry.address.toLowerCase()) {
    throw new Error(
      `Address mismatch in wallets.json ${path}: expected ${derived.address} but got ${entry.address}`,
    );
  }
  return { address: derived.address, privateKey: derived.privateKey };
}
