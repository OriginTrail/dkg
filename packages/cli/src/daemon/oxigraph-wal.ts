/**
 * WAL-aware startup readiness sizing for the managed Oxigraph server (GH#1400).
 *
 * WHY THIS EXISTS — and why it is NOT about shutdown.
 *
 * `oxigraph serve` 0.5.8 installs no SIGTERM handler. Measured against the
 * pinned binary: the process dies 0.09s after SIGTERM by the default
 * disposition, the retained write-ahead log is byte-identical across the
 * signal (62,598,813 bytes before and after), and RocksDB's `LOG` ends at its
 * `DB pointer` line with no shutdown records. So every managed-Oxigraph stop
 * is, from RocksDB's point of view, a crash — no grace period can buy a
 * memtable flush that the server never attempts.
 *
 * The consequence lands at STARTUP. RocksDB truncates the WAL at the next
 * read-write open, not at close, so every boot must replay the previous
 * session's retained log. `startOxigraphServer` gave that replay a fixed 30s.
 * Once a session's WAL grew past what replays in 30s, the daemon SIGKILLed a
 * healthy, mid-replay process before the database had opened, left the WAL
 * exactly as it was, and guaranteed the next boot would die the same way —
 * a self-reinforcing loop that took the node permanently down.
 *
 * Retained WAL grows LINEARLY with one session's write volume (a column family
 * does not flush until `write_buffer_size` = 128 MiB × `min_write_buffer_-
 * number_to_merge` = 2, and the live OPTIONS file has `max_total_wal_size=0`,
 * `WAL_ttl_seconds=0`, so nothing bounds it at runtime) and resets to zero at
 * every successful open. It is not unbounded; it is proportional to how much
 * the last session wrote.
 *
 * `oxigraph serve --help` exposes only `--location`, `--bind`, `--cors`,
 * `--union-default-graph` and `--timeout-s` — there is no `max_total_wal_size`
 * knob, so bounding growth at runtime is an upstream change, not one this repo
 * can make. Sizing the deadline to the work actually pending is the fix that
 * belongs here.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Assumed worst-case replay floor, in bytes per millisecond (4 MB/s).
 *
 * Calibrated against measurements, deliberately far below all of them:
 *   - 1,365,347,557 B replayed in 6.60s  = 206,823 B/ms (~197 MB/s)
 *   -    96,410,208 B replayed in 2.77s  =  34,806 B/ms (~35 MB/s)
 *   - the issue's slowest field report, 2.5 GB in 85s = 30,000 B/ms (~30 MB/s)
 *
 * 4,000 B/ms is 7.5x under the slowest observation, so the derived deadline
 * errs heavily toward waiting rather than killing a working process. It is a
 * FLOOR, not an estimate — being wrong in this direction costs boot latency,
 * being wrong in the other direction takes the node down permanently.
 */
export const WAL_REPLAY_FLOOR_BYTES_PER_MS = 4_000;

/**
 * Hard ceiling on the automatically-derived deadline (15 minutes).
 *
 * Two forces set this. Upward: the issue's worst observed retention was
 * 3.7 GiB, which at the 4 MB/s floor derives ~17.1 min — so a cap below that
 * would re-arm the exact ratchet for the node that reported the bug. Except
 * that estimate is 7x pessimistic; at the slowest MEASURED throughput
 * (30,000 B/ms) that same 3.7 GiB replays in ~2.1 min, so 15 min is still ~7x
 * real worst-case headroom.
 *
 * Downward, and decisive: a failed boot exits non-zero, which the supervisor
 * treats as a crash and retries up to `maxCrashRestarts = 5`
 * (packages/cli/src/cli-supervisor.ts). The deadline is therefore multiplied
 * by five in the worst case. At 15 min that is ~75 minutes of retrying before
 * the supervisor gives up; at an hour it would be ~5 hours of a node that
 * looks hung. Bound the amplified total, not just the single attempt.
 */
export const MAX_AUTO_READY_TIMEOUT_MS = 900_000;

/**
 * RocksDB WAL segment names are zero-padded numerics with a `.log` suffix
 * (`000004.log`, `000043.log`). Deliberately anchored so it does NOT match the
 * text log `LOG`, its rotations `LOG.old.<epoch>`, table files `*.sst`, or
 * `CURRENT` — none of which are replayed and all of which would inflate the
 * derived deadline.
 */
const WAL_SEGMENT_RE = /^\d+\.log$/;

/**
 * Total bytes of RocksDB write-ahead log retained in `location`.
 *
 * Best-effort by construction: this runs on the boot path, so a missing
 * directory, a permissions error, or RocksDB deleting a segment mid-scan must
 * contribute 0 rather than throw. Returning 0 degrades to today's behaviour
 * (the base timeout, unchanged) — never to a failed boot.
 */
export function measureRetainedWalBytes(location: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(location, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    // `withFileTypes` matters: a DIRECTORY named `000005.log` would otherwise
    // contribute its inode size to the estimate.
    if (!entry.isFile() || !WAL_SEGMENT_RE.test(entry.name)) continue;
    try {
      total += statSync(join(location, entry.name)).size;
    } catch {
      // Raced with RocksDB deleting the segment — it is not pending replay.
    }
  }
  return total;
}

/**
 * Derive the readiness deadline from the replay work actually pending.
 *
 * `walBytes === 0` returns `baseMs` UNCHANGED. That identity is what preserves
 * today's fast-fail for the common case (a genuinely broken binary, a bound
 * port, a bad `--location`) — the extension only applies when there is real
 * recovery work to wait for.
 */
export function resolveWalAwareReadyTimeoutMs(input: {
  baseMs: number;
  walBytes: number;
}): number {
  const { baseMs, walBytes } = input;
  if (!Number.isFinite(walBytes) || walBytes <= 0) return baseMs;
  const extension = Math.ceil(walBytes / WAL_REPLAY_FLOOR_BYTES_PER_MS);
  return Math.min(MAX_AUTO_READY_TIMEOUT_MS, baseMs + extension);
}

/** Human-readable byte size for operator-facing log lines. */
export function formatWalBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
