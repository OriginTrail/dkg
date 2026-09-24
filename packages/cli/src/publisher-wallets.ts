import { ethers } from 'ethers';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, type HeldFileLock } from './file-lock.js';

export interface PublisherWalletsConfig {
  wallets: Array<{
    address: string;
    privateKey: string;
  }>;
}

export function publisherWalletsPath(dataDir: string): string {
  return join(dataDir, 'publisher-wallets.json');
}

export async function loadPublisherWallets(dataDir: string): Promise<PublisherWalletsConfig> {
  const filePath = publisherWalletsPath(dataDir);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const config: PublisherWalletsConfig = JSON.parse(raw);
    return validatePublisherWallets(config);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { wallets: [] };
    }
    throw err;
  }
}

export async function addPublisherWallet(dataDir: string, privateKey: string): Promise<PublisherWalletsConfig> {
  return withPublisherWalletLock(dataDir, async (lock) => {
    const normalizedKey = privateKey.trim();
    const wallet = new ethers.Wallet(normalizedKey);
    const existing = await loadPublisherWallets(dataDir);
    if (existing.wallets.some((entry) => entry.address.toLowerCase() === wallet.address.toLowerCase())) {
      throw new Error(`Publisher wallet already exists: ${wallet.address}`);
    }

    const config: PublisherWalletsConfig = {
      wallets: [...existing.wallets, { address: wallet.address, privateKey: wallet.privateKey }],
    };
    await savePublisherWallets(lock, dataDir, config);
    return config;
  });
}

export async function removePublisherWallet(dataDir: string, address: string): Promise<PublisherWalletsConfig> {
  return withPublisherWalletLock(dataDir, async (lock) => {
    const normalized = address.trim().toLowerCase();
    const existing = await loadPublisherWallets(dataDir);
    const next = existing.wallets.filter((entry) => entry.address.toLowerCase() !== normalized);
    if (next.length === existing.wallets.length) {
      throw new Error(`Publisher wallet not found: ${address}`);
    }
    const config: PublisherWalletsConfig = { wallets: next };
    await savePublisherWallets(lock, dataDir, config);
    return config;
  });
}

/**
 * Replace the wallets file through the lock, so a writer that was taken over
 * after stalling past its lease cannot overwrite its successor's change. The
 * file holds private keys: it is owner-only however it was found.
 */
async function savePublisherWallets(lock: HeldFileLock, dataDir: string, config: PublisherWalletsConfig): Promise<void> {
  await lock.replaceFile(publisherWalletsPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function validatePublisherWallets(config: PublisherWalletsConfig): PublisherWalletsConfig {
  const wallets = config.wallets ?? [];
  for (const entry of wallets) {
    const wallet = new ethers.Wallet(entry.privateKey);
    if (wallet.address.toLowerCase() !== entry.address.toLowerCase()) {
      throw new Error(`Address mismatch in publisher-wallets.json: expected ${wallet.address} but got ${entry.address}`);
    }
  }
  return { wallets };
}

async function withPublisherWalletLock<T>(dataDir: string, fn: (lock: HeldFileLock) => Promise<T>): Promise<T> {
  await mkdir(dataDir, { recursive: true });
  return withFileLock(`${publisherWalletsPath(dataDir)}.lock`, fn, { label: 'publisher wallet' });
}
