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
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

    // Scan EVERY persisted file (and the bare-hex form, in case a future writer
    // strips the 0x prefix). No file may contain a wallet's raw private key.
    const files = await walkFiles(dir);
    const blobs = await Promise.all(files.map((f) => readFile(f, 'utf-8').catch(() => '')));
    const combined = blobs.join('\n');
    for (const w of config.wallets) {
      const hex = w.privateKey;
      const bare = hex.replace(/^0x/, '');
      expect(combined, `a persisted file under ${dir} contains a raw private key`).not.toContain(hex);
      expect(combined).not.toContain(bare);
    }
  });
});
