// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3081 — a caller waits a short time for the legacy SWM boundary retirement it asked for. The
 * retirement goes on without it, and one that did not get its turn or failed is repeated until it
 * ran, with a bound on how often and on how many. Every attempt stays the owner's until it ended:
 * a close ends the waiting ones through their signal and waits for the rest.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS,
  MAX_LEGACY_SWM_RETIREMENT_REPEATS,
  MAX_OWED_LEGACY_SWM_RETIREMENTS,
  OwedLegacySwmRetirementsV1,
  describeOwedLegacySwmRetirementEventV1,
  type LegacySwmRetirementAttemptV1,
  type OwedLegacySwmRetirementEventV1,
  type OwedLegacySwmRetirementsOptionsV1,
} from '../src/internal/owed-legacy-swm-retirements.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Attempts the row ends by hand, in the order they were started, each with the signal it was given. */
function attempts() {
  const started: Array<{
    signal: AbortSignal;
    end: (outcome: LegacySwmRetirementAttemptV1) => void;
    fail: (error: unknown) => void;
  }> = [];
  const attempt = (signal: AbortSignal) => new Promise<LegacySwmRetirementAttemptV1>((end, fail) => {
    started.push({ signal, end, fail });
  });
  return { attempt, started };
}

function owner(options: OwedLegacySwmRetirementsOptionsV1 = {}) {
  const events: OwedLegacySwmRetirementEventV1[] = [];
  const owed = new OwedLegacySwmRetirementsV1({ onEvent: (event) => events.push(event), ...options });
  return { owed, events };
}

/** Let what a settled promise set off run, without moving the clock. */
const settled = () => vi.advanceTimersByTimeAsync(0);

