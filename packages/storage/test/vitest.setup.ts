/**
 * Global vitest setup for `@origintrail-official/dkg-storage`.
 *
 * `PrivateContentStore` now
 * generates and persists a per-node 32-byte random key at
 * `DKG_PRIVATE_STORE_KEY_FILE` (or `<DKG_HOME>/private-store.key`, or
 * `<homedir()>/.dkg/private-store.key`). Without this setup, tests
 * that instantiate `new PrivateContentStore(store, gm)` without
 * passing an explicit key would write into the developer's real
 * `~/.dkg/` directory. We pin the key path to a per-session temp
 * directory so the tests stay hermetic — no pollution, no leaking
 * secrets between unrelated repos that happen to share a $HOME.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sessionDir = mkdtempSync(join(tmpdir(), 'dkg-storage-test-'));
process.env.DKG_PRIVATE_STORE_KEY_FILE = join(sessionDir, 'private-store.key');

// Best-effort cleanup — vitest workers share this process so a single
// top-level `afterAll` hook is unreliable. Relying on process exit
// handlers is simplest and robust against crashes.
process.on('exit', () => {
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});
