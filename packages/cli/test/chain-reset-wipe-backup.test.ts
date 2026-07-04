/**
 * #679 — chain-reset wipe: store.nq backup, retention/rotation, the dev opt-out,
 * and the marker sanitize/cap guards. Split out of chain-reset-wipe.test.ts (which
 * keeps the core opt-in / first-boot / marker-change / backend+network-switch
 * suites) so this file focuses on the always-on backup + skip surface.
 *
 * Model under test (post review round 1):
 *   - store.nq is ALWAYS backed up: renamed to `store.nq.pre-wipe-<marker>-<ts>`
 *     rather than deleted (there is no hard-delete path). The marker portion is
 *     sanitized (`[^A-Za-z0-9._-]` → `_`) and capped at 120 chars so the filename
 *     stays under the 255-byte component limit; the RAW marker still persists in
 *     `.network-state.json`.
 *   - Retention is bounded to MAX_STORE_BACKUPS (3). `rotateStoreBackups` ranks the
 *     OTHER backups by filesystem MTIME (unreadable stat → oldest) and ALWAYS keeps
 *     the just-created backup (`keepName`) — clock steps can't evict the fresh snapshot.
 *   - `DKG_SKIP_CHAIN_RESET_WIPE=1` (the `skip` option, read via `skipChainResetWipe`)
 *     bypasses the wipe and does NOT persist the marker, so unsetting re-triggers it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chainResetWipe,
  selectBackupsToRotate,
  skipChainResetWipe,
} from '../src/daemon/chain-reset-wipe.js';

// The ESM `node:fs` namespace can't be spied (its exports aren't configurable),
// so to force a deterministic, cross-platform `renameSync` failure we mock the
// module: every fn delegates to the real implementation, and `renameSync` throws
// only while `fsControl.throwOnRename` is set. A plain gated function (not a
// vi.fn) so the suite's `vi.restoreAllMocks()` can't reset it between tests.
const fsControl = vi.hoisted(() => ({ throwOnRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    renameSync: ((...args: Parameters<typeof orig.renameSync>): void => {
      if (fsControl.throwOnRename) throw new Error('EPERM: mocked rename');
      return orig.renameSync(...args);
    }) as typeof orig.renameSync,
  };
});

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

function readPersistedMarker(dir: string): string | null {
  return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')).chainResetMarker;
}

// Seed a `store.nq.pre-wipe-*` backup and optionally pin its mtime (rotation
// ranks by mtime, so tests control ordering with utimesSync, not filename ts).
function seedBackup(name: string, mtime?: Date): string {
  const p = join(dataDir, name);
  writeFileSync(p, name);
  if (mtime) utimesSync(p, mtime, mtime);
  return name;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dkg-wipe-backup-test-'));
});

afterEach(() => {
  fsControl.throwOnRename = false; // defensive: never let a rename-failure injection leak
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
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

  it('first-boot skip (no state file) leaves the marker unpersisted and re-triggers on unset', async () => {
    // #679 core guarantee for the FIRST-BOOT-with-marker case (prevMarker null):
    // skip must not create a state file, so unsetting the flag still wipes.
    // Guards a regression that only skipped persistence when prevMarker != null.
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(false); // no prior state

    // Boot 1: opt-out set, first boot (no persisted marker) → store preserved and
    // — crucially — NO state file written.
    const skipped = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: true });
    expect(skipped.skipped).toBe(true);
    expect(skipped.wiped).toBe(false);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(false); // marker NOT persisted
    expect(readPersistedMarker(dataDir)).toBeNull();

    // Boot 2: flag unset → the wipe finally runs, because the marker never advanced.
    const wiped = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER, skip: false });
    expect(wiped.wiped).toBe(true);
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

describe('chainResetWipe — store.nq backup rename (#679)', () => {
  it('renames store.nq to store.nq.pre-wipe-<marker>-<ts> and keeps it recoverable', async () => {
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

  it('caps an overlong marker in the backup filename but persists the RAW marker (no ENAMETOOLONG loop)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), 'BIG_MARKER_BYTES');
    const BIG = 'a'.repeat(300); // 300-char valid marker (all sanitize-clean)

    const result = await chainResetWipe({ dataDir, currentMarker: BIG });

    expect(result.wiped).toBe(true);
    expect(result.failedFiles).toEqual([]);
    expect(result.backedUpFiles).toHaveLength(1);
    const backup = result.backedUpFiles[0];
    // Marker portion capped at 120 → total filename comfortably under the 255 limit.
    expect(backup).toMatch(/^store\.nq\.pre-wipe-a{120}-\d+$/);
    expect(backup.length).toBeLessThan(255);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(readFileSync(join(dataDir, backup), 'utf8')).toBe('BIG_MARKER_BYTES');
    // The RAW (uncapped) 300-char marker is what persists.
    expect(readPersistedMarker(dataDir)).toBe(BIG);

    // Second boot with the same marker = no-op → steady state, no re-wipe loop.
    writeFileSync(join(dataDir, 'store.nq'), 'REGENERATED');
    const second = await chainResetWipe({ dataDir, currentMarker: BIG });
    expect(second.wiped).toBe(false);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
  });

  it('records a store.nq rename failure and does NOT persist the marker (retries next boot)', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), 'PRECIOUS');

    // The collision guard picks a FREE target before renaming, so blocking the
    // target path no longer forces a failure — inject the throw at `renameSync`
    // itself (via the mocked node:fs). Deterministic and cross-platform (works on
    // Windows, unlike chmod).
    fsControl.throwOnRename = true; // reset defensively in afterEach
    const logs: string[] = [];
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      log: (m) => logs.push(m),
    });

    // The wipe ran, but the store.nq backup step failed at renameSync...
    expect(result.wiped).toBe(true);
    expect(result.backedUpFiles).toEqual([]);
    const storeFailure = result.failedFiles.find((f) => f.file === 'store.nq');
    expect(storeFailure).toBeDefined();
    expect(storeFailure!.error).toContain('mocked rename'); // proves the mock intercepted
    // Rename threw before moving → the original store.nq is still there (recoverable).
    expect(readFileSync(join(dataDir, 'store.nq'), 'utf8')).toBe('PRECIOUS');
    // Marker NOT persisted — the wipe must retry on the next boot.
    expect(readPersistedMarker(dataDir)).toBe(OLD_MARKER);
    expect(logs.some((l) => l.includes('marker was not persisted'))).toBe(true);
  });

  it('never overwrites an existing backup — appends a counter on a name collision (🔴 OXNZb)', async () => {
    // Pin the clock so the generated backup name is known. renameSync silently
    // OVERWRITES an existing file, so if the exact target name already exists the
    // guard must append `-<n>` rather than clobber the prior recovery snapshot.
    const FIXED = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED);
    try {
      writeFileSync(
        join(dataDir, STATE_FILE),
        JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: FIXED }),
      );
      // NEW_MARKER is sanitize-clean and < 120 chars, so this is the exact base.
      const base = `store.nq.pre-wipe-v10-rs-staking-consolidation-2026-04-30-${FIXED}`;
      writeFileSync(join(dataDir, base), 'PRIOR_BACKUP'); // occupies the base name
      writeFileSync(join(dataDir, 'store.nq'), 'NEW_STORE');

      const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

      expect(result.failedFiles).toEqual([]);
      // The fresh backup takes the SUFFIXED name, not the occupied base.
      expect(result.backedUpFiles).toEqual([`${base}-1`]);
      // The prior backup is byte-for-byte intact (NOT clobbered)...
      expect(readFileSync(join(dataDir, base), 'utf8')).toBe('PRIOR_BACKUP');
      // ...and the new backup holds the just-wiped store.nq bytes.
      expect(readFileSync(join(dataDir, `${base}-1`), 'utf8')).toBe('NEW_STORE');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('stamps the backup mtime to CREATION time, not store.nq\'s inherited content mtime', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    writeFileSync(join(dataDir, 'store.nq'), 'STALE_CONTENT');
    // Backdate store.nq far into the past — the #679 dev case where store.nq is
    // untouched across quick branch switches. renameSync carries this stale content
    // mtime onto the backup; the source re-stamps it to NOW so mtime-ranked rotation
    // can't evict a NEWER recovery snapshot in favour of this one. (Post-2000 date —
    // near-epoch dates don't apply via Windows utimesSync.)
    const stale = new Date('2001-01-01');
    utimesSync(join(dataDir, 'store.nq'), stale, stale);

    const testStart = Date.now();
    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.backedUpFiles).toHaveLength(1);
    const backupMtime = statSync(join(dataDir, result.backedUpFiles[0])).mtimeMs;
    // NOT the inherited 2001 content mtime (~9.78e11)...
    expect(backupMtime).toBeGreaterThan(Date.parse('2020-01-01'));
    // ...but the backup's creation time (this run), within a small clock slack.
    expect(backupMtime).toBeGreaterThanOrEqual(testStart - 5_000);
    expect(backupMtime).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

describe('selectBackupsToRotate (pure rotation policy, #679)', () => {
  // Pure seam: given (name, mtimeMs) entries + the fresh backup's keepName + a cap,
  // return the names to EVICT. No filesystem — plain arrays, deterministic.
  it('never returns keepName — even when keepName has the OLDEST mtimeMs (fresh-snapshot exemption)', () => {
    const evict = selectBackupsToRotate(
      [
        { name: 'keep', mtimeMs: 1 }, // oldest, but it is the fresh snapshot
        { name: 'a', mtimeMs: 9 },
        { name: 'b', mtimeMs: 5 },
      ],
      'keep',
      1, // keepOthers = 0 → every OTHER evicted, but keepName never is
    );
    expect(evict).toEqual(['a', 'b']);
    expect(evict).not.toContain('keep');
  });

  it('keeps the newest (max-1) OTHERS by mtimeMs DESC and returns the rest to evict', () => {
    const evict = selectBackupsToRotate(
      [
        { name: 'k', mtimeMs: 999 },
        { name: 'a', mtimeMs: 300 },
        { name: 'b', mtimeMs: 200 },
        { name: 'c', mtimeMs: 100 },
      ],
      'k',
      2, // keepOthers = 1 → keep the newest OTHER (a=300); evict the older ones
    );
    expect(evict).toEqual(['b', 'c']);
  });

  it('max:1 evicts ALL others (keepName retained, everything else rotated out)', () => {
    const evict = selectBackupsToRotate(
      [
        { name: 'k', mtimeMs: 5 },
        { name: 'x', mtimeMs: 9 },
        { name: 'y', mtimeMs: 1 },
      ],
      'k',
      1,
    );
    expect(evict).toEqual(['x', 'y']); // newest-first among the evicted
  });

  it('an mtimeMs:0 entry (the unreadable-stat sentinel) sorts oldest and is evicted below a real mtime', () => {
    const evict = selectBackupsToRotate(
      [
        { name: 'k', mtimeMs: 999 },
        { name: 'a', mtimeMs: 300 },
        { name: 'b', mtimeMs: 100 },
        { name: 'broken', mtimeMs: 0 }, // unreadable-stat sentinel
      ],
      'k',
      3, // keepOthers = 2 → a(300) + b(100) kept; only the mtimeMs:0 entry is dropped
    );
    expect(evict).toEqual(['broken']);
  });

  it('returns [] for empty input and for keepName-only input', () => {
    expect(selectBackupsToRotate([], 'k', 3)).toEqual([]);
    expect(selectBackupsToRotate([{ name: 'k', mtimeMs: 1 }], 'k', 3)).toEqual([]);
  });
});

describe('chainResetWipe — retention via rotation (#679)', () => {
  it('retains exactly MAX_STORE_BACKUPS (3): the fresh backup + the newest 2 OTHERS by mtime', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // Four OLD backups with ascending mtimes (old1 oldest … old4 newest); no cap
    // is passed to chainResetWipe, so the module default MAX_STORE_BACKUPS=3 applies.
    seedBackup('store.nq.pre-wipe-old1', new Date('2026-01-01'));
    seedBackup('store.nq.pre-wipe-old2', new Date('2026-02-01'));
    seedBackup('store.nq.pre-wipe-old3', new Date('2026-03-01'));
    seedBackup('store.nq.pre-wipe-old4', new Date('2026-04-01'));
    writeFileSync(join(dataDir, 'store.nq'), 'fresh');

    const result = await chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    const backups = readdirSync(dataDir).filter((f) => f.startsWith('store.nq.pre-wipe-'));
    // fresh (exempt) + newest 2 OTHERS (old4, old3) = 3; old1 + old2 evicted.
    expect(backups).toHaveLength(3);
    expect(backups).toContain(result.backedUpFiles[0]);
    expect(backups).toContain('store.nq.pre-wipe-old4');
    expect(backups).toContain('store.nq.pre-wipe-old3');
    expect(backups).not.toContain('store.nq.pre-wipe-old2');
    expect(backups).not.toContain('store.nq.pre-wipe-old1');
  });

  it('rotation eviction failure is swallowed — wipe still succeeds and the marker persists', async () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // 3 OTHERS so the default cap (3) must evict the oldest; that oldest is an
    // un-removable NON-EMPTY DIRECTORY, so the eviction rmSync (no recursive)
    // throws → best-effort rotation must swallow it, not fail the boot.
    seedBackup('store.nq.pre-wipe-keepA', new Date('2026-03-01'));
    seedBackup('store.nq.pre-wipe-keepB', new Date('2026-02-01'));
    const victim = join(dataDir, 'store.nq.pre-wipe-victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'occupied'), 'x');
    utimesSync(victim, new Date('2025-01-01'), new Date('2025-01-01')); // oldest → eviction target
    writeFileSync(join(dataDir, 'store.nq'), 'fresh');

    const logs: string[] = [];
    const result = await chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      log: (m) => logs.push(m),
    });

    expect(result.wiped).toBe(true);
    // A swallowed rotation error is NOT a wipe failure — failedFiles stays empty...
    expect(result.failedFiles).toEqual([]);
    // ...and the marker still advances (no retry-forever).
    expect(readPersistedMarker(dataDir)).toBe(NEW_MARKER);
    // The rotation was attempted and its failure logged as a swallowed WARN.
    expect(logs.some((l) => l.includes('failed to rotate out old store backup'))).toBe(true);
    // Fresh + the two kept OTHERS survive; the un-removable victim simply remains.
    expect(result.backedUpFiles).toHaveLength(1);
    expect(existsSync(join(dataDir, result.backedUpFiles[0]))).toBe(true);
    expect(existsSync(join(dataDir, 'store.nq.pre-wipe-keepA'))).toBe(true);
    expect(existsSync(join(dataDir, 'store.nq.pre-wipe-keepB'))).toBe(true);
    expect(existsSync(victim)).toBe(true); // eviction failed but swallowed
  });
});

describe('skipChainResetWipe (env switch, #679)', () => {
  afterEach(() => {
    // Don't leak a vi.stubEnv into sibling tests / describes.
    vi.unstubAllEnvs();
  });

  it('is true only for exactly "1" (injected env)', () => {
    expect(skipChainResetWipe({ DKG_SKIP_CHAIN_RESET_WIPE: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is false for "0", "true", and unset (injected env)', () => {
    expect(skipChainResetWipe({ DKG_SKIP_CHAIN_RESET_WIPE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(skipChainResetWipe({ DKG_SKIP_CHAIN_RESET_WIPE: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(skipChainResetWipe({} as NodeJS.ProcessEnv)).toBe(false);
  });

  // OXBb5 — production calls skipChainResetWipe() with NO arg, reading the REAL
  // process.env. The injected-object tests above don't exercise that default, so
  // cover it via vi.stubEnv (the env→skip entry point the deleted builder used to guard).
  it('reads real process.env on the no-arg path: "1" → true', () => {
    vi.stubEnv('DKG_SKIP_CHAIN_RESET_WIPE', '1');
    expect(skipChainResetWipe()).toBe(true);
  });

  it('reads real process.env on the no-arg path: "0" → false', () => {
    vi.stubEnv('DKG_SKIP_CHAIN_RESET_WIPE', '0');
    expect(skipChainResetWipe()).toBe(false);
  });

  it('reads real process.env on the no-arg path: unset → false', () => {
    // Explicitly clear the var so the assertion never depends on the runner's
    // ambient env (a dev/CI with DKG_SKIP_CHAIN_RESET_WIPE=1 would otherwise
    // make this a false failure). `vi.stubEnv(key, undefined)` deletes it;
    // the describe-level afterEach `vi.unstubAllEnvs()` restores it.
    vi.stubEnv('DKG_SKIP_CHAIN_RESET_WIPE', undefined);
    expect(skipChainResetWipe()).toBe(false);
  });
});
