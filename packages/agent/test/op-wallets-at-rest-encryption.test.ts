/**
 * Liveness/regression test for GH #11 — "Secrets partially unencrypted on disk".
 * https://github.com/OriginTrail/dkg/issues/11
 *
 * An AES-256-GCM keystore module exists (`packages/cli/src/keystore.ts`) but is
 * not wired into the operational-wallet storage path: `loadOpWallets` generates
 * wallets and persists them via `saveOpWallets`, which writes
 * `JSON.stringify(config)` — including each wallet's raw `privateKey` — to
 * `wallets.json` (mode 0o600 but unencrypted). On mainnet those wallets hold
 * real TRAC/ETH, so plaintext-at-rest is a real exposure.
 *
 * This asserts the CORRECT (post-fix) behaviour — no wallet's raw private key
 * appears in plaintext ANYWHERE under the data dir — so it is RED while the keys
 * are stored plaintext and GREEN once the keystore is wired in. It scans EVERY
 * persisted file (not just `wallets.json`) so a valid fix that moves secrets into
 * an encrypted keystore, renames the artifact, or leaves only non-secret
 * metadata still turns it green (Codex review on PR #1129). Hermetic — tmpdir.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { loadOpWallets } from '../src/op-wallets.js';

/** Every regular file under `dir`, recursively. */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(p)));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  dirs.length = 0;
});

describe('GH #11 — operational wallet private keys at rest', () => {
  it('does not persist any wallet raw private key in plaintext anywhere on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gh11-opwallets-'));
    dirs.push(dir);

    const config = await loadOpWallets(dir, 2); // generates + persists on first call

    // Control: the in-memory config really does carry private keys (so the
    // negative assertion below is meaningful, not vacuously true).
    expect(config.wallets[0].privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(config.adminWallet?.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Scan EVERY persisted file (and the bare-hex form, in case a future writer
    // strips the 0x prefix). No file may contain a wallet's raw private key —
    // including the ADMIN wallet (a regression that encrypts operational wallets
    // but leaves the admin key plaintext must fail here too).
    const allKeys = [
      ...config.wallets.map((w) => w.privateKey),
      ...(config.adminWallet ? [config.adminWallet.privateKey] : []),
    ];
    const files = await walkFiles(dir);
    const blobs = await Promise.all(files.map((f) => readFile(f, 'utf-8').catch(() => '')));
    const combined = blobs.join('\n');
    for (const hex of allKeys) {
      const bare = hex.replace(/^0x/, '');
      expect(combined, `a persisted file under ${dir} contains a raw private key`).not.toContain(hex);
      expect(combined).not.toContain(bare);
    }

    // Reload from the now-encrypted files (simulates a daemon restart): the
    // keystore must decrypt back to the SAME admin + operational keys. Guards
    // against writing an unreadable keystore or rotating keys on reload.
    const reloaded = await loadOpWallets(dir, 2);
    expect(reloaded.adminWallet?.privateKey).toBe(config.adminWallet?.privateKey);
    expect(reloaded.adminWallet?.address).toBe(config.adminWallet?.address);
    expect(reloaded.wallets.map((w) => w.privateKey)).toEqual(config.wallets.map((w) => w.privateKey));
    expect(reloaded.wallets.map((w) => w.address)).toEqual(config.wallets.map((w) => w.address));
  });

  it('migrates an existing LEGACY plaintext wallets.json to an encrypted keystore on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gh11-migrate-'));
    dirs.push(dir);

    // Simulate an upgraded node carrying a pre-encryption plaintext wallets.json
    // (the deployed wallets most likely to hold real funds).
    const admin = ethers.Wallet.createRandom();
    const op = ethers.Wallet.createRandom();
    await writeFile(
      join(dir, 'wallets.json'),
      JSON.stringify({
        adminWallet: { address: admin.address, privateKey: admin.privateKey },
        wallets: [{ address: op.address, privateKey: op.privateKey }],
      }),
    );

    // Load: accepts the legacy keys AND transparently re-encrypts the file.
    const loaded = await loadOpWallets(dir);
    expect(loaded.adminWallet?.privateKey).toBe(admin.privateKey);
    expect(loaded.wallets[0].privateKey).toBe(op.privateKey);

    // The on-disk file no longer contains either raw private key.
    const files = await walkFiles(dir);
    const combined = (await Promise.all(files.map((f) => readFile(f, 'utf-8').catch(() => '')))).join('\n');
    for (const hex of [admin.privateKey, op.privateKey]) {
      expect(combined, 'legacy plaintext key still on disk after migration').not.toContain(hex);
      expect(combined).not.toContain(hex.replace(/^0x/, ''));
    }

    // Reload (simulated restart): decrypts back to the SAME keys — no rotation,
    // no lockout.
    const reloaded = await loadOpWallets(dir);
    expect(reloaded.adminWallet?.privateKey).toBe(admin.privateKey);
    expect(reloaded.wallets[0].privateKey).toBe(op.privateKey);
  });
});
