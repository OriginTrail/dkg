import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS,
  SHUTDOWN_FORCED_OFFSET,
  SHUTDOWN_HARD_TIMEOUT_MS,
  decodeForcedExitCode,
  encodeForcedShutdownExitCode,
  isForcedShutdownExitCode,
  raceShutdownWithTimeout,
} from '../src/daemon/shutdown.js';
import { DAEMON_EXIT_CODE_RESTART } from '../src/daemon/manifest.js';

describe('shutdown constants', () => {
  it('declares SHUTDOWN_FORCED_OFFSET = 100 so 0+offset and 75+offset both fit in an 8-bit exit code', () => {
    // Both currently-emitted exit codes (0 from SIGINT/SIGTERM, 75 from auto-update)
    // must remain valid 8-bit values after the offset is applied. Documented for
    // the next contributor who might be tempted to bump the offset above 180.
    expect(SHUTDOWN_FORCED_OFFSET).toBe(100);
    expect(0 + SHUTDOWN_FORCED_OFFSET).toBeLessThan(256);
    expect(DAEMON_EXIT_CODE_RESTART + SHUTDOWN_FORCED_OFFSET).toBeLessThan(256);
  });

  it('uses a 15s default hard-timeout — generous enough to let normal shutdowns finish, tight enough to recover from a stuck Core in one update cycle', () => {
    expect(SHUTDOWN_HARD_TIMEOUT_MS).toBe(15_000);
  });

  it('uses a 1s default forced-cleanup timeout — bounded separately from the wall-clock cutoff so a stalled FS op cannot recreate the zombie shape', () => {
    expect(SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS).toBe(1_000);
  });
});

describe('isForcedShutdownExitCode', () => {
  // Computed from the source-of-truth constants so a future move of either
  // SHUTDOWN_FORCED_OFFSET or DAEMON_EXIT_CODE_RESTART updates the test cases
  // automatically — protecting against the silent drift the V1 review flagged.
  const FORCED_RESTART = SHUTDOWN_FORCED_OFFSET + DAEMON_EXIT_CODE_RESTART;
  it.each([
    { input: null, expected: false, label: 'null (no exit reported)' },
    { input: 0, expected: false, label: 'clean exit' },
    { input: DAEMON_EXIT_CODE_RESTART, expected: false, label: 'DAEMON_EXIT_CODE_RESTART (clean restart)' },
    { input: 1, expected: false, label: 'arbitrary crash' },
    { input: SHUTDOWN_FORCED_OFFSET - 1, expected: false, label: 'just below the offset range' },
    { input: SHUTDOWN_FORCED_OFFSET, expected: true, label: 'forced clean exit (0 + offset)' },
    { input: FORCED_RESTART, expected: true, label: 'forced restart (DAEMON_EXIT_CODE_RESTART + offset)' },
    { input: SHUTDOWN_FORCED_OFFSET + 1, expected: false, label: 'unrelated process exit in the offset range' },
    { input: SHUTDOWN_FORCED_OFFSET + 99, expected: false, label: 'top of the offset range' },
    { input: SHUTDOWN_FORCED_OFFSET + 100, expected: false, label: 'just above the offset range' },
    { input: 255, expected: false, label: 'arbitrary high exit code' },
  ])('returns $expected for $label ($input)', ({ input, expected }) => {
    expect(isForcedShutdownExitCode(input)).toBe(expected);
  });
});

describe('decodeForcedExitCode', () => {
  const FORCED_RESTART = SHUTDOWN_FORCED_OFFSET + DAEMON_EXIT_CODE_RESTART;
  it.each([
    { input: null, forced: false, original: null, label: 'null' },
    { input: 0, forced: false, original: 0, label: 'clean exit' },
    { input: DAEMON_EXIT_CODE_RESTART, forced: false, original: DAEMON_EXIT_CODE_RESTART, label: 'clean restart' },
    { input: 1, forced: false, original: 1, label: 'arbitrary crash unchanged' },
    { input: SHUTDOWN_FORCED_OFFSET, forced: true, original: 0, label: 'forced clean exit -> original 0' },
    { input: FORCED_RESTART, forced: true, original: DAEMON_EXIT_CODE_RESTART, label: 'forced restart -> original DAEMON_EXIT_CODE_RESTART' },
    { input: SHUTDOWN_FORCED_OFFSET + 1, forced: false, original: SHUTDOWN_FORCED_OFFSET + 1, label: 'unrelated offset-range code unchanged' },
    { input: SHUTDOWN_FORCED_OFFSET + 99, forced: false, original: SHUTDOWN_FORCED_OFFSET + 99, label: 'top of offset range unchanged' },
    { input: SHUTDOWN_FORCED_OFFSET + 100, forced: false, original: SHUTDOWN_FORCED_OFFSET + 100, label: 'above offset range, treated as crash' },
  ])('decodes $input as forced=$forced, originalExitCode=$original ($label)', ({ input, forced, original }) => {
    expect(decodeForcedExitCode(input)).toEqual({
      forced,
      originalExitCode: original,
    });
  });
});

describe('encodeForcedShutdownExitCode', () => {
  it('encodes only the shutdown sentinels the supervisor can decode exactly', () => {
    expect(encodeForcedShutdownExitCode(0)).toBe(SHUTDOWN_FORCED_OFFSET);
    expect(encodeForcedShutdownExitCode(DAEMON_EXIT_CODE_RESTART)).toBe(
      SHUTDOWN_FORCED_OFFSET + DAEMON_EXIT_CODE_RESTART,
    );
    expect(() => encodeForcedShutdownExitCode(1)).toThrow(/Unsupported forced shutdown exit code/);
  });
});

