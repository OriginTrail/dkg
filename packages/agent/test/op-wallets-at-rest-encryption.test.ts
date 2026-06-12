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
 * `it.fails`: the assertion that the persisted file does NOT contain a raw
 * private key fails today (keys are plaintext). When the keystore is wired in,
 * drop `.fails` and close #11. Hermetic — tmpdir only.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOpWallets } from '../src/op-wallets.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  dirs.length = 0;
});

describe('GH #11 — operational wallet private keys at rest', () => {
  it('does not persist raw private keys in plaintext in wallets.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gh11-opwallets-'));
    dirs.push(dir);

    const config = await loadOpWallets(dir, 2); // generates + persists on first call
    const raw = await readFile(join(dir, 'wallets.json'), 'utf-8');

    // Control: the in-memory config really does carry private keys (so the
    // negative assertion below is meaningful).
    expect(config.wallets[0].privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // The on-disk file must not contain any wallet's raw private key verbatim.
    for (const w of config.wallets) {
      expect(raw).not.toContain(w.privateKey);
    }
  });
});
