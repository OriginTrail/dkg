/**
 * Tests for the zero-touch chain-reset auto-wipe hook.
 *
 * The hook (packages/cli/src/daemon/chain-reset-wipe.ts) runs on daemon
 * boot before the agent opens its store. It compares the bundled
 * `network.chainResetMarker` against the one persisted under
 * `<dataDir>/.network-state.json` and wipes oxigraph store + publish
 * journal + random-sampling WAL when the two don't match.
 *
 * What we lock in:
 *   1. No marker in network config → hook is a no-op (no state file
 *      written, networks that haven't opted in stay untouched).
 *   2. Persisted == current → no wipe, idempotent.
 *   3. Marker changed → wipe ALL of: store.nq, store.nq.tmp,
 *      random-sampling.wal, every publish-journal.* file. Save new marker.
 *   4. First boot WITH marker present (no persisted state) → wipe.
 *      Documented design: only way to reach here on an existing install
 *      is "auto-update brought a release with a fresh marker", which by
 *      construction happens in the chain-reset window.
 *   5. Preserved files — wallets.json, auth.token, config.json, node-ui.db,
 *      files/ directory, auto-update markers — must survive every code path.
 *   6. Corrupt / unreadable state file → treated as null persisted marker.
 *   7. Idempotent across repeated calls with the same input.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chainResetWipe, detectBackendSwitch, detectNetworkSwitch } from '../src/daemon/chain-reset-wipe.js';

const STATE_FILE = '.network-state.json';
const NEW_MARKER = 'v10-rs-staking-consolidation-2026-04-30';
const OLD_MARKER = 'v9-mainnet-launch-2025-12-01';

let dataDir: string;

function seedAllFiles(dataDir: string) {
  // Files that MUST be wiped on marker change.
  writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');
  writeFileSync(join(dataDir, 'store.nq.tmp'), '<s> <p> <o> .');
  writeFileSync(join(dataDir, 'random-sampling.wal'), 'WAL\n');
  writeFileSync(join(dataDir, 'publish-journal.0'), 'journal-0');
  writeFileSync(join(dataDir, 'publish-journal.1'), 'journal-1');
  writeFileSync(join(dataDir, 'publish-journal.staging'), 'journal-staging');
  // Files that MUST be preserved across the wipe.
  writeFileSync(join(dataDir, 'wallets.json'), '[{"address":"0x..."}]');
  writeFileSync(join(dataDir, 'auth.token'), 'secret-token');
  writeFileSync(join(dataDir, 'config.json'), '{"name":"test"}');
  writeFileSync(join(dataDir, 'node-ui.db'), 'sqlite-bytes');
  writeFileSync(join(dataDir, '.update-pending.json'), '{}');
  writeFileSync(join(dataDir, '.current-version'), '10.0.0-rc.1');
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  writeFileSync(join(dataDir, 'files', 'doc1.md'), '# uploaded');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dkg-wipe-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('chainResetWipe — opt-in protocol', () => {
  it('is a no-op when network config has no marker (back-compat)', async () => {
    seedAllFiles(dataDir);
    const result = await chainResetWipe({ dataDir, currentMarker: undefined });

    expect(result.wiped).toBe(false);
    expect(result.prevMarker).toBeNull();
    expect(result.removedFiles).toEqual([]);
    // New #679 result fields are inert on the no-op path.
    expect(result.skipped).toBe(false);
    expect(result.backedUpFiles).toEqual([]);
    // No state file is created when the protocol isn't active.
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(false);
    // All files preserved.
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
  });
});

describe('chainResetWipe — first boot with marker present', () => {
  it('wipes and saves marker (the chain-reset rollout case)', async () => {
    seedAllFiles(dataDir);
    const logs: string[] = [];

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      log: (msg) => logs.push(msg),
    });

    expect(result.wiped).toBe(true);
    expect(result.prevMarker).toBeNull();
    // Under the default backupStore=true, store.nq is RENAMED (→ backedUpFiles),
    // not hard-deleted; the regenerable files are still removed outright.
    expect(result.removedFiles).toEqual(
      expect.arrayContaining([
        'store.nq.tmp',
        // Label is platform-independent after the #679 walLabel fix
        // (`replace(/^[/\\]+/, '')`) — no leading `/` on Linux nor `\` on Windows.
        'random-sampling.wal',
        'publish-journal.0',
        'publish-journal.1',
        'publish-journal.staging',
      ]),
    );
    expect(result.removedFiles).not.toContain('store.nq');
    expect(result.backedUpFiles).toHaveLength(1);
    expect(result.backedUpFiles[0]).toMatch(/^store\.nq\.pre-wipe-/);

    // Existence-based checks for the store files.
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(existsSync(join(dataDir, 'store.nq.tmp'))).toBe(false);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(false);
    expect(existsSync(join(dataDir, 'wallets.json'))).toBe(true);
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(true);
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);

    expect(logs.some((l) => l.includes('first detected'))).toBe(true);
  });

  it('still records the marker on a fresh install with no chain-state files yet', async () => {
    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    expect(result.removedFiles).toEqual([]);
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(true);
  });
});

describe('chainResetWipe — same marker (steady state)', () => {
  it('does nothing when persisted marker equals current', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: NEW_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);

    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(false);
    expect(result.prevMarker).toBe(NEW_MARKER);
    expect(result.removedFiles).toEqual([]);
    // New #679 result fields are inert on the equal-marker no-op path too.
    expect(result.skipped).toBe(false);
    expect(result.backedUpFiles).toEqual([]);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
  });
});

describe('chainResetWipe — marker changed (chain reset)', () => {
  it('wipes chain-state files and preserves operator state when marker differs', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() - 86_400_000 }),
    );
    seedAllFiles(dataDir);

    const logs: string[] = [];
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      log: (msg) => logs.push(msg),
    });

    expect(result.wiped).toBe(true);
    expect(result.prevMarker).toBe(OLD_MARKER);

    // Wiped:
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(existsSync(join(dataDir, 'store.nq.tmp'))).toBe(false);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(false);
    expect(existsSync(join(dataDir, 'publish-journal.0'))).toBe(false);
    expect(existsSync(join(dataDir, 'publish-journal.1'))).toBe(false);
    expect(existsSync(join(dataDir, 'publish-journal.staging'))).toBe(false);

    // Preserved (the contract that makes auto-wipe safe):
    expect(existsSync(join(dataDir, 'wallets.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'auth.token'))).toBe(true);
    expect(existsSync(join(dataDir, 'config.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'node-ui.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'files', 'doc1.md'))).toBe(true);
    expect(existsSync(join(dataDir, '.update-pending.json'))).toBe(true);
    expect(existsSync(join(dataDir, '.current-version'))).toBe(true);

    // State file rewritten with new marker.
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);

    // Loud-log invariant: operators should see in journalctl that the
    // reset happened and what was removed (else they'll think the wipe
    // never ran and try to do it manually anyway, defeating the purpose).
    expect(logs.some((l) => l.includes('Chain reset detected'))).toBe(true);
    expect(logs.some((l) => l.includes('Wiping'))).toBe(true);
  });

  it('handles missing chain-state files gracefully (subset wipe)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // Only seed store.nq; the others don't exist on this node yet.
    writeFileSync(join(dataDir, 'store.nq'), '...');

    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    // store.nq is backed up (renamed), not in removedFiles; nothing else existed.
    expect(result.removedFiles).toEqual([]);
    expect(result.backedUpFiles).toHaveLength(1);
    expect(result.backedUpFiles[0]).toMatch(/^store\.nq\.pre-wipe-/);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(existsSync(join(dataDir, result.backedUpFiles[0]))).toBe(true);
  });

  it('is idempotent: a second call with the same input is a no-op', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);

    const first = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });
    expect(first.wiped).toBe(true);

    // Re-seed the chain-state files to simulate "boot, work, boot again".
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const second = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });
    expect(second.wiped).toBe(false);
    expect(second.prevMarker).toBe(NEW_MARKER);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
  });
});

describe('chainResetWipe — corrupt state file', () => {
  it('treats unparseable state as missing (first-boot semantics)', async () => {
    writeFileSync(join(dataDir, STATE_FILE), '{ this is not valid JSON');
    seedAllFiles(dataDir);

    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    expect(result.prevMarker).toBeNull();
    // State file gets rewritten with the current marker.
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);
  });
});

// =====================================================================
// #679 — dev-loop opt-out + store.nq backup / rotation
// =====================================================================
//
// Two operator-facing additions guarded here:
//   - DKG_SKIP_CHAIN_RESET_WIPE=1 (the `skip` option): a monorepo developer
//     can hop between marker-pinned worktrees without losing their local
//     store. The wipe is bypassed AND the marker is deliberately NOT persisted,
//     so the wipe re-triggers the moment the flag is unset. The operator
//     guarantee is unchanged — skip unset still wipes by default.
//   - store.nq is RENAMED to store.nq.pre-wipe-<marker>-<ts> instead of being
//     hard-deleted, so a wrongly-triggered wipe is recoverable; old backups
//     rotate down to maxStoreBackups (default 3). backupStore:false restores
//     the hard-delete. A rename failure is a wipe failure: the marker is not
//     persisted and the wipe retries on the next boot.

function readPersistedMarker(dir: string): string | null {
  return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')).chainResetMarker;
}

describe('chainResetWipe — operator-mode invariant (#679)', () => {
  it('skip unset (operator default) still wipes and persists the marker on a marker change', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);

    // skip:false is the effective value when DKG_SKIP_CHAIN_RESET_WIPE is unset
    // (skip:undefined behaves identically — the opt-out must never weaken the
    // operator guarantee).
    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: false });

    expect(result.wiped).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.prevMarker).toBe(OLD_MARKER);

    // Chain-state gone (store.nq via backup, the rest hard-deleted)...
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(false);
    expect(existsSync(join(dataDir, 'publish-journal.0'))).toBe(false);
    expect(result.backedUpFiles).toHaveLength(1);
    // The backup holds the original store.nq bytes (seedAllFiles wrote this) —
    // a wrongly-triggered wipe is recoverable by renaming the file back.
    expect(readFileSync(join(dataDir, result.backedUpFiles[0]), 'utf8')).toBe('<s> <p> <o> .');
    // ...operator identity preserved...
    expect(existsSync(join(dataDir, 'wallets.json'))).toBe(true);
    // ...and the marker advanced, so next boot is steady-state.
    expect(readPersistedMarker(dataDir)).toBe(NEW_MARKER);
  });
});

describe('chainResetWipe — dev-loop opt-out (skip, #679)', () => {
  it('skip=true bypasses the wipe, preserves local chain-state, and does NOT persist the marker', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);
    const logs: string[] = [];

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      skip: true,
      log: (m) => logs.push(m),
    });

    expect(result.wiped).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.prevMarker).toBe(OLD_MARKER);
    expect(result.removedFiles).toEqual([]);
    expect(result.backedUpFiles).toEqual([]);

    // Every chain-state file survives untouched.
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(existsSync(join(dataDir, 'store.nq.tmp'))).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
    expect(existsSync(join(dataDir, 'publish-journal.0'))).toBe(true);

    // Marker deliberately NOT advanced, so unsetting the flag re-triggers.
    expect(readPersistedMarker(dataDir)).toBe(OLD_MARKER);
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);
  });

  it('skip short-circuits the backup — no rename, store.nq is byte-for-byte untouched', async () => {
    writeFileSync(join(dataDir, 'store.nq'), 'ORIGINAL');

    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: true });

    expect(result.skipped).toBe(true);
    expect(result.backedUpFiles).toEqual([]);
    expect(readFileSync(join(dataDir, 'store.nq'), 'utf8')).toBe('ORIGINAL');
    // No pre-wipe sibling was written.
    expect(readdirSync(dataDir).some((f) => f.startsWith('store.nq.pre-wipe-'))).toBe(false);
  });

  it('unsetting skip after a skipped boot re-triggers the wipe (marker was never persisted)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    // Boot 1: developer has the opt-out set → store preserved, marker untouched.
    const skipped = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: true });
    expect(skipped.skipped).toBe(true);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(readPersistedMarker(dataDir)).toBe(OLD_MARKER);

    // Boot 2: flag unset → the wipe finally runs because the marker never advanced.
    const wiped = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: false });
    expect(wiped.wiped).toBe(true);
    expect(wiped.skipped).toBe(false);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(readPersistedMarker(dataDir)).toBe(NEW_MARKER);
  });

  it('skip=true does not attempt the external SPARQL wipe (fetch is never called)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    let fetchCalls = 0;
    const fn: typeof globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      skip: true,
      // An external backend is configured; skip must short-circuit BEFORE the
      // external wipe just as it does before the local file wipe.
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://blaze.test/sparql', managedByDkg: true },
      },
      fetch: fn,
    });

    expect(result.skipped).toBe(true);
    expect(result.wiped).toBe(false);
    expect(fetchCalls).toBe(0); // no external SPARQL request issued
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true); // local store preserved too
  });

  it('skip is irrelevant when the marker already matches (equal no-op is unchanged)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: NEW_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);

    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: true });

    // The equal-marker short-circuit returns BEFORE the skip branch, so a match
    // reports skipped:false (not a bypass — there was simply nothing to bypass).
    expect(result.wiped).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.backedUpFiles).toEqual([]);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
  });
});

describe('chainResetWipe — store.nq backup + rotation (#679)', () => {
  it('renames store.nq to store.nq.pre-wipe-<marker>-<ts> and keeps it recoverable (default)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), 'PRECIOUS_TRIPLES');

    const logs: string[] = [];
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      log: (m) => logs.push(m),
    });

    expect(result.wiped).toBe(true);
    expect(result.removedFiles).not.toContain('store.nq');
    expect(result.backedUpFiles).toHaveLength(1);
    const backup = result.backedUpFiles[0];
    // <marker> is sanitized ([^A-Za-z0-9._-] → _); NEW_MARKER is already clean.
    expect(backup).toMatch(/^store\.nq\.pre-wipe-v10-rs-staking-consolidation-2026-04-30-\d+$/);

    // Original gone; the backup holds the original bytes (recoverable by rename-back).
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(readFileSync(join(dataDir, backup), 'utf8')).toBe('PRECIOUS_TRIPLES');
    // A clean backup is not a failure — the marker advances.
    expect(readPersistedMarker(dataDir)).toBe(NEW_MARKER);
    expect(logs.some((l) => l.includes('backed up: store.nq'))).toBe(true);
  });

  it('backupStore=false hard-deletes store.nq (no backup file)', async () => {
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      backupStore: false,
    });

    expect(result.wiped).toBe(true);
    expect(result.removedFiles).toContain('store.nq');
    expect(result.backedUpFiles).toEqual([]);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(readdirSync(dataDir).some((f) => f.startsWith('store.nq.pre-wipe-'))).toBe(false);
  });

  it('rotates store.nq backups down to maxStoreBackups, keeping the newest', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // Three older backups with distinct embedded timestamps (rotation sorts on
    // the trailing -<digits>). Real Date.now() for the new backup is ≫ these.
    writeFileSync(join(dataDir, 'store.nq.pre-wipe-old-100'), 'b100');
    writeFileSync(join(dataDir, 'store.nq.pre-wipe-old-200'), 'b200');
    writeFileSync(join(dataDir, 'store.nq.pre-wipe-old-300'), 'b300');
    writeFileSync(join(dataDir, 'store.nq'), 'newest');

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      maxStoreBackups: 2,
    });

    expect(result.wiped).toBe(true);
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('store.nq.pre-wipe-'));
    // 3 pre-seeded + 1 new = 4 → rotated down to the newest 2.
    expect(backups).toHaveLength(2);
    expect(backups).toContain(result.backedUpFiles[0]); // just-created (Date.now() ≫ seeds) survives
    expect(backups).toContain('store.nq.pre-wipe-old-300'); // 2nd-newest kept
    expect(backups).not.toContain('store.nq.pre-wipe-old-200'); // rotated out
    expect(backups).not.toContain('store.nq.pre-wipe-old-100'); // oldest rotated out
  });

  it('records a store.nq rename failure and does NOT persist the marker (retries next boot)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), 'PRECIOUS');

    // Pin Date.now so the backup target name is deterministic, then pre-create
    // that exact path as a NON-EMPTY DIRECTORY. renameSync(file → existing dir)
    // throws on every platform (EISDIR / EPERM) — a deterministic, cross-platform
    // rename failure that (unlike chmod) also reproduces on Windows.
    const FIXED = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED);
    try {
      const blockingDir = join(
        dataDir,
        `store.nq.pre-wipe-v10-rs-staking-consolidation-2026-04-30-${FIXED}`,
      );
      mkdirSync(blockingDir, { recursive: true });
      writeFileSync(join(blockingDir, 'occupied'), 'x');

      const logs: string[] = [];
      const result = await chainResetWipe({
        dataDir,
        currentMarker: NEW_MARKER,
        log: (m) => logs.push(m),
      });

      // The wipe ran, but the store.nq backup step failed.
      expect(result.wiped).toBe(true);
      expect(result.backedUpFiles).toEqual([]);
      expect(result.failedFiles.some((f) => f.file === 'store.nq')).toBe(true);
      // Rename failed → the original store.nq is still there (recoverable).
      expect(readFileSync(join(dataDir, 'store.nq'), 'utf8')).toBe('PRECIOUS');
      // Marker NOT persisted — the wipe must retry on the next boot.
      expect(readPersistedMarker(dataDir)).toBe(OLD_MARKER);
      expect(logs.some((l) => l.includes('marker was not persisted'))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('sanitizes a filesystem-unsafe marker so the backup rename succeeds (no boot-loop)', async () => {
    // A marker with `/`, space and `:` — unsanitized, the `/` would make
    // renameSync target a nested path → throw → store.nq lands in failedFiles →
    // the marker never persists → the node re-wipes on EVERY boot. The sanitize
    // guard (`[^A-Za-z0-9._-]` → `_`) must keep the backup name flat.
    const DIRTY = 'v10/reset 2026:step';
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), 'DIRTY_MARKER_BYTES');

    const result = await chainResetWipe({ dataDir, currentMarker: DIRTY });

    expect(result.wiped).toBe(true);
    expect(result.failedFiles).toEqual([]); // rename did NOT hit a nested-path failure
    expect(result.backedUpFiles).toHaveLength(1);
    // Every non-[A-Za-z0-9._-] char collapsed to `_` (flat filename, no `/`).
    expect(result.backedUpFiles[0]).toMatch(/^store\.nq\.pre-wipe-v10_reset_2026_step-\d+$/);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(readFileSync(join(dataDir, result.backedUpFiles[0]), 'utf8')).toBe('DIRTY_MARKER_BYTES');
    // The RAW (unsanitized) marker is persisted — only the FILENAME is sanitized,
    // so steady state is reached and the boot-loop is avoided.
    expect(readPersistedMarker(dataDir)).toBe(DIRTY);
  });

  it('rotation eviction failure is swallowed — wipe still succeeds and the marker persists', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // Newest OTHER backup (kept); oldest OTHER is an un-removable NON-EMPTY
    // DIRECTORY so the eviction `rmSync(..., { force: true })` (no recursive)
    // throws — best-effort rotation must swallow it, not fail the boot.
    writeFileSync(join(dataDir, 'store.nq.pre-wipe-old-200'), 'keeper');
    mkdirSync(join(dataDir, 'store.nq.pre-wipe-old-100'), { recursive: true });
    writeFileSync(join(dataDir, 'store.nq.pre-wipe-old-100', 'occupied'), 'x');
    writeFileSync(join(dataDir, 'store.nq'), 'fresh');

    const logs: string[] = [];
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      maxStoreBackups: 2,
      log: (m) => logs.push(m),
    });

    expect(result.wiped).toBe(true);
    // A swallowed rotation error is NOT a wipe failure — failedFiles stays empty...
    expect(result.failedFiles).toEqual([]);
    // ...and the marker still advances (no retry-forever).
    expect(readPersistedMarker(dataDir)).toBe(NEW_MARKER);
    // The rotation was attempted and its failure logged as a swallowed WARN.
    expect(logs.some((l) => l.includes('failed to rotate out old store backup'))).toBe(true);
    // Fresh backup + the newest kept OTHER both survive; the un-removable old one
    // simply remains (best-effort eviction gave up on it).
    expect(result.backedUpFiles).toHaveLength(1);
    expect(existsSync(join(dataDir, result.backedUpFiles[0]))).toBe(true);
    expect(existsSync(join(dataDir, 'store.nq.pre-wipe-old-200'))).toBe(true);
    expect(existsSync(join(dataDir, 'store.nq.pre-wipe-old-100'))).toBe(true);
  });

  it('keeps the FRESH backup over an old one with a larger embedded ts (clock-skew guard)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // Planted OLD backup with a 14-digit embedded ts — larger than any real
    // 13-digit Date.now(). Under pure ts-ranking this would outrank and evict the
    // fresh snapshot; the keepName exemption must protect the fresh one instead.
    const planted = 'store.nq.pre-wipe-oldmarker-99999999999999';
    writeFileSync(join(dataDir, planted), 'stale');
    writeFileSync(join(dataDir, 'store.nq'), 'fresh');

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      maxStoreBackups: 1,
    });

    expect(result.wiped).toBe(true);
    expect(result.backedUpFiles).toHaveLength(1);
    const fresh = result.backedUpFiles[0];
    // Fresh recovery snapshot survives despite its smaller embedded ts...
    expect(existsSync(join(dataDir, fresh))).toBe(true);
    // ...and the planted larger-ts backup is the one evicted (maxStoreBackups:1,
    // keepOthers=0). Without the exemption this assertion would invert.
    expect(existsSync(join(dataDir, planted))).toBe(false);
  });
});

describe('chainResetWipe — custom random-sampling WAL path (PR #357 feedback)', () => {
  // Codex review found that operators who set `randomSampling.walPath` in
  // their config keep a stale WAL across chain resets — the wipe was
  // hardcoding `dataDir/random-sampling.wal`. These tests pin the fix.

  it('wipes the operator-supplied WAL path when set, not the default', async () => {
    const customWal = join(dataDir, 'custom', 'rs.wal');
    mkdirSync(join(dataDir, 'custom'), { recursive: true });
    writeFileSync(customWal, 'WAL\n');
    // Default-path WAL also present — must NOT be touched (caller has
    // explicitly redirected, default is dead from prover's POV).
    writeFileSync(join(dataDir, 'random-sampling.wal'), 'STALE\n');
    writeFileSync(join(dataDir, 'store.nq'), '...');

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      randomSamplingWalPath: customWal,
    });

    expect(result.wiped).toBe(true);
    expect(existsSync(customWal)).toBe(false);
    // Default path untouched: prover never reads it under this config.
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
  });

  it('falls back to default WAL path when randomSamplingWalPath is empty', async () => {
    writeFileSync(join(dataDir, 'random-sampling.wal'), 'WAL\n');

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      randomSamplingWalPath: '',
    });

    expect(result.wiped).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(false);
  });

  it('handles WAL path outside dataDir (absolute, e.g. /var/lib/dkg/wal)', async () => {
    const externalWalDir = mkdtempSync(join(tmpdir(), 'dkg-external-wal-'));
    const externalWal = join(externalWalDir, 'rs.wal');
    writeFileSync(externalWal, 'EXTERNAL_WAL\n');

    try {
      const result = await chainResetWipe({
        dataDir,
        currentMarker: NEW_MARKER,
        randomSamplingWalPath: externalWal,
      });

      expect(result.wiped).toBe(true);
      expect(existsSync(externalWal)).toBe(false);
      // Display label should be the absolute path (informative for operators).
      expect(result.removedFiles.some((f) => f === externalWal)).toBe(true);
    } finally {
      rmSync(externalWalDir, { recursive: true, force: true });
    }
  });
});

describe('chainResetWipe — FS errors must not crash boot (PR #357 feedback)', () => {
  // Per the runbook contract — and Codex review feedback — wipe failures
  // should be logged so operators can act, but the daemon must continue
  // to boot. Crashing here would create a worse failure mode (node down)
  // than the original problem (stale state).

  it('logs and continues when saveState throws (e.g. read-only FS)', async () => {
    // Make dataDir read-only so writeFileSync on the state file throws.
    // Skip on platforms where chmod 0o555 doesn't actually deny root or
    // where tests run as root (CI containers); the scenario we care
    // about is non-root operator with a misconfigured volume mount.
    const originalMode = statSync(dataDir).mode;
    let logsCaptured: string[] = [];

    try {
      chmodSync(dataDir, 0o555);

      // Quick capability check: if writeFileSync still works (root /
      // certain FUSE mounts), skip the rest of the assertion — we
      // can't synthesize the failure deterministically.
      try {
        writeFileSync(join(dataDir, '.probe'), 'x');
        rmSync(join(dataDir, '.probe'), { force: true });
        return;
      } catch {
        // Good: FS denied the write. Now run the wipe.
      }

      await expect(
        chainResetWipe({
          dataDir,
          currentMarker: NEW_MARKER,
          log: (msg) => logsCaptured.push(msg),
        }),
      ).resolves.toBeDefined();

      // Loud log so operators can find this in journalctl.
      expect(logsCaptured.some((l) => l.includes('failed to persist chain reset marker'))).toBe(true);
    } finally {
      chmodSync(dataDir, originalMode);
    }
  });

  it('does not save the marker when an individual file wipe throws', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');
    writeFileSync(join(dataDir, '.probe'), 'x');

    const originalMode = statSync(dataDir).mode;
    const logsCaptured: string[] = [];
    try {
      chmodSync(dataDir, 0o555);
      try {
        rmSync(join(dataDir, '.probe'), { force: true });
        return;
      } catch {
        // Good: removing from this directory is denied for this process.
      }

      const result = await chainResetWipe({
        dataDir,
        currentMarker: NEW_MARKER,
        log: (msg) => logsCaptured.push(msg),
      });
      expect(result.failedFiles.some((f) => f.file === 'store.nq')).toBe(true);
    } finally {
      chmodSync(dataDir, originalMode);
      rmSync(join(dataDir, '.probe'), { force: true });
    }

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(OLD_MARKER);
    expect(logsCaptured.some((l) => l.includes('marker was not persisted'))).toBe(true);
  });
});

// =====================================================================
// External SPARQL wipe (RFC 120, plan PR 1 item 5b)
// =====================================================================
//
// Operators who configure an external triple-store backend (Blazegraph
// or sparql-http) need the same "stale state goes away on chain reset"
// guarantee as Oxigraph operators get from the local file wipe. The
// wipe runs a SPARQL UPDATE against the configured endpoint after the
// local file wipe. Two modes:
//
//   - `managedByDkg: true` (Docker convenience path, PR 3): DROP ALL.
//     Safe because the CLI owns the namespace exclusively.
//   - operator-provided URL (default): scoped DELETE filtered by the
//     V10 named-graph prefix `did:dkg:context-graph:` so V6/V8 nodes or
//     unrelated data sharing the same Blazegraph instance survive.
//
// Failures append to `failedFiles`, marker is not persisted, wipe
// retries on next boot — same partial-failure semantics as the local
// file wipe.

describe('chainResetWipe — external SPARQL wipe', () => {
  type FetchCall = { url: string; init?: RequestInit };

  function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
    const calls: FetchCall[] = [];
    const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
      const call: FetchCall = { url: String(input), init };
      calls.push(call);
      return handler(call);
    }) as typeof globalThis.fetch;
    return { fn, calls };
  }

  function decodeUpdateBody(body: unknown): string {
    const s = String(body ?? '');
    if (!s.startsWith('update=')) return '';
    return decodeURIComponent(s.slice('update='.length));
  }

  it('issues DROP ALL when storeConfig.options.managedByDkg=true', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://blaze.test/sparql', managedByDkg: true },
      },
      fetch: fn,
    });

    expect(result.wiped).toBe(true);
    expect(result.failedFiles).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://blaze.test/sparql');
    expect(decodeUpdateBody(calls[0].init?.body)).toBe('DROP ALL');
    expect(result.removedFiles.some((f) => f.includes('drop-all'))).toBe(true);
  });

  it('issues scoped DELETE when managedByDkg is false (operator URL — V6/V8 safety)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://shared-blaze.test/sparql' },
      },
      fetch: fn,
    });

    expect(result.wiped).toBe(true);
    expect(calls).toHaveLength(1);
    const update = decodeUpdateBody(calls[0].init?.body);
    expect(update).toContain('DELETE');
    expect(update).toContain('did:dkg:context-graph:');
    expect(update).toContain('strstarts');
    expect(update).not.toBe('DROP ALL');
  });

  it('records SPARQL failure in failedFiles + does not persist marker', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const { fn } = mockFetch(
      () => new Response('endpoint exploded', { status: 500, statusText: 'Server Error' }),
    );
    const logs: string[] = [];
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://broken.test/sparql' },
      },
      fetch: fn,
      log: (m) => logs.push(m),
    });

    expect(result.wiped).toBe(true);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failedFiles[0].file).toContain('scoped-delete');
    expect(result.failedFiles[0].error).toContain('500');

    // Local files still wiped (we don't gate file wipe on SPARQL).
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);

    // Marker NOT persisted — retry on next boot.
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(OLD_MARKER);
    expect(logs.some((l) => l.includes('Chain reset marker was not persisted'))).toBe(true);
  });

  it('records transport error in failedFiles', async () => {
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const fn: typeof globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;

    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      storeConfig: {
        backend: 'blazegraph',
        options: { url: 'http://nope.test/sparql' },
      },
      fetch: fn,
    });

    expect(result.failedFiles.some((f) => f.error.includes('ECONNREFUSED'))).toBe(true);
  });

  it('skips external wipe entirely for local backends (storeConfig present, backend oxigraph-worker)', async () => {
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      storeConfig: {
        backend: 'oxigraph-worker',
        // Options that LOOK like an external URL: these must be ignored
        // because the backend itself is local. Otherwise an operator who
        // hand-tuned options would see surprise SPARQL requests.
        options: { url: 'http://ignored.test/sparql' as unknown as string },
      },
      fetch: fn,
    });

    expect(result.wiped).toBe(true);
    expect(calls).toHaveLength(0);
    expect(result.failedFiles).toEqual([]);
  });

  it('uses sparql-http updateEndpoint when configured separately from queryEndpoint', async () => {
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      storeConfig: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://server.test/query',
          updateEndpoint: 'http://server.test/update',
          auth: 'Bearer t0ken',
          managedByDkg: false,
        },
      },
      fetch: fn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://server.test/update');
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t0ken');
  });
});

// =====================================================================
// Backend-switch detection (RFC 120 review point #6 / plan PR 1 item 8)
// =====================================================================
//
// Without an explicit check, an operator who hand-edits
// `config.store.backend` between boots gets a fresh empty backend and
// no warning — looks identical to data loss. detectBackendSwitch tags
// each boot's backend into the same `.network-state.json` file and
// refuses to boot on mismatch unless `acceptStoreReset` is true.

describe('detectBackendSwitch', () => {
  it('records current backend on first boot (no state file) without warning', () => {
    const logs: string[] = [];
    const result = detectBackendSwitch({
      dataDir,
      currentBackend: 'oxigraph-worker',
      acceptStoreReset: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(false);
    expect(result.previous).toBeNull();
    expect(result.aborted).toBe(false);

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastBackend).toBe('oxigraph-worker');
    // First-boot path is silent — no STORE-SWITCH warning header.
    expect(logs.find((l) => l.includes('STORE-SWITCH'))).toBeUndefined();
  });

  it('records current backend on a legacy state file (lastBackend absent) without warning', () => {
    // Legacy: state file from before this field was added. Has only
    // chainResetMarker + savedAt.
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: NEW_MARKER, savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectBackendSwitch({
      dataDir,
      currentBackend: 'blazegraph',
      acceptStoreReset: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(false);
    expect(result.previous).toBeNull();
    expect(result.aborted).toBe(false);

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastBackend).toBe('blazegraph');
    // chainResetMarker must survive the backend-tag write.
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);
  });

  it('is a no-op when backend matches previous boot', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: null, lastBackend: 'oxigraph-worker', savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectBackendSwitch({
      dataDir,
      currentBackend: 'oxigraph-worker',
      acceptStoreReset: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(false);
    expect(result.previous).toBe('oxigraph-worker');
    expect(result.aborted).toBe(false);
    expect(logs).toEqual([]);
  });

  it('aborts boot on mismatch without acceptStoreReset, surfaces multi-line warning', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: null, lastBackend: 'oxigraph-worker', savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectBackendSwitch({
      dataDir,
      currentBackend: 'blazegraph',
      acceptStoreReset: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(true);
    expect(result.previous).toBe('oxigraph-worker');
    expect(result.aborted).toBe(true);

    const joined = logs.join('\n');
    expect(joined).toMatch(/STORE-SWITCH/);
    expect(joined).toMatch(/previous: oxigraph-worker/);
    expect(joined).toMatch(/current:\s+blazegraph/);
    expect(joined).toMatch(/DKG_ACCEPT_STORE_RESET=1/);

    // State file MUST still record the old backend so a corrected
    // config (operator reverts the edit) sees a match on next boot.
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastBackend).toBe('oxigraph-worker');
  });

  it('proceeds and updates state when acceptStoreReset=true', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: null, lastBackend: 'oxigraph-worker', savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectBackendSwitch({
      dataDir,
      currentBackend: 'blazegraph',
      acceptStoreReset: true,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(true);
    expect(result.aborted).toBe(false);

    // Warning still surfaces so the choice is visible in journalctl,
    // but with the "proceeding" tail rather than the "refusing" tail.
    const joined = logs.join('\n');
    expect(joined).toMatch(/STORE-SWITCH/);
    expect(joined).toMatch(/proceeding/i);
    expect(joined).not.toMatch(/Refusing to start/);

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastBackend).toBe('blazegraph');
  });

  it('coexists with chainResetWipe — wipe does not clobber the backend tag', async () => {
    // Establish a baseline by running detectBackendSwitch first.
    detectBackendSwitch({
      dataDir,
      currentBackend: 'oxigraph-worker',
      acceptStoreReset: false,
    });
    expect(
      JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8')).lastBackend,
    ).toBe('oxigraph-worker');

    // Now run a marker change — the wipe path persists chainResetMarker
    // and MUST preserve lastBackend.
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');
    await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
    });

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);
    expect(persisted.lastBackend).toBe('oxigraph-worker');
  });
});

describe('detectNetworkSwitch', () => {
  it('records current network on first boot (no state file) without warning', () => {
    const logs: string[] = [];
    const result = detectNetworkSwitch({
      dataDir,
      currentNetworkConfig: 'testnet',
      acceptNetworkSwitch: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(false);
    expect(result.previous).toBeNull();
    expect(result.aborted).toBe(false);

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastNetworkConfig).toBe('testnet');
    expect(logs.find((l) => l.includes('NETWORK-SWITCH'))).toBeUndefined();
  });

  it('records current network on a legacy state file (lastNetworkConfig absent) without aborting', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: NEW_MARKER, lastBackend: 'oxigraph-worker', savedAt: Date.now() }),
    );

    const result = detectNetworkSwitch({
      dataDir,
      currentNetworkConfig: 'mainnet-gnosis',
      acceptNetworkSwitch: false,
    });

    expect(result.changed).toBe(false);
    expect(result.previous).toBeNull();
    expect(result.aborted).toBe(false);

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastNetworkConfig).toBe('mainnet-gnosis');
    // Sibling fields must survive the network-tag write.
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);
    expect(persisted.lastBackend).toBe('oxigraph-worker');
  });

  it('is a no-op when network matches previous boot', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: null, lastNetworkConfig: 'mainnet-gnosis', savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectNetworkSwitch({
      dataDir,
      currentNetworkConfig: 'mainnet-gnosis',
      acceptNetworkSwitch: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(false);
    expect(result.previous).toBe('mainnet-gnosis');
    expect(result.aborted).toBe(false);
    expect(logs).toEqual([]);
  });

  it('aborts boot on mismatch without acceptNetworkSwitch, surfaces multi-line warning', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: null, lastNetworkConfig: 'testnet', savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectNetworkSwitch({
      dataDir,
      currentNetworkConfig: 'mainnet-gnosis',
      acceptNetworkSwitch: false,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(true);
    expect(result.previous).toBe('testnet');
    expect(result.aborted).toBe(true);

    const joined = logs.join('\n');
    expect(joined).toMatch(/NETWORK-SWITCH/);
    expect(joined).toMatch(/previous: testnet/);
    expect(joined).toMatch(/current:\s+mainnet-gnosis/);
    expect(joined).toMatch(/DKG_ACCEPT_NETWORK_SWITCH=1/);

    // The old tag must persist so reverting config.networkConfig matches next boot.
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastNetworkConfig).toBe('testnet');
  });

  it('proceeds and updates state when acceptNetworkSwitch=true', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: null, lastNetworkConfig: 'testnet', savedAt: Date.now() }),
    );

    const logs: string[] = [];
    const result = detectNetworkSwitch({
      dataDir,
      currentNetworkConfig: 'mainnet-gnosis',
      acceptNetworkSwitch: true,
      log: (m) => logs.push(m),
    });

    expect(result.changed).toBe(true);
    expect(result.aborted).toBe(false);

    const joined = logs.join('\n');
    expect(joined).toMatch(/NETWORK-SWITCH/);
    expect(joined).toMatch(/proceeding/i);
    expect(joined).not.toMatch(/Refusing to start/);

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastNetworkConfig).toBe('mainnet-gnosis');
  });

  it('coexists with detectBackendSwitch — both tags persist independently', () => {
    detectBackendSwitch({ dataDir, currentBackend: 'oxigraph-worker', acceptStoreReset: false });
    detectNetworkSwitch({ dataDir, currentNetworkConfig: 'mainnet-gnosis', acceptNetworkSwitch: false });

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.lastBackend).toBe('oxigraph-worker');
    expect(persisted.lastNetworkConfig).toBe('mainnet-gnosis');
  });
});
