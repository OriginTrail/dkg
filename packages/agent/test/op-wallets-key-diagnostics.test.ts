import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOpWallets } from '../src/op-wallets.js';

// GH#1128 sibling / GH#1432 — `dkg wallet` died with ethers'
// `invalid private key (argument="privateKey", value="[ REDACTED ]",
// code=INVALID_ARGUMENT)`, which names neither the file nor the entry, so an
// operator had no path from the message to the fix. `validateWalletEntry`
// handed the value straight to `new ethers.Wallet(...)`, and the legacy branch
// cast a possibly-absent `privateKey` with `as string`.
const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-wallet-diag-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function writeWallets(dir: string, wallets: unknown[]): Promise<void> {
  await writeFile(join(dir, 'wallets.json'), JSON.stringify({ wallets }, null, 2), 'utf-8');
}

describe('loadOpWallets — actionable key diagnostics (GH#1432)', () => {
  it('names the entry when it carries neither keystore nor privateKey', async () => {
    const dir = await tempDir();
    await writeWallets(dir, [{ address: '0x1111111111111111111111111111111111111111' }]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\.json/);
    // The ethers message must not be what the operator sees.
    await expect(loadOpWallets(dir)).rejects.not.toThrow(/INVALID_ARGUMENT/);
  });

  it('names the entry and the observed length for a truncated key', async () => {
    const dir = await tempDir();
    await writeWallets(dir, [{ address: '0x1111111111111111111111111111111111111111', privateKey: '0xdeadbeef' }]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/10 characters/);
  });

  it('names the entry for a non-string key', async () => {
    const dir = await tempDir();
    await writeWallets(dir, [{ address: '0x1111111111111111111111111111111111111111', privateKey: 12345 }]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/is a number, not a string/);
  });

  it('reports adminWallet by name, not by index', async () => {
    const dir = await tempDir();
    const good = '0x' + '11'.repeat(32);
    const { Wallet } = await import('ethers');
    await writeFile(
      join(dir, 'wallets.json'),
      JSON.stringify({
        // adminWallet carries no key; the operational entry is well-formed, so
        // adminWallet must be what the error names.
        adminWallet: { address: '0x2222222222222222222222222222222222222222' },
        wallets: [{ address: new Wallet(good).address, privateKey: good }],
      }),
      'utf-8',
    );
    await expect(loadOpWallets(dir)).rejects.toThrow(/adminWallet/);
  });

  it('accepts a bare-hex key with no 0x prefix, as ethers does', async () => {
    // Regression guard: ethers derives the same address from `'11'.repeat(32)`
    // as from the 0x-prefixed form, so a wallets.json using the bare form works
    // today. This guard must diagnose bad keys, not narrow what loads.
    const dir = await tempDir();
    const bare = '11'.repeat(32);
    const { Wallet } = await import('ethers');
    await writeWallets(dir, [{ address: new Wallet(bare).address, privateKey: bare }]);

    const cfg = await loadOpWallets(dir);
    expect(cfg.wallets).toHaveLength(1);
    // Normalised to the 0x form on the way out, as before.
    expect(cfg.wallets[0]!.privateKey).toBe('0x' + bare);
  });

  it('still loads a well-formed plaintext wallets.json', async () => {
    const dir = await tempDir();
    const key = '0x' + '11'.repeat(32);
    const { Wallet } = await import('ethers');
    await writeWallets(dir, [{ address: new Wallet(key).address, privateKey: key }]);

    const cfg = await loadOpWallets(dir);
    expect(cfg.wallets).toHaveLength(1);
    expect(cfg.wallets[0]!.privateKey).toBe(key);
  });
});
