import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { generateWallets, loadOpWallets } from '../src/op-wallets.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-op-wallets-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('operational wallet config', () => {
  it('generates and persists one admin wallet plus operational wallets', async () => {
    const dir = await tempDir();

    const config = await loadOpWallets(dir, 2);

    expect(config.adminWallet?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(config.wallets).toHaveLength(2);
    expect(config.wallets.map((w) => w.address)).not.toContain(config.adminWallet?.address);

    const raw = JSON.parse(await readFile(join(dir, 'wallets.json'), 'utf-8'));
    expect(raw.adminWallet.address).toBe(config.adminWallet?.address);
    expect(raw.wallets).toHaveLength(2);
  });

  it('rejects invalid generated wallet counts before writing wallets.json', async () => {
    const dir = await tempDir();

    expect(() => generateWallets(0)).toThrow('wallet count must be at least 1');
    await expect(loadOpWallets(dir, 0)).rejects.toThrow('wallet count must be at least 1');
    await expect(readFile(join(dir, 'wallets.json'), 'utf-8')).rejects.toThrow();
  });

  it('loads legacy operational-only wallets.json without inventing an admin wallet', async () => {
    const dir = await tempDir();
    const operational = ethers.Wallet.createRandom();
    await writeFile(join(dir, 'wallets.json'), JSON.stringify({
      wallets: [{ address: operational.address, privateKey: operational.privateKey }],
    }));

    const config = await loadOpWallets(dir);
    expect(config.adminWallet).toBeUndefined();
    expect(config.wallets).toEqual([{ address: operational.address, privateKey: operational.privateKey }]);

    const raw = JSON.parse(await readFile(join(dir, 'wallets.json'), 'utf-8'));
    expect(raw.adminWallet).toBeUndefined();
  });

  it('rejects existing wallets.json files with no operational wallets', async () => {
    const dir = await tempDir();
    const admin = ethers.Wallet.createRandom();
    await writeFile(join(dir, 'wallets.json'), JSON.stringify({
      adminWallet: { address: admin.address, privateKey: admin.privateKey },
      wallets: [],
    }));

    await expect(loadOpWallets(dir)).rejects.toThrow('at least one operational wallet');
  });

  it('rejects admin wallets that duplicate an operational wallet', async () => {
    const dir = await tempDir();
    const generated = generateWallets(1);
    const operational = generated.wallets[0];
    await writeFile(join(dir, 'wallets.json'), JSON.stringify({
      adminWallet: operational,
      wallets: [operational],
    }));

    await expect(loadOpWallets(dir)).rejects.toThrow('adminWallet in wallets.json must be distinct');
  });
});
