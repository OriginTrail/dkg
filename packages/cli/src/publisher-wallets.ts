import { ethers } from 'ethers';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_STALE_MS = 5 * 60 * 1000;

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
  return withPublisherWalletLock(dataDir, async () => {
    const normalizedKey = privateKey.trim();
    const wallet = new ethers.Wallet(normalizedKey);
    const existing = await loadPublisherWallets(dataDir);
    if (existing.wallets.some((entry) => entry.address.toLowerCase() === wallet.address.toLowerCase())) {
      throw new Error(`Publisher wallet already exists: ${wallet.address}`);
    }

    const config: PublisherWalletsConfig = {
      wallets: [...existing.wallets, { address: wallet.address, privateKey: wallet.privateKey }],
    };
    await savePublisherWallets(dataDir, config);
    return config;
  });
}

export async function removePublisherWallet(dataDir: string, address: string): Promise<PublisherWalletsConfig> {
  return withPublisherWalletLock(dataDir, async () => {
    const normalized = address.trim().toLowerCase();
    const existing = await loadPublisherWallets(dataDir);
    const next = existing.wallets.filter((entry) => entry.address.toLowerCase() !== normalized);
    if (next.length === existing.wallets.length) {
      throw new Error(`Publisher wallet not found: ${address}`);
    }
    const config: PublisherWalletsConfig = { wallets: next };
    await savePublisherWallets(dataDir, config);
    return config;
  });
}

async function savePublisherWallets(dataDir: string, config: PublisherWalletsConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filePath = publisherWalletsPath(dataDir);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
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

async function withPublisherWalletLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dataDir, { recursive: true });
  const lockPath = `${publisherWalletsPath(dataDir)}.lock`;
  const handle = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function acquireLock(lockPath: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return handle;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      if (await reapStaleLock(lockPath)) {
        continue;
      }
      await sleep(25);
    }
  }
  throw new Error(`Timed out waiting for publisher wallet lock: ${lockPath}`);
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, 'utf-8');
    if (!raw.trim()) {
      // Empty file — lock was just created but metadata not yet written.
      // Check file age via mtime; treat as live if recent.
      const st = await stat(lockPath).catch(() => null);
      if (st && Date.now() - st.mtimeMs < 5000) return false;
      await unlink(lockPath).catch(() => {});
      return true;
    }
    const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
    const createdAt = Number(parsed.createdAt);
    const pid = Number(parsed.pid);
    const pidDead = Number.isFinite(pid) ? !isProcessRunning(pid) : true;
    const aged = Number.isFinite(createdAt) ? Date.now() - createdAt > LOCK_STALE_MS : true;
    if (pidDead || (aged && !Number.isFinite(pid))) {
      await unlink(lockPath).catch(() => {});
      return true;
    }
    return false;
  } catch {
    // Parse failed — possibly partial write. Check file age before reaping.
    const st = await stat(lockPath).catch(() => null);
    if (st && Date.now() - st.mtimeMs < 5000) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