describe('legacy SWM boundary retirements a caller stopped waiting for', () => {
  it('starts the attempt inside the call and returns as soon as it ended', async () => {
    for (const outcome of ['retired', 'kept'] as const) {
      const { owed, events } = owner();
      const { attempt, started } = attempts();

      const asked = owed.retire('asset', attempt);
      // Before anything is awaited: a fence the attempt raises is up when this call returns.
      expect(started).toHaveLength(1);
      started[0]!.end(outcome);
      await asked;

      expect(owed.owed).toBe(0);
      expect(events).toEqual([]);
      // Neither the caller's wait nor a pause is left behind.
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('lets the caller go after its wait and leaves the attempt to end on its own', async () => {
    const { owed, events } = owner();
    const { attempt, started } = attempts();
    let returned = false;
    const asked = owed.retire('asset', attempt).then(() => { returned = true; });

    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await asked;
    expect(returned).toBe(true);
    // The attempt is still running: nothing is owed a repeat yet.
    expect(owed.owed).toBe(0);

    started[0]!.end('retired');
    await settled();
    expect(started).toHaveLength(1);
    expect(owed.owed).toBe(0);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repeats an attempt that did not get its turn, whether the caller had left or not', async () => {
    const { owed, events } = owner();

    // Inside the wait: the caller returns without a failure, as it always did.
    const inside = attempts();
    const asked = owed.retire('inside', inside.attempt);
    inside.started[0]!.end('not-run');
    await expect(asked).resolves.toBeUndefined();

    // After the wait.
    const after = attempts();
    const left = owed.retire('after', after.attempt);
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);
    await left;
    after.started[0]!.end('not-run');
    await settled();

    expect(events).toEqual([
      { kind: 'repeating', key: 'inside', reason: 'not-run', repeat: 1, inMs: 30_000 },
      { kind: 'repeating', key: 'after', reason: 'not-run', repeat: 1, inMs: 30_000 },
    ]);
    expect(owed.owed).toBe(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(inside.started).toHaveLength(2);
    expect(after.started).toHaveLength(2);
    inside.started[1]!.end('retired');
    after.started[1]!.end('kept');
    await settled();
    expect(events.slice(2)).toEqual([
      { kind: 'repeated', key: 'inside', outcome: 'retired', repeats: 1 },
      { kind: 'repeated', key: 'after', outcome: 'kept', repeats: 1 },
    ]);
    expect(owed.owed).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws a failure that ends the attempt inside the wait, and repeats the retirement all the same', async () => {
    const { owed, events } = owner();
    const { attempt, started } = attempts();
    const failure = new Error('the store refused the read');

    const asked = owed.retire('asset', attempt);
    started[0]!.fail(failure);
    await expect(asked).rejects.toBe(failure);

    expect(events).toEqual([
      { kind: 'repeating', key: 'asset', reason: 'failed', repeat: 1, inMs: 30_000, error: failure },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    started[1]!.end('retired');
    await settled();
    expect(events[1]).toEqual({ kind: 'repeated', key: 'asset', outcome: 'retired', repeats: 1 });
    expect(owed.owed).toBe(0);
  });

  it('keeps a failure that comes after the wait to itself and repeats the retirement', async () => {
    const { owed, events } = owner();
    const failing = vi.fn<() => Promise<LegacySwmRetirementAttemptV1>>();
    const late = attempts();
    failing.mockImplementationOnce(late.attempt);
    // An attempt whose call itself throws counts as one that failed.
    failing.mockImplementationOnce(() => { throw new Error('thrown by the call'); });
    failing.mockResolvedValueOnce('retired');

    const asked = owed.retire('asset', failing);
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);
    await expect(asked).resolves.toBeUndefined();
    late.started[0]!.fail(new Error('failed late'));
    await settled();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.map((event) => [event.kind, 'reason' in event ? event.reason : event.outcome])).toEqual([
      ['repeating', 'failed'],
      ['repeating', 'failed'],
      ['repeated', 'retired'],
    ]);
    expect(events.slice(0, 2).map((event) => (event as { error: Error }).error.message)).toEqual([
      'failed late',
      'thrown by the call',
    ]);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(owed.owed).toBe(0);
  });

  it('doubles the pause from thirty seconds up to ten minutes, and gives a retirement up after its repeats', async () => {
    const { owed, events } = owner();
    const attempt = vi.fn(async (): Promise<LegacySwmRetirementAttemptV1> => 'not-run');

    await owed.retire('asset', attempt);
    for (let repeat = 1; repeat <= MAX_LEGACY_SWM_RETIREMENT_REPEATS; repeat += 1) {
      const pause = events.at(-1)!;
      expect(pause).toMatchObject({ kind: 'repeating', repeat });
      await vi.advanceTimersByTimeAsync((pause as { inMs: number }).inMs - 1);
      expect(attempt).toHaveBeenCalledTimes(repeat);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempt).toHaveBeenCalledTimes(repeat + 1);
    }

    expect(events.filter((event) => event.kind === 'repeating').map((event) => event.inMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000, 600_000, 600_000,
    ]);
    expect(events.at(-1)).toEqual({ kind: 'abandoned', key: 'asset', reason: 'repeats-exhausted' });
    expect(owed.owed).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serves every request for one retirement with one repeat', async () => {
    const { owed, events } = owner();
    const attempt = vi.fn<() => Promise<LegacySwmRetirementAttemptV1>>();
    attempt.mockResolvedValueOnce('not-run');
    attempt.mockResolvedValueOnce('not-run');
    attempt.mockRejectedValueOnce(new Error('failed while a repeat is owed'));
    attempt.mockResolvedValueOnce('retired');
    attempt.mockResolvedValueOnce('kept');

    await owed.retire('asset', attempt);
    await owed.retire('asset', attempt);
    await expect(owed.retire('asset', attempt)).rejects.toThrow('failed while a repeat is owed');
    // A request that retires the marker leaves the repeat in place; it finds nothing to do.
    await owed.retire('asset', attempt);

    expect(events).toEqual([{ kind: 'repeating', key: 'asset', reason: 'not-run', repeat: 1, inMs: 30_000 }]);
    expect(owed.owed).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(events[1]).toEqual({ kind: 'repeated', key: 'asset', outcome: 'kept', repeats: 1 });
    expect(attempt).toHaveBeenCalledTimes(5);
    expect(owed.owed).toBe(0);
  });

  it('owes no more retirements than its bound', async () => {
    const { owed, events } = owner({ maxOwed: 2 });
    const notRun = async (): Promise<LegacySwmRetirementAttemptV1> => 'not-run';

    await owed.retire('first', notRun);
    await owed.retire('second', notRun);
    await owed.retire('third', notRun);

    expect(owed.owed).toBe(2);
    expect(events.at(-1)).toEqual({ kind: 'abandoned', key: 'third', reason: 'too-many-owed' });
    // One that is owed already keeps its place when its repeat does not run either.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(owed.owed).toBe(2);
    expect(events.filter((event) => event.kind === 'repeating' && event.repeat === 2)).toHaveLength(2);
    expect(MAX_OWED_LEGACY_SWM_RETIREMENTS).toBe(4_096);
  });

  it('gives each attempt the signal of the node\'s run, and does not finish its close before every attempt ended', async () => {
    const { owed, events } = owner();
    const first = attempts();
    const repeated = attempts();

    // One attempt outlives its caller's wait; another is a repeat that is running.
    const left = owed.retire('first-attempt', first.attempt);
    await vi.advanceTimersByTimeAsync(LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS);
    await left;
    const asked = owed.retire('repeat', repeated.attempt);
    repeated.started[0]!.end('not-run');
    await asked;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repeated.started).toHaveLength(2);
    expect(owed.running).toBe(2);
    expect([first.started[0]!.signal.aborted, repeated.started[1]!.signal.aborted]).toEqual([false, false]);
    const eventsBefore = events.length;

    let closed = false;
    const closing = owed.closeAndDrain().then(() => { closed = true; });
    // Both attempts are told at once; what is owed is dropped with its pause.
    expect([first.started[0]!.signal.aborted, repeated.started[1]!.signal.aborted]).toEqual([true, true]);
    expect(owed.owed).toBe(0);
    await settled();
    expect(closed).toBe(false);

    first.started[0]!.end('retired');
    await settled();
    expect(closed).toBe(false);
    repeated.started[1]!.end('not-run');
    await closing;
    expect(closed).toBe(true);
    // Nothing follows the attempts of a run that ended, and nothing is said about them.
    expect(owed.running).toBe(0);
    expect(owed.owed).toBe(0);
    expect(events).toHaveLength(eventsBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts nothing while it is closed, and owes again after it was reopened', async () => {
    const { owed, events } = owner();
    const notRun = vi.fn(async (): Promise<LegacySwmRetirementAttemptV1> => 'not-run');

    await owed.retire('asset', notRun);
    expect(owed.owed).toBe(1);
    await owed.closeAndDrain();
    expect(owed.owed).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await owed.retire('asset', notRun);
    expect(notRun).toHaveBeenCalledTimes(1);
    expect(owed.owed).toBe(0);
    // Reopening an open owner changes nothing.
    owed.reopen();
    owed.reopen();

    await owed.retire('asset', notRun);
    expect(notRun).toHaveBeenCalledTimes(2);
    expect(owed.owed).toBe(1);
    expect(events.filter((event) => event.kind === 'repeating')).toHaveLength(2);
    await owed.closeAndDrain();
  });

  it.each([
    ['did not get its turn', (attempt: { end: (outcome: LegacySwmRetirementAttemptV1) => void }) => attempt.end('not-run')],
    ['retired the marker', (attempt: { end: (outcome: LegacySwmRetirementAttemptV1) => void }) => attempt.end('retired')],
    ['failed', (attempt: { fail: (error: unknown) => void }) => attempt.fail(new Error('failed after the stop'))],
  ] as const)('leaves what the next run owes alone when a repeat of the run before %s', async (_what, endIt) => {
    const { owed, events } = owner();
    const earlier = attempts();
    const asked = owed.retire('asset', earlier.attempt);
    earlier.started[0]!.end('not-run');
    await asked;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(earlier.started).toHaveLength(2);

    // The node stops while that repeat runs, and starts again before the repeat has ended.
    const closing = owed.closeAndDrain();
    owed.reopen();
    const next = vi.fn<(signal: AbortSignal) => Promise<LegacySwmRetirementAttemptV1>>();
    next.mockResolvedValueOnce('not-run');
    next.mockResolvedValueOnce('retired');
    await owed.retire('asset', next);
    expect(owed.owed).toBe(1);
    const eventsBefore = events.length;

    endIt(earlier.started[1]!);
    await closing;
    // The same retirement is still owed its repeat in this run, and gets it.
    expect(owed.owed).toBe(1);
    expect(events).toHaveLength(eventsBefore);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(next).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ kind: 'repeated', key: 'asset', outcome: 'retired', repeats: 1 });
    expect(owed.owed).toBe(0);
  });

  it('runs a repeat outside the context of the caller that asked', async () => {
    const context = new AsyncLocalStorage<string>();
    const { owed } = owner();
    const seen: Array<string | undefined> = [];
    const attempt = vi.fn(async (): Promise<LegacySwmRetirementAttemptV1> => {
      seen.push(context.getStore());
      return seen.length === 1 ? 'not-run' : 'retired';
    });

    await context.run('caller', () => owed.retire('asset', attempt));
    // Whatever moves the clock has a context of its own; the repeat does not take that one either.
    await context.run('clock', () => vi.advanceTimersByTimeAsync(30_000));

    // The first attempt is the caller's, as it was. The repeat belongs to no caller.
    expect(seen).toEqual(['caller', undefined]);
  });

  it('is not changed by an observer that throws', async () => {
    const owed = new OwedLegacySwmRetirementsV1({
      onEvent: () => { throw new Error('observer failed'); },
    });
    const attempt = vi.fn<() => Promise<LegacySwmRetirementAttemptV1>>();
    attempt.mockResolvedValueOnce('not-run');
    attempt.mockResolvedValueOnce('retired');

    await owed.retire('asset', attempt);
    expect(owed.owed).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(owed.owed).toBe(0);
    // Without an observer it works the same.
    const silent = new OwedLegacySwmRetirementsV1();
    await silent.retire('asset', async () => 'not-run');
    expect(silent.owed).toBe(1);
    await silent.closeAndDrain();
  });

  it('says in one line what became of a retirement it owes', () => {
    expect(describeOwedLegacySwmRetirementEventV1({
      kind: 'repeating', key: 'asset', reason: 'not-run', repeat: 1, inMs: 30_000,
    })).toEqual({
      level: 'info',
      line: 'Legacy SWM boundary retirement asset did not get its turn; repeat 1 in 30 s',
    });
    expect(describeOwedLegacySwmRetirementEventV1({
      kind: 'repeating', key: 'asset', reason: 'failed', repeat: 3, inMs: 120_000, error: new Error('busy'),
    })).toEqual({
      level: 'info',
      line: 'Legacy SWM boundary retirement asset failed; repeat 3 in 120 s: busy',
    });
    expect(describeOwedLegacySwmRetirementEventV1({
      kind: 'repeated', key: 'asset', outcome: 'retired', repeats: 2,
    })).toEqual({
      level: 'info',
      line: 'Legacy SWM boundary retirement asset ended on repeat 2: retired',
    });
    expect(describeOwedLegacySwmRetirementEventV1({
      kind: 'abandoned', key: 'asset', reason: 'repeats-exhausted', error: 'not an Error',
    })).toEqual({
      level: 'warn',
      line: 'Legacy SWM boundary retirement asset is not repeated any more (repeats-exhausted); '
        + 'its marker stays until the asset is published again: not an Error',
    });
    expect(describeOwedLegacySwmRetirementEventV1({
      kind: 'abandoned', key: 'asset', reason: 'too-many-owed',
    }).line).toBe(
      'Legacy SWM boundary retirement asset is not repeated any more (too-many-owed); '
        + 'its marker stays until the asset is published again',
    );
  });
});
