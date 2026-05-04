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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chainResetWipe } from '../src/daemon/chain-reset-wipe.js';

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
  it('is a no-op when network config has no marker (back-compat)', () => {
    seedAllFiles(dataDir);
    const result = chainResetWipe({ dataDir, currentMarker: undefined });

    expect(result.wiped).toBe(false);
    expect(result.prevMarker).toBeNull();
    expect(result.removedFiles).toEqual([]);
    // No state file is created when the protocol isn't active.
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(false);
    // All files preserved.
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
  });
});

describe('chainResetWipe — first boot with marker present', () => {
  it('wipes and saves marker (the chain-reset rollout case)', () => {
    seedAllFiles(dataDir);
    const logs: string[] = [];

    const result = chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      log: (msg) => logs.push(msg),
    });

    expect(result.wiped).toBe(true);
    expect(result.prevMarker).toBeNull();
    expect(result.removedFiles).toEqual(
      expect.arrayContaining([
        'store.nq',
        'store.nq.tmp',
        'random-sampling.wal',
        'publish-journal.0',
        'publish-journal.1',
        'publish-journal.staging',
      ]),
    );

    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
    expect(existsSync(join(dataDir, 'wallets.json'))).toBe(true);
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(true);
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);

    expect(logs.some((l) => l.includes('first detected'))).toBe(true);
  });

  it('still records the marker on a fresh install with no chain-state files yet', () => {
    const result = chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    expect(result.removedFiles).toEqual([]);
    expect(existsSync(join(dataDir, STATE_FILE))).toBe(true);
  });
});

describe('chainResetWipe — same marker (steady state)', () => {
  it('does nothing when persisted marker equals current', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: NEW_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);

    const result = chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(false);
    expect(result.prevMarker).toBe(NEW_MARKER);
    expect(result.removedFiles).toEqual([]);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
  });
});

describe('chainResetWipe — marker changed (chain reset)', () => {
  it('wipes chain-state files and preserves operator state when marker differs', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() - 86_400_000 }),
    );
    seedAllFiles(dataDir);

    const logs: string[] = [];
    const result = chainResetWipe({
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

  it('handles missing chain-state files gracefully (subset wipe)', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    // Only seed store.nq; the others don't exist on this node yet.
    writeFileSync(join(dataDir, 'store.nq'), '...');

    const result = chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    expect(result.removedFiles).toEqual(['store.nq']);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(false);
  });

  it('is idempotent: a second call with the same input is a no-op', () => {
    writeFileSync(
      join(dataDir, STATE_FILE),
      JSON.stringify({ chainResetMarker: OLD_MARKER, savedAt: Date.now() }),
    );
    seedAllFiles(dataDir);

    const first = chainResetWipe({ dataDir, currentMarker: NEW_MARKER });
    expect(first.wiped).toBe(true);

    // Re-seed the chain-state files to simulate "boot, work, boot again".
    writeFileSync(join(dataDir, 'store.nq'), '<s> <p> <o> .');

    const second = chainResetWipe({ dataDir, currentMarker: NEW_MARKER });
    expect(second.wiped).toBe(false);
    expect(second.prevMarker).toBe(NEW_MARKER);
    expect(existsSync(join(dataDir, 'store.nq'))).toBe(true);
  });
});

describe('chainResetWipe — corrupt state file', () => {
  it('treats unparseable state as missing (first-boot semantics)', () => {
    writeFileSync(join(dataDir, STATE_FILE), '{ this is not valid JSON');
    seedAllFiles(dataDir);

    const result = chainResetWipe({ dataDir, currentMarker: NEW_MARKER });

    expect(result.wiped).toBe(true);
    expect(result.prevMarker).toBeNull();
    // State file gets rewritten with the current marker.
    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(NEW_MARKER);
  });
});

describe('chainResetWipe — custom random-sampling WAL path (PR #357 feedback)', () => {
  // Codex review found that operators who set `randomSampling.walPath` in
  // their config keep a stale WAL across chain resets — the wipe was
  // hardcoding `dataDir/random-sampling.wal`. These tests pin the fix.

  it('wipes the operator-supplied WAL path when set, not the default', () => {
    const customWal = join(dataDir, 'custom', 'rs.wal');
    mkdirSync(join(dataDir, 'custom'), { recursive: true });
    writeFileSync(customWal, 'WAL\n');
    // Default-path WAL also present — must NOT be touched (caller has
    // explicitly redirected, default is dead from prover's POV).
    writeFileSync(join(dataDir, 'random-sampling.wal'), 'STALE\n');
    writeFileSync(join(dataDir, 'store.nq'), '...');

    const result = chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      randomSamplingWalPath: customWal,
    });

    expect(result.wiped).toBe(true);
    expect(existsSync(customWal)).toBe(false);
    // Default path untouched: prover never reads it under this config.
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(true);
  });

  it('falls back to default WAL path when randomSamplingWalPath is empty', () => {
    writeFileSync(join(dataDir, 'random-sampling.wal'), 'WAL\n');

    const result = chainResetWipe({
      dataDir,
      currentMarker: NEW_MARKER,
      randomSamplingWalPath: '',
    });

    expect(result.wiped).toBe(true);
    expect(existsSync(join(dataDir, 'random-sampling.wal'))).toBe(false);
  });

  it('handles WAL path outside dataDir (absolute, e.g. /var/lib/dkg/wal)', () => {
    const externalWalDir = mkdtempSync(join(tmpdir(), 'dkg-external-wal-'));
    const externalWal = join(externalWalDir, 'rs.wal');
    writeFileSync(externalWal, 'EXTERNAL_WAL\n');

    try {
      const result = chainResetWipe({
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

  it('logs and continues when saveState throws (e.g. read-only FS)', () => {
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

      expect(() => {
        chainResetWipe({
          dataDir,
          currentMarker: NEW_MARKER,
          log: (msg) => logsCaptured.push(msg),
        });
      }).not.toThrow();

      // Loud log so operators can find this in journalctl.
      expect(logsCaptured.some((l) => l.includes('failed to persist chain reset marker'))).toBe(true);
    } finally {
      chmodSync(dataDir, originalMode);
    }
  });

  it('does not save the marker when an individual file wipe throws', () => {
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

      expect(() => {
        const result = chainResetWipe({
          dataDir,
          currentMarker: NEW_MARKER,
          log: (msg) => logsCaptured.push(msg),
        });
        expect(result.failedFiles.some((f) => f.file === 'store.nq')).toBe(true);
      }).not.toThrow();
    } finally {
      chmodSync(dataDir, originalMode);
      rmSync(join(dataDir, '.probe'), { force: true });
    }

    const persisted = JSON.parse(readFileSync(join(dataDir, STATE_FILE), 'utf8'));
    expect(persisted.chainResetMarker).toBe(OLD_MARKER);
    expect(logsCaptured.some((l) => l.includes('marker was not persisted'))).toBe(true);
  });
});
