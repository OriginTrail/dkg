import { describe, it, expect } from 'vitest';
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

// ── raceShutdownWithTimeout on REAL timers (no fake-timer virtualization) ──
// Both deadlines are parameters, so the suite runs them at real millisecond
// scale: HARD=120ms wall-clock cutoff, FORCED=60ms forced-cleanup budget.
// The log/onForcedTimeout vitest spies are replaced with plain recording
// functions. Every timeout that fires here is a genuine event-loop timer.
const HARD = 120;
const FORCED = 60;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function recordLog() {
  const calls: string[] = [];
  const fn = (msg: string): void => {
    calls.push(msg);
  };
  return Object.assign(fn, { calls });
}

describe('raceShutdownWithTimeout (real timers)', () => {
  it('resolves with forced=false the moment cleanup settles (happy path)', async () => {
    const log = recordLog();
    const result = await raceShutdownWithTimeout(Promise.resolve(), HARD, log);
    expect(result).toEqual({ forced: false });
    // No `[shutdown-timeout]` line on the happy path — operators grep for it
    // as the unambiguous deadlock signal.
    expect(log.calls).toEqual([]);
  });

  it('resolves with forced=true and logs once after the REAL deadline when cleanup never settles', async () => {
    const log = recordLog();
    let forcedCalls = 0;
    // A promise that never settles models the observed beacon-01 deadlock.
    const cleanup = new Promise<void>(() => {});
    const racePromise = raceShutdownWithTimeout(cleanup, HARD, log, () => {
      forcedCalls += 1;
    });

    // Mid-window probe: still racing, no log yet.
    await sleep(HARD / 2);
    expect(log.calls).toEqual([]);

    const result = await racePromise;
    expect(result).toEqual({ forced: true });
    expect(forcedCalls).toBe(1);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toContain('[shutdown-timeout]');
    expect(log.calls[0]).toContain(`${HARD}ms`);
  });

  it('logs forced-cleanup errors but still resolves forced=true', async () => {
    const log = recordLog();
    const result = await raceShutdownWithTimeout(
      new Promise<void>(() => {}),
      HARD,
      log,
      async () => {
        throw new Error('state-file cleanup failed');
      },
    );
    expect(result).toEqual({ forced: true });
    expect(log.calls.some((m) => m.includes('forced cleanup error'))).toBe(true);
  });

  it('bounds forced cleanup with its own REAL timeout when it hangs (wall-clock cutoff stays hard)', async () => {
    // Regression: a stalled forced cleanup must not recreate the zombie shape
    // — the race must still resolve within the forced budget so process.exit
    // is reached.
    const log = recordLog();
    let forcedCalls = 0;
    const result = await raceShutdownWithTimeout(
      new Promise<void>(() => {}),
      HARD,
      log,
      () => {
        forcedCalls += 1;
        return new Promise<void>(() => {}); // genuinely never settles
      },
      FORCED,
    );
    expect(result).toEqual({ forced: true });
    expect(forcedCalls).toBe(1);
    expect(log.calls.some((m) => m.includes(`forced cleanup exceeded ${FORCED}ms; abandoning`))).toBe(true);
  });

  it('clears the forced-cleanup timer when forced cleanup completes inside its budget', async () => {
    const log = recordLog();
    let forcedCalls = 0;
    const result = await raceShutdownWithTimeout(
      new Promise<void>(() => {}),
      HARD,
      log,
      async () => {
        forcedCalls += 1; // settles on the next microtask — inside any budget
      },
      FORCED,
    );
    expect(result).toEqual({ forced: true });
    expect(forcedCalls).toBe(1);
    // Wait past the forced budget on REAL time: a leaked secondary timer
    // would emit the "abandoning" line now.
    await sleep(FORCED * 3);
    expect(log.calls.some((m) => m.includes('abandoning'))).toBe(false);
  });

  it('clears the timeout when cleanup settles first (no leaked timer)', async () => {
    const log = recordLog();
    let resolveCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const racePromise = raceShutdownWithTimeout(cleanup, HARD, log);

    // Cleanup completes well before the deadline.
    await sleep(HARD / 4);
    resolveCleanup();
    const result = await racePromise;
    expect(result).toEqual({ forced: false });

    // Wait past the original deadline on REAL time: the timer must have been
    // cleared, so no log entry materialises after the race resolved.
    await sleep(HARD * 2);
    expect(log.calls).toEqual([]);
  });

  it('clears the timeout even when cleanup rejects (no leaked timer)', async () => {
    const log = recordLog();
    // Caller is responsible for catching cleanup errors before passing the
    // promise in (see lifecycle.ts), but the helper must still clean its
    // own timer even if a misuse lets the rejection through.
    await expect(
      raceShutdownWithTimeout(Promise.reject(new Error('cleanup blew up')), HARD, log),
    ).rejects.toThrow('cleanup blew up');

    // Past the deadline on REAL time: timer was cleared, so still no log.
    await sleep(HARD * 2);
    expect(log.calls).toEqual([]);
  });
});
