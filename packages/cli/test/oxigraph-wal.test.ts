import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_AUTO_READY_TIMEOUT_MS,
  WAL_REPLAY_FLOOR_BYTES_PER_MS,
  formatWalBytes,
  measureRetainedWalBytes,
  resolveWalAwareReadyTimeoutMs,
} from '../src/daemon/oxigraph-wal.ts';

// GH#1400 — the daemon killed a healthy, mid-replay Oxigraph at a fixed 30s,
// left the WAL untouched, and so guaranteed the next boot would die the same
// way. The deadline is now sized from the replay work actually pending.
const dirs: string[] = [];
function tempLocation(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-wal-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('measureRetainedWalBytes (GH#1400)', () => {
  it('sums only RocksDB WAL segments, ignoring every neighbouring file', () => {
    const loc = tempLocation();
    // WAL segments — the only things replayed.
    writeFileSync(join(loc, '000004.log'), Buffer.alloc(43));
    writeFileSync(join(loc, '000008.log'), Buffer.alloc(1024));
    // Decoys, all NON-EMPTY on purpose: a filter widened to `includes('LOG')
    // || endsWith('.log')` must produce a different number, or this test
    // cannot catch that regression.
    writeFileSync(join(loc, 'LOG'), Buffer.alloc(500));
    writeFileSync(join(loc, 'LOG.old.1700000000'), Buffer.alloc(700));
    writeFileSync(join(loc, 'CURRENT'), Buffer.alloc(16));
    writeFileSync(join(loc, '000009.sst'), Buffer.alloc(2048));
    // A DIRECTORY named like a segment — pins the withFileTypes filter.
    mkdirSync(join(loc, '000005.log'));

    expect(measureRetainedWalBytes(loc)).toBe(1067);
  });

  it('returns 0 for a directory with no WAL segments', () => {
    const loc = tempLocation();
    writeFileSync(join(loc, 'LOG'), Buffer.alloc(500));
    expect(measureRetainedWalBytes(loc)).toBe(0);
  });

  it('returns 0 rather than throwing for a missing location', () => {
    // Runs on the boot path — a scan failure must degrade to today's
    // behaviour, never fail the boot.
    expect(measureRetainedWalBytes(join(tempLocation(), 'does-not-exist'))).toBe(0);
  });

  it('counts a large sparse segment by its apparent size', () => {
    const loc = tempLocation();
    const fd = openSync(join(loc, '000099.log'), 'w');
    // Sparse: costs no disk, but reports 40 MiB.
    writeFileSync(fd, Buffer.alloc(0));
    closeSync(fd);
    const { truncateSync } = require('node:fs') as typeof import('node:fs');
    truncateSync(join(loc, '000099.log'), 41_943_040);
    expect(measureRetainedWalBytes(loc)).toBe(41_943_040);
  });
});

describe('resolveWalAwareReadyTimeoutMs (GH#1400)', () => {
  it('returns the base unchanged when nothing is pending', () => {
    // The identity that preserves today's fast-fail for a broken binary or a
    // bound port — the extension only applies to real recovery work.
    expect(resolveWalAwareReadyTimeoutMs({ baseMs: 30_000, walBytes: 0 })).toBe(30_000);
  });

  it('extends by the replay floor', () => {
    // 40 MiB / 4000 B per ms = 10_486 ms of extension.
    expect(resolveWalAwareReadyTimeoutMs({ baseMs: 30_000, walBytes: 41_943_040 }))
      .toBe(30_000 + Math.ceil(41_943_040 / WAL_REPLAY_FLOOR_BYTES_PER_MS));
  });

  it('gives the reported worst case far more time than it actually needs', () => {
    // The issue's worst observed retention was 3.7 GiB. At the deliberately
    // pessimistic 4 MB/s floor that derives ~17 min, so the 15-min cap binds —
    // which is fine, and this test asserts WHY rather than asserting the
    // uncapped arithmetic.
    //
    // The guarantee that matters: the deadline must comfortably exceed REAL
    // replay time. At the slowest throughput ever measured (30,000 B/ms, the
    // issue's own 2.5 GB in 85s), 3.7 GiB replays in ~132s. The capped 900s
    // deadline is ~6.8x that, and 30x the 30s that caused the outage.
    const worstCaseBytes = Math.round(3.7 * 1024 ** 3);
    const derived = resolveWalAwareReadyTimeoutMs({ baseMs: 30_000, walBytes: worstCaseBytes });
    const realReplayMsAtSlowestMeasured = worstCaseBytes / 30_000;

    expect(derived).toBe(MAX_AUTO_READY_TIMEOUT_MS);
    expect(derived).toBeGreaterThan(realReplayMsAtSlowestMeasured * 5);
    expect(derived).toBeGreaterThan(30_000 * 10);
  });

  it('does not cap the sizes that actually occur in the field', () => {
    // Below ~3.5 GiB the derived deadline is the honest floor-based estimate,
    // not the cap — so the cap is a backstop, not the normal path.
    const gib = 1024 ** 3;
    for (const bytes of [gib, 2 * gib, 3 * gib]) {
      expect(resolveWalAwareReadyTimeoutMs({ baseMs: 30_000, walBytes: bytes }))
        .toBeLessThan(MAX_AUTO_READY_TIMEOUT_MS);
    }
  });

  it('caps the derived deadline', () => {
    // A failed boot is retried up to 5x by the supervisor, so the SINGLE
    // attempt must stay bounded or the amplified total becomes hours.
    expect(resolveWalAwareReadyTimeoutMs({ baseMs: 30_000, walBytes: 1024 ** 4 }))
      .toBe(MAX_AUTO_READY_TIMEOUT_MS);
  });

  it('treats a negative or non-finite measurement as nothing pending', () => {
    expect(resolveWalAwareReadyTimeoutMs({ baseMs: 5_000, walBytes: -1 })).toBe(5_000);
    expect(resolveWalAwareReadyTimeoutMs({ baseMs: 5_000, walBytes: NaN })).toBe(5_000);
  });

  it('is monotonic in pending bytes', () => {
    let prev = 0;
    for (const mb of [1, 10, 100, 1000]) {
      const v = resolveWalAwareReadyTimeoutMs({ baseMs: 1_000, walBytes: mb * 1024 ** 2 });
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('formatWalBytes', () => {
  it('renders operator-facing sizes', () => {
    expect(formatWalBytes(512)).toBe('512 B');
    expect(formatWalBytes(2048)).toBe('2.0 KiB');
    expect(formatWalBytes(5 * 1024 ** 2)).toBe('5.0 MiB');
    expect(formatWalBytes(Math.round(3.7 * 1024 ** 3))).toBe('3.70 GiB');
  });
});
