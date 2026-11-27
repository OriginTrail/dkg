import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROLLING_CHECK_MAX_PAUSE_MS,
  ROLLING_CHECK_MIN_PAUSE_MS,
  ROLLING_CHECK_PAUSE_PER_CHECK_TIME,
  ROLLING_CHECK_REPORT_INTERVAL_MS,
  RollingSubscriptionChecks,
  type RollingSubscriptionCheckOptions,
} from '../src/context-graph-subscription-rolling-checks.js';
import type { ContextGraphDormancyReason } from '../src/context-graph-subscription-dormancy.js';

const ABSENT = { outcome: 'unavailable', source: 'registered-chain', reason: 'finalized-name-absence-unaccepted' } as const;
const UNKNOWN = { outcome: 'unavailable', source: 'registered-chain', reason: 'chain-access-policy-unknown' } as const;
const DENIED = { outcome: 'denied', source: 'registered-chain', reason: 'agent-not-in-chain-roster' } as const;

function backlog(ids: readonly string[], options: RollingSubscriptionCheckOptions = {}) {
  const pendingIds = new Set(ids);
  const dormancyById = new Map<string, ContextGraphDormancyReason>(
    ids.map((id) => [id, 'activationCap']),
  );
  const subscriptions = new Map<string, { onChainId?: string }>();
  const warn = vi.fn<(message: string) => void>();
  const debug = vi.fn<(message: string) => void>();
  const checks = new RollingSubscriptionChecks(options);
  const input = { pendingIds, dormancyById, subscriptions, warn, debug };
  return {
    checks,
    pendingIds,
    dormancyById,
    subscriptions,
    warn,
    debug,
    beginPass: () => checks.beginPass(input),
    /** What the lifecycle does with a row its check left dormant. */
    leave(pass: ReturnType<RollingSubscriptionChecks['beginPass']>, id: string, authority: typeof ABSENT | typeof UNKNOWN | typeof DENIED) {
      pendingIds.delete(id);
      dormancyById.set(id, pass.leftDormant(id, authority));
    },
  };
}

/** A read that answers after `ms` of the faked clock. */
const readTaking = <T>(ms: number, answer: T) => () => new Promise<T>((resolve) => {
  setTimeout(() => resolve(answer), ms);
});

