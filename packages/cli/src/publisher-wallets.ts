import { ethers } from 'ethers';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateFileUnderLease, type LeasedFileChange } from './file-lock.js';

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
  return updatePublisherWallets(dataDir, async () => {
    const normalizedKey = privateKey.trim();
    const wallet = new ethers.Wallet(normalizedKey);
    const existing = await loadPublisherWallets(dataDir);
    if (existing.wallets.some((entry) => entry.address.toLowerCase() === wallet.address.toLowerCase())) {
      throw new Error(`Publisher wallet already exists: ${wallet.address}`);
    }

    return walletsChange(dataDir, {
      wallets: [...existing.wallets, { address: wallet.address, privateKey: wallet.privateKey }],
    });
  });
}

export async function removePublisherWallet(dataDir: string, address: string): Promise<PublisherWalletsConfig> {
  return updatePublisherWallets(dataDir, async () => {
    const normalized = address.trim().toLowerCase();
    const existing = await loadPublisherWallets(dataDir);
    const next = existing.wallets.filter((entry) => entry.address.toLowerCase() !== normalized);
    if (next.length === existing.wallets.length) {
      throw new Error(`Publisher wallet not found: ${address}`);
    }
    return walletsChange(dataDir, { wallets: next });
  });
}

/**
 * The wallets file's new content. It holds private keys, so it is written
 * owner-only however it was found.
 */
function walletsChange(dataDir: string, config: PublisherWalletsConfig): LeasedFileChange<PublisherWalletsConfig> {
  return {
    result: config,
    path: publisherWalletsPath(dataDir),
    content: `${JSON.stringify(config, null, 2)}\n`,
    mode: 0o600,
  };
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

/**
 * Read and change the wallets file under its lease. The change is published
 * only while the lease is held, so a writer that was taken over after
 * stalling past its lease cannot overwrite its successor's change.
 */
async function updatePublisherWallets(
  dataDir: string,
  prepare: () => Promise<LeasedFileChange<PublisherWalletsConfig>>,
): Promise<PublisherWalletsConfig> {
  await mkdir(dataDir, { recursive: true });
  const { result } = await updateFileUnderLease(`${publisherWalletsPath(dataDir)}.lock`, prepare, { label: 'publisher wallet' });
  return result;
}
