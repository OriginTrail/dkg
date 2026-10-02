import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPublisherWallet, loadPublisherWallets, publisherWalletsPath, removePublisherWallet,
} from '../src/publisher-wallets.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

function newWallet(): { address: string; privateKey: string } {
  const { address, privateKey } = ethers.Wallet.createRandom();
  return { address, privateKey };
}

describe('publisher wallet writes under the lock', () => {
  let dataDir = '';
  let walletsPath = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    walletsPath = publisherWalletsPath(dataDir);
  });

  afterEach(async () => {
    vi.mocked(readFile).mockReset();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeWallets(wallets: Array<{ address: string; privateKey: string }>): Promise<void> {
    await writeFile(walletsPath, JSON.stringify({ wallets }, null, 2));
  }

  /**
   * Once the writer has read the wallets file, act as a successor that took
   * the lock over after the writer's lease lapsed and added its own wallet.
   */
  function takeOverAfterRead(successorWallet: { address: string; privateKey: string }): void {
    let tookOver = false;
    vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
      const content = await actualFs.readFile(...args);
      if (args[0] === walletsPath && !tookOver) {
        tookOver = true;
        const current = JSON.parse(String(content)) as { wallets: unknown[] };
        await actualFs.writeFile(`${walletsPath}.lock`, JSON.stringify({ pid: process.ppid, token: 'successor', createdAt: Date.now() }));
        await actualFs.writeFile(walletsPath, JSON.stringify({ wallets: [...current.wallets, successorWallet] }, null, 2));
      }
      return content;
    });
  }

  it.each([
    ['an added wallet', (key: { privateKey: string }) => addPublisherWallet(dataDir, key.privateKey)],
    ['a removal', (_key: { privateKey: string }, removed: { address: string }) => removePublisherWallet(dataDir, removed.address)],
  ])('refuses to write %s after another writer took the lock over', async (_kind, write) => {
    const kept = newWallet();
    const removed = newWallet();
    const successor = newWallet();
    await writeWallets([kept, removed]);
    takeOverAfterRead(successor);

    await expect(write(newWallet(), removed)).rejects.toThrow('Lost the publisher wallet lock');

    vi.mocked(readFile).mockReset();
    expect((await loadPublisherWallets(dataDir)).wallets).toEqual([kept, removed, successor]);
  });

  it('keeps the wallets file owner-only, even over a looser existing file', async () => {
    const existing = newWallet();
    await writeWallets([existing]);
    await chmod(walletsPath, 0o644);
    const added = newWallet();

    await addPublisherWallet(dataDir, added.privateKey);

    expect((await loadPublisherWallets(dataDir)).wallets).toEqual([existing, added]);
    // Windows keeps only a read-only flag, not POSIX permission bits.
    if (process.platform !== 'win32') expect((await stat(walletsPath)).mode & 0o777).toBe(0o600);
  });

  it('creates the wallets file owner-only', async () => {
    const added = newWallet();

    await addPublisherWallet(dataDir, added.privateKey);

    expect(JSON.parse(await readFile(walletsPath, 'utf-8'))).toEqual({ wallets: [added] });
    if (process.platform !== 'win32') expect((await stat(walletsPath)).mode & 0o777).toBe(0o600);
  });
});