/** Whether `promise` has settled, after the microtasks already queued have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  return done;
}

describe('rolling activation checks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('order', () => {
    it('offers a row that was asked for, then rows with a saved chain id, then the rest, each by id', async () => {
      const rows = backlog(['b-name', 'y-bound', 'a-name', 'z-asked', 'x-bound']);
      rows.subscriptions.set('x-bound', { onChainId: '7' });
      rows.subscriptions.set('y-bound', { onChainId: '9' });
      rows.subscriptions.set('a-name', {});
      rows.checks.prefer('z-asked');
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      const order: string[] = [];
      for (let id = await pass.next(signal); id !== undefined; id = await pass.next(signal)) order.push(id);

      expect(order).toEqual(['z-asked', 'x-bound', 'y-bound', 'a-name', 'b-name']);
    });

    it('offers each row once in a pass, and again in the next pass while it still waits', async () => {
      const rows = backlog(['kept-pending', 'other']);
      const signal = new AbortController().signal;

      const first = rows.beginPass();
      expect(await first.next(signal)).toBe('kept-pending');
      expect(await first.next(signal)).toBe('other');
      expect(await first.next(signal)).toBeUndefined();

      const second = rows.beginPass();
      expect(await second.next(signal)).toBe('kept-pending');
    });

    it('decides the order again before every check', async () => {
      const rows = backlog(['a', 'b', 'c', 'z-asked-late']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      expect(await pass.next(signal)).toBe('a');
      rows.checks.prefer('z-asked-late');
      // A row that stopped waiting, and one that only now started to.
      rows.dormancyById.set('b', 'authorityDenied');
      rows.pendingIds.add('0-handed-over');
      rows.dormancyById.set('0-handed-over', 'activationCap');

      expect(await pass.next(signal)).toBe('z-asked-late');
      expect(await pass.next(signal)).toBe('0-handed-over');
      expect(await pass.next(signal)).toBe('c');
      expect(await pass.next(signal)).toBeUndefined();
    });

    it('keeps a request for a row a pass did not reach, and drops it once the row no longer waits', async () => {
      const rows = backlog(['a', 'z-asked']);
      const signal = new AbortController().signal;
      rows.checks.prefer('z-asked');
      rows.checks.prefer('not-a-saved-row');

      // The pass that was asked ends before it checks anything (no free slot).
      rows.beginPass();
      expect(await rows.beginPass().next(signal)).toBe('z-asked');

      // The row is activated and later waits again; the old request is gone.
      rows.pendingIds.delete('z-asked');
      expect(await rows.beginPass().next(signal)).toBe('a');
      rows.pendingIds.add('z-asked');
      expect(await rows.beginPass().next(signal)).toBe('a');
    });

    it('ignores rows that are pending under another dormancy, and rows that only have a dormancy', async () => {
      const rows = backlog(['waits']);
      rows.pendingIds.add('reclassified');
      rows.dormancyById.set('reclassified', 'authorityUnavailable');
      rows.dormancyById.set('not-pending', 'activationCap');
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      expect(await pass.next(signal)).toBe('waits');
      expect(await pass.next(signal)).toBeUndefined();
    });
  });

  describe('pace', () => {
    it('ships a pause of five seconds to half a minute, four times the check, and a report every five minutes', () => {
      expect({
        ROLLING_CHECK_MIN_PAUSE_MS,
        ROLLING_CHECK_PAUSE_PER_CHECK_TIME,
        ROLLING_CHECK_MAX_PAUSE_MS,
        ROLLING_CHECK_REPORT_INTERVAL_MS,
      }).toEqual({
        ROLLING_CHECK_MIN_PAUSE_MS: 5_000,
        ROLLING_CHECK_PAUSE_PER_CHECK_TIME: 4,
        ROLLING_CHECK_MAX_PAUSE_MS: 30_000,
        ROLLING_CHECK_REPORT_INTERVAL_MS: 300_000,
      });
    });

    it('starts the first check at once and waits the shortest pause after a quick check that activated nothing', async () => {
      const rows = backlog(['a', 'b']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      expect(await pass.next(signal)).toBe('a');
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'a', ABSENT);

      const next = pass.next(signal);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS - 1);
      expect(await settled(next)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await next).toBe('b');
    });

    it('waits a multiple of the time a slow check took', async () => {
      const rows = backlog(['a', 'b']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;
      const tookMs = 2_500;
      const pauseMs = ROLLING_CHECK_PAUSE_PER_CHECK_TIME * tookMs;
      expect(pauseMs).toBeGreaterThan(ROLLING_CHECK_MIN_PAUSE_MS);
      expect(pauseMs).toBeLessThan(ROLLING_CHECK_MAX_PAUSE_MS);

      await pass.next(signal);
      const read = pass.read(readTaking(tookMs, ABSENT));
      await vi.advanceTimersByTimeAsync(tookMs);
      await read;
      rows.leave(pass, 'a', ABSENT);

      const next = pass.next(signal);
      await vi.advanceTimersByTimeAsync(pauseMs - 1);
      expect(await settled(next)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await next).toBe('b');
    });

    it('never waits longer than the longest pause', async () => {
      const rows = backlog(['a', 'b']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;
      const tookMs = 120_000;

      await pass.next(signal);
      const read = pass.read(readTaking(tookMs, ABSENT));
      await vi.advanceTimersByTimeAsync(tookMs);
      await read;

      const next = pass.next(signal);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MAX_PAUSE_MS - 1);
      expect(await settled(next)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await next).toBe('b');
    });

    it('does not wait again for a pause that has passed between two passes', async () => {
      const rows = backlog(['a', 'b']);
      const signal = new AbortController().signal;
      const first = rows.beginPass();
      const tookMs = 120_000;

      await first.next(signal);
      const read = first.read(readTaking(tookMs, ABSENT));
      await vi.advanceTimersByTimeAsync(tookMs);
      await read;
      rows.leave(first, 'a', ABSENT);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MAX_PAUSE_MS);

      expect(await rows.beginPass().next(signal)).toBe('b');
    });

    it('leaves no pause after a check that activated its row', async () => {
      const rows = backlog(['a', 'b', 'c']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      await pass.next(signal);
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'a', ABSENT);
      const afterMiss = pass.next(signal);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS);
      expect(await afterMiss).toBe('b');

      await pass.read(async () => 'allowed');
      pass.activated();
      rows.pendingIds.delete('b');
      expect(await pass.next(signal)).toBe('c');
    });

    it('leaves the pause after a read that ends neither way: it failed, or its row stays pending', async () => {
      const rows = backlog(['a', 'b', 'c']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      await pass.next(signal);
      await expect(pass.read(async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
      const afterFailure = pass.next(signal);
      expect(await settled(afterFailure)).toBe(false);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS);
      expect(await afterFailure).toBe('b');

      // Allowed, but the saved row changed under the read: nothing activated.
      await pass.read(async () => 'allowed');
      const afterKeptPending = pass.next(signal);
      expect(await settled(afterKeptPending)).toBe(false);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS);
      expect(await afterKeptPending).toBe('c');
    });

    it('carries the pause into the next pass', async () => {
      const rows = backlog(['a', 'b']);
      const signal = new AbortController().signal;
      const first = rows.beginPass();
      await first.next(signal);
      await first.read(async () => ABSENT);
      rows.leave(first, 'a', ABSENT);

      const next = rows.beginPass().next(signal);
      expect(await settled(next)).toBe(false);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS);
      expect(await next).toBe('b');
    });

    it('ends a pass that has no row left without waiting out the pause', async () => {
      const rows = backlog(['only']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      await pass.next(signal);
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'only', ABSENT);

      expect(await pass.next(signal)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ends the pass when the last row stops waiting during the pause', async () => {
      const rows = backlog(['a', 'b']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      await pass.next(signal);
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'a', ABSENT);
      const next = pass.next(signal);
      rows.pendingIds.delete('b');
      expect(rows.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS);

      expect(await next).toBeUndefined();
      expect(rows.warn).toHaveBeenCalledOnce();
      expect(rows.warn).toHaveBeenCalledWith(expect.stringContaining('Left 1 pending persisted'));
    });

    it('checks a row asked for during a pause as soon as the pause ends', async () => {
      const rows = backlog(['a', 'b', 'z-asked']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      await pass.next(signal);
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'a', ABSENT);
      const next = pass.next(signal);
      rows.checks.prefer('z-asked');
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS);

      expect(await next).toBe('z-asked');
    });

    it('rejects with the reason of a signal that aborts during the pause, and drops its timer', async () => {
      const rows = backlog(['a', 'b']);
      const pass = rows.beginPass();
      const abort = new AbortController();

      await pass.next(abort.signal);
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'a', ABSENT);
      const next = pass.next(abort.signal);
      expect(await settled(next)).toBe(false);
      const closing = new Error('rolling activation closing');
      abort.abort(closing);

      await expect(next).rejects.toBe(closing);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('refuses a signal that has already aborted', async () => {
      const rows = backlog(['a']);
      const abort = new AbortController();
      const closing = new Error('rolling activation closing');
      abort.abort(closing);

      await expect(rows.beginPass().next(abort.signal)).rejects.toBe(closing);
    });

    it('keeps the default monotonic pause when the wall clock steps backwards', async () => {
      const rows = backlog(['a', 'b']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;
      await pass.next(signal);
      await pass.read(async () => ABSENT);
      rows.leave(pass, 'a', ABSENT);
      vi.setSystemTime(Date.now() - 3_600_000);
      const next = pass.next(signal);
      await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS - 1);
      expect(await settled(next)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await next).toBe('b');
    });

    it('takes its pauses from the options', async () => {
      const rows = backlog(['a', 'b', 'c', 'd'], { minPauseMs: 100, maxPauseMs: 5_000, pausePerCheckTime: 2 });
      const pass = rows.beginPass();
      const signal = new AbortController().signal;
      const waitsExactly = async (next: Promise<string | undefined>, pauseMs: number, id: string) => {
        await vi.advanceTimersByTimeAsync(pauseMs - 1);
        expect(await settled(next)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await next).toBe(id);
      };

      await pass.next(signal);
      await pass.read(async () => ABSENT);
      await waitsExactly(pass.next(signal), 100, 'b');

      const slow = pass.read(readTaking(1_000, ABSENT));
      await vi.advanceTimersByTimeAsync(1_000);
      await slow;
      await waitsExactly(pass.next(signal), 2_000, 'c');

      const slower = pass.read(readTaking(4_000, ABSENT));
      await vi.advanceTimersByTimeAsync(4_000);
      await slower;
      await waitsExactly(pass.next(signal), 5_000, 'd');
    });
  });

  describe('what a row left dormant becomes', () => {
    it.each([
      ['a denial', DENIED, 'authorityDenied'],
      ['an id the chain does not know', UNKNOWN, 'deactivated'],
      ['a name the chain does not have', ABSENT, 'authorityUnavailable'],
      ['a read that got no answer', { outcome: 'unavailable', source: 'registered-chain', reason: 'chain-access-policy-timeout' }, 'authorityUnavailable'],
    ] as const)('%s', (_name, authority, dormancy) => {
      const rows = backlog(['row']);
      expect(rows.beginPass().leftDormant('row', authority)).toBe(dormancy);
    });
  });

  describe('report', () => {
    it('says once, when the pass runs out of rows, what it left dormant and why', async () => {
      const rows = backlog(['a', 'b', 'c', 'd'], { minPauseMs: 0, pausePerCheckTime: 0 });
      const pass = rows.beginPass();
      const signal = new AbortController().signal;
      const answers = { a: ABSENT, b: DENIED, c: ABSENT, d: UNKNOWN } as const;

      for (let id = await pass.next(signal); id !== undefined; id = await pass.next(signal)) {
        await pass.read(async () => answers[id as keyof typeof answers]);
        rows.leave(pass, id, answers[id as keyof typeof answers]);
      }

      expect(rows.debug.mock.calls.map(([message]) => message)).toEqual([
        'Left pending persisted context-graph subscription "a" dormant: unavailable by registered-chain (finalized-name-absence-unaccepted)',
        'Left pending persisted context-graph subscription "b" dormant: denied by registered-chain (agent-not-in-chain-roster)',
        'Left pending persisted context-graph subscription "c" dormant: unavailable by registered-chain (finalized-name-absence-unaccepted)',
        'Left pending persisted context-graph subscription "d" dormant: unavailable by registered-chain (chain-access-policy-unknown)',
      ]);
      expect(rows.warn.mock.calls.map(([message]) => message)).toEqual([
        'Left 4 pending persisted context-graph subscription(s) dormant: '
          + '2 unavailable by registered-chain (finalized-name-absence-unaccepted), '
          + '1 denied by registered-chain (agent-not-in-chain-roster), '
          + '1 unavailable by registered-chain (chain-access-policy-unknown). '
          + '0 more wait for their check. '
          + "Inspect 'GET /api/context-graph/subscriptions' for dormant ids.",
      ]);
    });

    it('reports at the interval while a long pass is still running', async () => {
      const ids = Array.from({ length: 8 }, (_, i) => `row-${i}`);
      const rows = backlog(ids, { minPauseMs: 60_000, maxPauseMs: 60_000 });
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      // One row a minute: the sixth is left dormant five minutes after the first.
      for (let checked = 0; checked < 6; checked++) {
        const next = pass.next(signal);
        await vi.advanceTimersByTimeAsync(60_000);
        const id = (await next)!;
        await pass.read(async () => ABSENT);
        rows.leave(pass, id, ABSENT);
        expect(rows.warn).toHaveBeenCalledTimes(checked === 5 ? 1 : 0);
      }

      expect(rows.warn).toHaveBeenLastCalledWith(expect.stringContaining(
        'Left 6 pending persisted context-graph subscription(s) dormant: '
          + '6 unavailable by registered-chain (finalized-name-absence-unaccepted). 2 more wait',
      ));

      // The interval starts again with the report: the rows after it are
      // reported together when the pass runs out, and the first six are not
      // reported a second time.
      for (let checked = 0; checked < 2; checked++) {
        const next = pass.next(signal);
        await vi.advanceTimersByTimeAsync(60_000);
        const id = (await next)!;
        await pass.read(async () => DENIED);
        rows.leave(pass, id, DENIED);
        expect(rows.warn).toHaveBeenCalledTimes(1);
      }
      expect(await pass.next(signal)).toBeUndefined();
      expect(rows.warn).toHaveBeenCalledTimes(2);
      expect(rows.warn).toHaveBeenLastCalledWith(expect.stringContaining(
        'Left 2 pending persisted context-graph subscription(s) dormant: '
          + '2 denied by registered-chain (agent-not-in-chain-roster). 0 more wait',
      ));
    });

    it('counts the rows that still wait, and reports what an earlier pass left when a later one ends', async () => {
      const rows = backlog(['a', 'b', 'c'], { minPauseMs: 0, pausePerCheckTime: 0 });
      rows.pendingIds.add('pending-under-another-dormancy');
      rows.dormancyById.set('pending-under-another-dormancy', 'authorityUnavailable');
      const signal = new AbortController().signal;

      // The first pass stops after one row (no free activation slot).
      const first = rows.beginPass();
      await first.next(signal);
      await first.read(async () => ABSENT);
      rows.leave(first, 'a', ABSENT);
      expect(rows.warn).not.toHaveBeenCalled();

      const second = rows.beginPass();
      await second.next(signal);
      await second.read(async () => DENIED);
      rows.leave(second, 'b', DENIED);
      // The last row stays pending after its check; the pass has no row left.
      await second.next(signal);
      expect(await second.next(signal)).toBeUndefined();

      expect(rows.warn).toHaveBeenCalledTimes(1);
      expect(rows.warn).toHaveBeenCalledWith(expect.stringContaining(
        'Left 2 pending persisted context-graph subscription(s) dormant: '
          + '1 denied by registered-chain (agent-not-in-chain-roster), '
          + '1 unavailable by registered-chain (finalized-name-absence-unaccepted). '
          + '1 more wait for their check.',
      ));
    });

    it('says nothing when a pass left nothing dormant', async () => {
      const rows = backlog(['a']);
      const pass = rows.beginPass();
      const signal = new AbortController().signal;

      await pass.next(signal);
      await pass.read(async () => 'allowed');
      pass.activated();
      rows.pendingIds.delete('a');

      expect(await pass.next(signal)).toBeUndefined();
      expect(await rows.beginPass().next(signal)).toBeUndefined();
      expect(rows.warn).not.toHaveBeenCalled();
      expect(rows.debug).not.toHaveBeenCalled();
    });
  });
});
