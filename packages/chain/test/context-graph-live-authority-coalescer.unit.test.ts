// SPDX-License-Identifier: Apache-2.0
/**
 * In-flight sharing for the one-read Context Graph live authority.
 *
 * The security property under test is NEGATIVE and easy to lose silently: a
 * caller must never be answered with an outcome that belongs to another
 * caller's read. Draft PR #2666 lost exactly that — it shared the bounded
 * agent resolution, so the INITIATOR's 2,500 ms timeout became a VALUE its
 * joiners consumed as if it were their own read's answer, and a gate that
 * should have re-read failed closed on someone else's clock.
 *
 * So the cases below are written around who owns what: an abort belongs to the
 * waiter that raised it, a failure belongs to the read that suffered it, and
 * only a DEFINITIVE answer (tuple, `null`, or the deterministic unsupported
 * fault) may cross between callers.
 */
import { describe, it, expect } from 'vitest';
import {
  ContextGraphLiveAuthorityCoalescer,
} from '../src/context-graph-live-authority-coalescer.js';
import { ContextGraphLiveAuthorityUnsupportedError } from '../src/chain-adapter.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';

type Authority = { readonly id: string } | null;

const KEY = 'evm:31337:0xcafe:7';
const OTHER_CONTRACT_KEY = 'evm:31337:0xbeef:7';

/** Dispatch under test control, so "same turn" is exact instead of timed. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    defer: (dispatch: () => void) => { queue.push(dispatch); },
    /** Run every dispatch enqueued so far, then let microtasks drain. */
    flush: async () => {
      for (const dispatch of queue.splice(0)) dispatch();
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => queue.length,
  };
}