describe('raceShutdownWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with forced=false the moment cleanup settles (happy path)', async () => {
    const log = vi.fn<(msg: string) => void>();
    const cleanup = Promise.resolve();

    const result = await raceShutdownWithTimeout(cleanup, 15_000, log);

    expect(result).toEqual({ forced: false });
    // No `[shutdown-timeout]` line on the happy path — operators grep for it
    // as the unambiguous deadlock signal; emitting it on clean shutdowns would
    // poison that signal.
    expect(log).not.toHaveBeenCalled();
  });

  it('resolves with forced=true and logs once after the deadline when cleanup never settles', async () => {
    const log = vi.fn<(msg: string) => void>();
    const onForcedTimeout = vi.fn<() => void>();
    // A promise that never settles models the observed beacon-01 deadlock —
    // `agent.stop()` awaiting an in-flight libp2p read that holds forever.
    const cleanup = new Promise<void>(() => {});

    const racePromise = raceShutdownWithTimeout(cleanup, 15_000, log, onForcedTimeout);

    // Just under the deadline: still racing, no log yet.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(log).not.toHaveBeenCalled();

    // Tick the last millisecond: timeout fires, log emitted exactly once,
    // race resolves with forced=true.
    await vi.advanceTimersByTimeAsync(1);
    const result = await racePromise;

    expect(result).toEqual({ forced: true });
    expect(onForcedTimeout).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[shutdown-timeout]'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('15000ms'),
    );
  });

  it('logs forced-cleanup errors but still resolves forced=true', async () => {
    const log = vi.fn<(msg: string) => void>();
    const cleanup = new Promise<void>(() => {});
    const racePromise = raceShutdownWithTimeout(
      cleanup,
      15_000,
      log,
      async () => {
        throw new Error('state-file cleanup failed');
      },
    );

    await vi.advanceTimersByTimeAsync(15_000);
    const result = await racePromise;

    expect(result).toEqual({ forced: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forced cleanup error'));
  });

  it('bounds forced cleanup with its own timeout when it hangs (wall-clock cutoff stays hard)', async () => {
    // Regression test for the bug where forced cleanup awaits inside the
    // timeout path could resurrect the same zombie shape we're preventing:
    // if `cleanupStateFiles()` stalls on filesystem I/O, the race must STILL
    // resolve (so `process.exit(...)` is reached) within the forced-cleanup
    // budget — not block forever waiting on the FS.
    const log = vi.fn<(msg: string) => void>();
    const cleanup = new Promise<void>(() => {});
    const onForcedTimeout = vi.fn(() => new Promise<void>(() => {}));

    const racePromise = raceShutdownWithTimeout(
      cleanup,
      15_000,
      log,
      onForcedTimeout,
      // Tight 50ms forced budget; the default 1s would also work but slow the
      // suite. The scenario is the same: forced cleanup never settles.
      50,
    );

    // Tick to the wall-clock deadline: timer fires, forced cleanup starts,
    // but the race is NOT yet resolved (we're inside the forced-cleanup window).
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onForcedTimeout).toHaveBeenCalledTimes(1);

    // Tick the forced-cleanup budget: forced cleanup gets abandoned, race
    // resolves, supervisor can decode the offset and process.exit() runs.
    await vi.advanceTimersByTimeAsync(50);
    const result = await racePromise;

    expect(result).toEqual({ forced: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forced cleanup exceeded 50ms; abandoning'));
  });

  it('clears the forced-cleanup timer when forced cleanup completes inside its budget', async () => {
    // Mirror image of the previous test: forced cleanup settles quickly, so
    // the secondary timer must be cleared (no orphan log line, no leaked
    // handle keeping the event loop alive past process.exit).
    const log = vi.fn<(msg: string) => void>();
    const cleanup = new Promise<void>(() => {});
    const onForcedTimeout = vi.fn(async () => {
      // Resolves on next microtask — well inside any forced-cleanup budget.
    });

    const racePromise = raceShutdownWithTimeout(
      cleanup,
      15_000,
      log,
      onForcedTimeout,
      1_000,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    const result = await racePromise;

    expect(result).toEqual({ forced: true });
    expect(onForcedTimeout).toHaveBeenCalledTimes(1);
    // Race resolved; advancing past the forced-cleanup deadline must NOT
    // produce an "abandoning" log entry (that would mean the secondary timer
    // leaked).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('abandoning'));
  });

  it('clears the timeout when cleanup settles first (no leaked timer)', async () => {
    const log = vi.fn<(msg: string) => void>();
    let resolveCleanup: () => void;
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve; });

    const racePromise = raceShutdownWithTimeout(cleanup, 15_000, log);

    // Cleanup completes well before the deadline.
    await vi.advanceTimersByTimeAsync(5_000);
    resolveCleanup!();
    const result = await racePromise;

    expect(result).toEqual({ forced: false });

    // Advance past the original deadline: the timer must have been cleared,
    // so no log entry materialises after the race resolved. (If the timer
    // leaked, the log would fire here and confuse operators investigating
    // historic shutdowns.)
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).not.toHaveBeenCalled();
  });

  it('clears the timeout even when cleanup rejects (no leaked timer)', async () => {
    const log = vi.fn<(msg: string) => void>();
    // Caller is responsible for catching cleanup errors before passing the
    // promise in (see lifecycle.ts), but the helper must still clean its
    // own timer even if a misuse lets the rejection through.
    const cleanup = Promise.reject(new Error('cleanup blew up'));

    await expect(
      raceShutdownWithTimeout(cleanup, 15_000, log),
    ).rejects.toThrow('cleanup blew up');

    // Past the deadline: timer was cleared in the finally block, so still no log.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).not.toHaveBeenCalled();
  });
});
