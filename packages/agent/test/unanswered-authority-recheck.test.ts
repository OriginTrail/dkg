import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeRpcRequestContext,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';
import {
  activeDefaultStoreWorkPriority,
  withDefaultStoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import {
  describeUnansweredAuthorityCheck,
  UNANSWERED_AUTHORITY_RECHECK_MAX_WAITING,
  UNANSWERED_AUTHORITY_RECHECK_MS,
  UnansweredAuthorityRecheck,
  unansweredAuthorityRecheckFor,
} from '../src/internal/unanswered-authority-recheck.js';

const DELAY_MS = UNANSWERED_AUTHORITY_RECHECK_MS;

describe('UnansweredAuthorityRecheck', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks one graph per delay, in the order they started waiting', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const asked: string[] = [];
    for (const graph of ['a', 'b', 'c']) recheck.defer(graph, () => { asked.push(graph); });
    expect(recheck.size).toBe(3);

    vi.advanceTimersByTime(DELAY_MS - 1);
    expect(asked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(asked).toEqual(['a']);
    vi.advanceTimersByTime(DELAY_MS);
    expect(asked).toEqual(['a', 'b']);
    vi.advanceTimersByTime(DELAY_MS);
    expect(asked).toEqual(['a', 'b', 'c']);
    expect(recheck.size).toBe(0);

    // Nobody is waiting: nothing is left armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the unanswered checks of a graph in a row until it is settled', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const ask = vi.fn();
    expect(recheck.defer('a', ask)).toBe(1);
    vi.advanceTimersByTime(DELAY_MS);
    // The repeat got no answer either.
    expect(recheck.defer('a', ask)).toBe(2);
    vi.advanceTimersByTime(DELAY_MS);
    expect(ask).toHaveBeenCalledTimes(2);

    recheck.settle('a');
    expect(recheck.defer('a', ask)).toBe(1);
  });

  it('keeps the place of a graph that is already waiting and asks it once', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const asked: string[] = [];
    recheck.defer('a', () => { asked.push('a'); });
    recheck.defer('b', () => { asked.push('b'); });
    // Another check of `a` went unanswered before its turn.
    expect(recheck.defer('a', () => { asked.push('a again'); })).toBe(2);
    expect(recheck.size).toBe(2);

    vi.advanceTimersByTime(2 * DELAY_MS);
    expect(asked).toEqual(['a again', 'b']);
    expect(recheck.size).toBe(0);
  });

  it('does not ask a graph that was settled while it waited', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const asked: string[] = [];
    recheck.defer('a', () => { asked.push('a'); });
    recheck.defer('b', () => { asked.push('b'); });
    recheck.settle('a');
    expect(recheck.size).toBe(1);

    vi.advanceTimersByTime(DELAY_MS);
    expect(asked).toEqual(['b']);

    // Settling the last waiting graph leaves nothing armed.
    recheck.defer('c', () => { asked.push('c'); });
    recheck.settle('c');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * DELAY_MS);
    expect(asked).toEqual(['b']);
  });

  it('still asks the graphs behind one whose ask throws', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const asked: string[] = [];
    recheck.defer('a', () => { throw new Error('ask failed'); });
    recheck.defer('b', () => { asked.push('b'); });

    vi.advanceTimersByTime(2 * DELAY_MS);
    expect(asked).toEqual(['b']);
  });

  it('runs an ask as background work, not in the context of the check that armed it', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const armedBy = new AbortController();
    const seen: Array<{
      requestClass: string;
      admissionPriority: unknown;
      signal: unknown;
      storeLane: unknown;
    }> = [];
    withRpcRequestContext(
      { requestClass: 'foreground', signal: armedBy.signal },
      () => withDefaultStoreWorkPriority('normal', () => {
        recheck.defer('a', () => {
          const context = activeRpcRequestContext();
          seen.push({
            requestClass: context.requestClass,
            admissionPriority: context.admissionPriority,
            signal: context.signal,
            storeLane: activeDefaultStoreWorkPriority(),
          });
        });
      }),
    );
    // The request that armed the wait has ended by the time the ask runs.
    armedBy.abort();

    vi.advanceTimersByTime(DELAY_MS);
    expect(seen).toEqual([{
      requestClass: 'background',
      admissionPriority: undefined,
      signal: undefined,
      storeLane: 'background',
    }]);
  });

  it('takes no graph beyond its bound, and takes one again once there is room', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const ask = vi.fn();
    for (let graph = 0; graph < UNANSWERED_AUTHORITY_RECHECK_MAX_WAITING; graph += 1) {
      expect(recheck.defer(`graph-${graph}`, ask)).toBe(1);
    }
    expect(recheck.defer('one-too-many', ask)).toBe(0);
    expect(recheck.size).toBe(UNANSWERED_AUTHORITY_RECHECK_MAX_WAITING);
    // A graph that already waits is not a new one.
    expect(recheck.defer('graph-0', ask)).toBe(2);

    recheck.settle('graph-1');
    expect(recheck.defer('one-too-many', ask)).toBe(1);
  });

  it('drops every waiting graph when closed and takes none afterwards', () => {
    const recheck = new UnansweredAuthorityRecheck();
    const ask = vi.fn();
    recheck.defer('a', ask);
    recheck.defer('b', ask);

    recheck.close();
    expect(recheck.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(recheck.defer('c', ask)).toBe(0);

    vi.advanceTimersByTime(10 * DELAY_MS);
    expect(ask).not.toHaveBeenCalled();
  });

  it('uses the delay it was given', () => {
    const recheck = new UnansweredAuthorityRecheck(40);
    const ask = vi.fn();
    recheck.defer('a', ask);
    vi.advanceTimersByTime(39);
    expect(ask).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('unansweredAuthorityRecheckFor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('gives an owner one queue per lifecycle and closes it when that lifecycle ends', () => {
    const owner = {};
    const firstLifecycle = new AbortController();
    const first = unansweredAuthorityRecheckFor(owner, firstLifecycle.signal);
    expect(unansweredAuthorityRecheckFor(owner, firstLifecycle.signal)).toBe(first);
    // Another owner under the same lifecycle has a queue of its own.
    expect(unansweredAuthorityRecheckFor({}, firstLifecycle.signal)).not.toBe(first);

    const ask = vi.fn();
    first.defer('a', ask);
    firstLifecycle.abort();
    expect(first.size).toBe(0);
    expect(first.defer('a', ask)).toBe(0);
    vi.advanceTimersByTime(10 * DELAY_MS);
    expect(ask).not.toHaveBeenCalled();

    // The owner's next lifecycle starts with nobody waiting.
    const secondLifecycle = new AbortController();
    const second = unansweredAuthorityRecheckFor(owner, secondLifecycle.signal);
    expect(second).not.toBe(first);
    expect(second.defer('a', ask)).toBe(1);
  });

  it('closes the previous queue when the owner moves to a new lifecycle without an abort', () => {
    const owner = {};
    const first = unansweredAuthorityRecheckFor(owner, new AbortController().signal);
    const ask = vi.fn();
    first.defer('a', ask);

    unansweredAuthorityRecheckFor(owner, new AbortController().signal);
    expect(first.size).toBe(0);
    vi.advanceTimersByTime(10 * DELAY_MS);
    expect(ask).not.toHaveBeenCalled();
  });

  it('gives a lifecycle that has already ended a closed queue', () => {
    const ended = new AbortController();
    ended.abort();
    expect(unansweredAuthorityRecheckFor({}, ended.signal).defer('a', vi.fn())).toBe(0);
  });
});

describe('describeUnansweredAuthorityCheck', () => {
  const check = {
    subject: 'SWM gossip subscription for "graph"',
    waitingFor: 'read authority',
    read: 'registered-chain/chain-access-policy-timeout/chain',
    meanwhile: 'the subscription is kept',
  };

  it('says what waits, for what, and that it is asked again', () => {
    expect(describeUnansweredAuthorityCheck({ ...check, unansweredChecks: 1 })).toBe(
      'SWM gossip subscription for "graph" is waiting for read authority '
      + '(registered-chain/chain-access-policy-timeout/chain): the chain read got no answer; '
      + 'the subscription is kept, asking again shortly',
    );
  });

  it('does not promise a repeat the queue did not take', () => {
    expect(describeUnansweredAuthorityCheck({ ...check, unansweredChecks: 0 }))
      .toMatch(/the subscription is kept, asked again at its next reconcile$/);
  });
});