/** A loader whose every call is settled explicitly by the test. */
function controllableLoader() {
  const calls: Array<{
    readonly signal: AbortSignal;
    readonly resolve: (value: Authority) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  const load = (signal: AbortSignal) => new Promise<Authority>((resolve, reject) => {
    calls.push({ signal, resolve, reject });
  });
  return { load, calls };
}

function settled<T>(promise: Promise<T>) {
  const state = { done: false, value: undefined as T | undefined, error: undefined as unknown };
  promise.then(
    (value) => { state.done = true; state.value = value; },
    (error) => { state.done = true; state.error = error; },
  );
  return state;
}

type ContextGraphLiveAuthorityCoalescerFixture =
  ContextGraphLiveAuthorityCoalescer<Authority>;

/** The production wiring, macrotask deferral and all. */
function realDeferralCoalescer(): ContextGraphLiveAuthorityCoalescerFixture {
  return new ContextGraphLiveAuthorityCoalescer<Authority>({
    isDefinitiveError: (error) => error instanceof ContextGraphLiveAuthorityUnsupportedError,
  });
}

function coalescer(
  scheduler: ReturnType<typeof manualScheduler>,
): ContextGraphLiveAuthorityCoalescerFixture {
  return new ContextGraphLiveAuthorityCoalescer<Authority>({
    defer: scheduler.defer,
    isDefinitiveError: (error) => error instanceof ContextGraphLiveAuthorityUnsupportedError,
  });
}

describe('ContextGraphLiveAuthorityCoalescer', () => {
  it('#2666: a joiner never inherits the initiator\'s failed read; they share ONE re-read', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const initiator = settled(flight.run(KEY, load, {}));
    const joiners = [0, 1, 2].map(() => settled(flight.run(KEY, load, {})));
    await scheduler.flush();
    expect(calls).toHaveLength(1);

    // The initiator's 2,500 ms budget ends ITS read. #2666 handed that to the
    // joiners as their answer.
    const budgetExpired = Object.assign(new Error('bounded read expired'), { name: 'AbortError' });
    calls[0]!.reject(budgetExpired);
    await new Promise((resolve) => setImmediate(resolve));

    expect(initiator.error).toBe(budgetExpired);
    expect(joiners.every((joiner) => !joiner.done)).toBe(true);
    // All three resumed together, so they re-read through ONE successor.
    expect(scheduler.pending()).toBe(1);

    await scheduler.flush();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ id: 'live' });
    await new Promise((resolve) => setImmediate(resolve));

    for (const joiner of joiners) {
      expect(joiner.error).toBeUndefined();
      expect(joiner.value).toEqual({ id: 'live' });
    }
  });

  it('gives up re-reading rather than spinning on a permanently failing endpoint', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const joinerFailures: unknown[] = [];
    const initiator = settled(flight.run(KEY, load, {}));
    const joiner = flight.run(KEY, load, {}).catch((error) => { joinerFailures.push(error); });

    await scheduler.flush();
    calls[0]!.reject(new Error('endpoint down'));
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.flush();
    const second = new Error('endpoint still down');
    calls[1]!.reject(second);
    await joiner;

    expect(initiator.error).toBeInstanceOf(Error);
    expect(joinerFailures).toEqual([second]);
    expect(calls).toHaveLength(2);
    expect(scheduler.pending()).toBe(0);
  });

  it('shares one read with every caller of the same turn, and every DEFINITIVE answer', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const tuple = Promise.all([0, 1, 2, 3, 4].map(() => flight.run(KEY, load, {})));
    await scheduler.flush();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ id: 'live' });
    expect(await tuple).toEqual([
      { id: 'live' }, { id: 'live' }, { id: 'live' }, { id: 'live' }, { id: 'live' },
    ]);

    // `null` is the chain PROVING the id nonexistent — definitive, so shared.
    const absent = Promise.all([flight.run(KEY, load, {}), flight.run(KEY, load, {})]);
    await scheduler.flush();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(null);
    expect(await absent).toEqual([null, null]);

    // A deterministic decode/ABI fault answers every waiter the same way; the
    // caller above it falls back to the point reads, which is not a re-read of
    // this one.
    const fault = new ContextGraphLiveAuthorityUnsupportedError('no such view');
    const unsupportedWaiters = [flight.run(KEY, load, {}), flight.run(KEY, load, {})]
      .map((promise) => promise.catch((error) => error));
    await scheduler.flush();
    expect(calls).toHaveLength(3);
    calls[2]!.reject(fault);
    expect(await Promise.all(unsupportedWaiters)).toEqual([fault, fault]);
  });

  it('retains nothing: a caller arriving after dispatch always causes a new read', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const first = flight.run(KEY, load, {});
    await scheduler.flush();
    expect(calls).toHaveLength(1);

    // Arrives while the first read is still running: it must NOT be answered by
    // a read issued before it asked, however fresh that read is.
    const late = flight.run(KEY, load, {});
    calls[0]!.resolve({ id: 'first' });
    expect(await first).toEqual({ id: 'first' });
    expect(calls).toHaveLength(1);

    await scheduler.flush();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ id: 'second' });
    expect(await late).toEqual({ id: 'second' });

    // And serial callers pay per call — the kill-switch equivalence.
    for (let i = 0; i < 3; i += 1) {
      const serial = flight.run(KEY, load, {});
      await scheduler.flush();
      calls[calls.length - 1]!.resolve({ id: `serial-${i}` });
      expect(await serial).toEqual({ id: `serial-${i}` });
    }
    expect(calls).toHaveLength(5);
  });

  it('partitions by request class so a foreground gate never waits on a throttled background read', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const background = flight.run(KEY, load, { requestClass: 'background' });
    const foreground = flight.run(KEY, load, { requestClass: 'foreground' });
    await scheduler.flush();
    expect(calls).toHaveLength(2);

    calls[1]!.resolve({ id: 'foreground' });
    expect(await foreground).toEqual({ id: 'foreground' });
    calls[0]!.resolve({ id: 'background' });
    expect(await background).toEqual({ id: 'background' });
  });

  it('defaults the partition to the caller\'s ambient request class', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const ambientBackground = withRpcRequestContext(
      { requestClass: 'background' },
      () => flight.run(KEY, load, {}),
    );
    const ambientForeground = flight.run(KEY, load, {});
    await scheduler.flush();
    expect(calls).toHaveLength(2);
    calls[0]!.resolve({ id: 'bg' });
    calls[1]!.resolve({ id: 'fg' });
    expect(await ambientBackground).toEqual({ id: 'bg' });
    expect(await ambientForeground).toEqual({ id: 'fg' });
  });

  it('settles a flight whose classifier THROWS, instead of wedging its waiters', async () => {
    const scheduler = manualScheduler();
    // The classifier is the one piece of caller-supplied code on the settle
    // path. The shipped one is instanceof-only so it cannot throw today, but a
    // flight that never settles holds every enrolled waiter to its own
    // deadline — so settling is structural, not a property of the two
    // classification branches.
    const flight = new ContextGraphLiveAuthorityCoalescer<Authority>({
      defer: scheduler.defer,
      isDefinitiveError: () => { throw new Error('classifier exploded'); },
    });
    const { load, calls } = controllableLoader();

    const initiator = settled(flight.run(KEY, load, {}));
    const joiner = settled(flight.run(KEY, load, {}));
    await scheduler.flush();
    const down = new Error('endpoint down');
    calls[0]!.reject(down);
    await new Promise((resolve) => setImmediate(resolve));

    // The initiator still gets ITS read's error, not a synthetic settle fault.
    expect(initiator.error).toBe(down);
    // Unclassifiable is INDEFINITE: nothing crosses callers, so the joiner
    // re-reads rather than being handed a fault nobody could vouch for.
    expect(joiner.done).toBe(false);
    expect(scheduler.pending()).toBe(1);
    await scheduler.flush();
    calls[1]!.resolve({ id: 'live' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(joiner.value).toEqual({ id: 'live' });
  });

  // This case pins the coalescer's KEY PARTITIONING — two distinct keys never
  // share a flight. That the ADAPTER builds those keys from the full lineage is
  // a separate claim, pinned against the real `getContextGraphLiveAuthority` in
  // `evm-adapter-live-authority.unit.test.ts`.
  it('never merges two distinct keys into one flight', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const here = flight.run(KEY, load, {});
    const elsewhere = flight.run(OTHER_CONTRACT_KEY, load, {});
    await scheduler.flush();
    expect(calls).toHaveLength(2);
    calls[0]!.resolve({ id: 'here' });
    calls[1]!.resolve({ id: 'elsewhere' });
    expect(await here).toEqual({ id: 'here' });
    expect(await elsewhere).toEqual({ id: 'elsewhere' });
  });

  it('a waiter\'s abort detaches only that waiter; the last one out cancels the read', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const leaving = new AbortController();
    const abandons = settled(flight.run(KEY, load, { signal: leaving.signal }));
    const stays = settled(flight.run(KEY, load, {}));
    await scheduler.flush();
    expect(calls).toHaveLength(1);

    leaving.abort(new Error('caller gone'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(abandons.error).toBeInstanceOf(Error);
    // The read belongs to the flight, not to the caller that happened to start
    // it: one leaving waiter must not cancel it for the other.
    expect(calls[0]!.signal.aborted).toBe(false);

    calls[0]!.resolve({ id: 'live' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stays.value).toEqual({ id: 'live' });
  });

  it('cancels an abandoned read, and never issues one nobody is waiting for', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const only = new AbortController();
    const sole = settled(flight.run(KEY, load, { signal: only.signal }));
    await scheduler.flush();
    expect(calls).toHaveLength(1);
    only.abort(new Error('caller gone'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sole.error).toBeInstanceOf(Error);
    expect(calls[0]!.signal.aborted).toBe(true);

    // Abandoned BEFORE dispatch: the RPC is never admitted at all.
    const early = new AbortController();
    const abandoned = settled(flight.run(KEY, load, { signal: early.signal }));
    early.abort(new Error('caller gone'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(abandoned.error).toBeInstanceOf(Error);
    await scheduler.flush();
    expect(calls).toHaveLength(1);
  });

  it('invalidation stops new joiners without disturbing the callers already sharing a read', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const enrolled = flight.run(KEY, load, {});
    flight.invalidateAll();
    const afterRotation = flight.run(KEY, load, {});
    await scheduler.flush();
    expect(calls).toHaveLength(2);

    calls[0]!.resolve({ id: 'pre-rotation' });
    calls[1]!.resolve({ id: 'post-rotation' });
    // No caller ever sees an invalidation error in place of its answer.
    expect(await enrolled).toEqual({ id: 'pre-rotation' });
    expect(await afterRotation).toEqual({ id: 'post-rotation' });
  });

  it('rejects an already-aborted caller before opening a flight', async () => {
    const scheduler = manualScheduler();
    const flight = coalescer(scheduler);
    const { load, calls } = controllableLoader();

    const aborted = AbortSignal.abort(new Error('gone before asking'));
    await expect(flight.run(KEY, load, { signal: aborted })).rejects.toThrow('gone before asking');
    await scheduler.flush();
    expect(calls).toHaveLength(0);
  });

  it('defaults to a real macrotask deferral so production callers batch per turn', async () => {
    const live = realDeferralCoalescer();
    const { load, calls } = controllableLoader();
    const batched = Promise.all([live.run(KEY, load, {}), live.run(KEY, load, {})]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ id: 'live' });
    expect(await batched).toEqual([{ id: 'live' }, { id: 'live' }]);
  });
});
