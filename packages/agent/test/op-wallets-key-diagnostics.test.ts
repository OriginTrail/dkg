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
    await expect(loadOpWallets(dir)).rejects.toThrow(/not a key ethers accepts/);
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

  // PR #2332 review — length alone is not discriminating: a regression to a
  // simple 66-character check would leave the earlier cases green while
  // same-length malformed keys fell through to the opaque ethers error.
  it('names the entry for a same-length key containing non-hex characters', async () => {
    const dir = await tempDir();
    await writeWallets(dir, [
      { address: '0x1111111111111111111111111111111111111111', privateKey: '0x' + 'z'.repeat(64) },
    ]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/not a key ethers accepts/);
    await expect(loadOpWallets(dir)).rejects.not.toThrow(/INVALID_ARGUMENT/);
  });

  // Correct shape, still refused by secp256k1. The old regex admitted these,
  // so ethers produced the unactionable error the issue is about.
  it('names the entry for an all-zero key (valid shape, invalid scalar)', async () => {
    const dir = await tempDir();
    await writeWallets(dir, [
      { address: '0x1111111111111111111111111111111111111111', privateKey: '0x' + '0'.repeat(64) },
    ]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/not a key ethers accepts/);
  });

  it('names the entry for a key at the secp256k1 group order', async () => {
    const dir = await tempDir();
    // n itself is out of range (valid keys are 1 <= k < n).
    const n = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141';
    await writeWallets(dir, [{ address: '0x1111111111111111111111111111111111111111', privateKey: n }]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/not a key ethers accepts/);
  });

  it('never echoes the rejected key material in the diagnostic', async () => {
    const dir = await tempDir();
    const secretish = '0x' + 'ab'.repeat(32) + 'ff';
    await writeWallets(dir, [
      { address: '0x1111111111111111111111111111111111111111', privateKey: secretish },
    ]);
    await expect(loadOpWallets(dir)).rejects.not.toThrow(new RegExp('ab'.repeat(8)));
  });

  // PR #2332 review — the diagnostic must describe what a later load ACTUALLY
  // does. The loader never replenishes an entry, so promising provisioning
  // would send an operator down a path that silently reduces wallet count.
  it('describes the real recovery outcome for an operational entry', async () => {
    const dir = await tempDir();
    const good = '0x' + '11'.repeat(32);
    const { Wallet } = await import('ethers');
    await writeWallets(dir, [
      { address: new Wallet(good).address, privateKey: good },
      { address: '0x2222222222222222222222222222222222222222' },
    ]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[1\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/NOT repaired on load/);

    // And the promise holds: removing the entry yields one wallet, not two.
    await writeWallets(dir, [{ address: new Wallet(good).address, privateKey: good }]);
    const cfg = await loadOpWallets(dir);
    expect(cfg.wallets).toHaveLength(1);
  });

  it('describes the real recovery outcome for the admin entry', async () => {
    const dir = await tempDir();
    const good = '0x' + '11'.repeat(32);
    const { Wallet } = await import('ethers');
    await writeFile(
      join(dir, 'wallets.json'),
      JSON.stringify({
        adminWallet: { address: '0x2222222222222222222222222222222222222222' },
        wallets: [{ address: new Wallet(good).address, privateKey: good }],
      }),
      'utf-8',
    );

    await expect(loadOpWallets(dir)).rejects.toThrow(/adminWallet/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/NOT repaired on load/);
  });

  // PR #2332 review — the diagnostic must not become a secret-disclosure path.
  // A malformed file can duplicate key material into `address`, and this
  // message goes to console and daemon logs.
  it('never echoes key material that was copied into the address field', async () => {
    const dir = await tempDir();
    const leaked = '0x' + 'ab'.repeat(32) + 'ff'; // 33 bytes -> rejected
    await writeWallets(dir, [{ address: leaked, privateKey: leaked }]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    // Neither copy may appear, in any casing.
    await expect(loadOpWallets(dir)).rejects.not.toThrow(new RegExp('ab'.repeat(8), 'i'));
    await expect(loadOpWallets(dir)).rejects.toThrow(/missing or malformed/);
  });

  // PR #2332 review — ethers REJECTS an uppercase `0X` prefix even though the
  // payload is in range, so the diagnostic must not claim to know the reason.
  it('does not misdiagnose an uppercase 0X prefix as a scalar problem', async () => {
    const dir = await tempDir();
    await writeWallets(dir, [
      { address: '0x1111111111111111111111111111111111111111', privateKey: '0X' + '11'.repeat(32) },
    ]);

    await expect(loadOpWallets(dir)).rejects.toThrow(/wallets\[0\]/);
    await expect(loadOpWallets(dir)).rejects.toThrow(/not a key ethers accepts/);
    // The old classifier stripped `0X` and reported an out-of-range scalar.
    await expect(loadOpWallets(dir)).rejects.not.toThrow(/out of range/);
  });
});
