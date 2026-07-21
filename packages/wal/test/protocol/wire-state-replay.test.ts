import { describe, expect, it } from 'vitest';
import {
  asWalWireError,
  WalProviderRequestStateMachine,
  WalReplayCache,
  WalRequesterStateMachine,
  WalWireError,
  WAL_WIRE_ERROR_CODE,
} from '../../src/protocol/index.js';
import { requestId } from './wire-fixtures.js';

describe('WAL requester/provider protocol state machines', () => {
  it('covers equal, IBLT continuation, fallback, backfill, range, switch, cancel, and failure paths', () => {
    const equal = new WalRequesterStateMachine();
    expect(equal.transition('HEAD_RECEIVED')).toBe('head-known');
    expect(equal.transition('ROOTS_EQUAL')).toBe('complete');
    expect(() => equal.transition('FAIL')).toThrow(/invalid requester transition/);

    const iblt = new WalRequesterStateMachine();
    iblt.transition('HEAD_RECEIVED');
    iblt.transition('START_IBLT');
    expect(iblt.transition('NEED_MORE_SYMBOLS')).toBe('reconciling');
    expect(iblt.transition('PROVIDER_SWITCH')).toBe('reconciling');
    iblt.transition('IBLT_DECODED');
    expect(iblt.transition('PROVIDER_SWITCH')).toBe('fetching');
    expect(iblt.transition('OBJECTS_VERIFIED')).toBe('complete');

    const fallback = new WalRequesterStateMachine();
    fallback.transition('HEAD_RECEIVED');
    fallback.transition('START_IBLT');
    fallback.transition('FALLBACK_ENUMERATION');
    expect(fallback.transition('PROVIDER_SWITCH')).toBe('enumerating');
    fallback.transition('ENUMERATION_VERIFIED');
    fallback.transition('OBJECTS_VERIFIED');
    expect(fallback.state).toBe('complete');

    const backfill = new WalRequesterStateMachine();
    backfill.transition('HEAD_RECEIVED');
    expect(backfill.transition('PROVIDER_SWITCH')).toBe('head-known');
    backfill.transition('FALLBACK_ENUMERATION');
    backfill.transition('CANCEL');
    expect(backfill.state).toBe('cancelled');

    const failed = new WalRequesterStateMachine();
    expect(failed.transition('FAIL')).toBe('failed');
    const cancelled = new WalRequesterStateMachine();
    expect(cancelled.transition('CANCEL')).toBe('cancelled');
  });

  it('covers provider authorization, queue, execution, cancellation, and failure', () => {
    const direct = new WalProviderRequestStateMachine();
    direct.transition('AUTHORIZE');
    direct.transition('START');
    expect(direct.transition('RESPOND')).toBe('responded');
    expect(() => direct.transition('FAIL')).toThrow(/invalid provider transition/);

    const queued = new WalProviderRequestStateMachine();
    queued.transition('AUTHORIZE');
    queued.transition('QUEUE');
    queued.transition('START');
    expect(queued.transition('CANCEL')).toBe('cancelled');

    for (const event of ['CANCEL', 'FAIL'] as const) {
      const state = new WalProviderRequestStateMachine();
      expect(state.transition(event)).toBe(event === 'CANCEL' ? 'cancelled' : 'failed');
    }
    const authorizedFailure = new WalProviderRequestStateMachine();
    authorizedFailure.transition('AUTHORIZE');
    expect(authorizedFailure.transition('FAIL')).toBe('failed');
    const queuedFailure = new WalProviderRequestStateMachine();
    queuedFailure.transition('AUTHORIZE');
    queuedFailure.transition('QUEUE');
    expect(queuedFailure.transition('FAIL')).toBe('failed');
    const runningFailure = new WalProviderRequestStateMachine();
    runningFailure.transition('AUTHORIZE');
    runningFailure.transition('START');
    expect(runningFailure.transition('FAIL')).toBe('failed');
  });
});

describe('bounded replay cache and wire errors', () => {
  it('rejects duplicates, enforces both capacities, and frees expired entries', () => {
    const cache = new WalReplayCache({ maximumEntriesPerPeer: 1, maximumEntriesGlobal: 2 });
    cache.claim('a', requestId(1), 10, 0);
    expect(cache.size).toBe(1);
    expect(() => cache.claim('a', requestId(1), 10, 0)).toThrow(expect.objectContaining({ code: WAL_WIRE_ERROR_CODE.UNAUTHORIZED }));
    expect(() => cache.claim('a', requestId(2), 10, 0)).toThrow(expect.objectContaining({ code: WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT }));
    cache.claim('b', requestId(2), 10, 0);
    expect(() => cache.claim('c', requestId(3), 10, 0)).toThrow(expect.objectContaining({ code: WAL_WIRE_ERROR_CODE.RESOURCE_LIMIT }));
    cache.purge(9);
    expect(cache.size).toBe(2);
    cache.purge(10);
    expect(cache.size).toBe(0);
    cache.claim('a', requestId(3), 20, 10);
    expect(cache.size).toBe(1);

    const staggered = new WalReplayCache({ maximumEntriesPerPeer: 3, maximumEntriesGlobal: 3 });
    staggered.claim('same', requestId(4), 10, 0);
    staggered.claim('same', requestId(5), 20, 0);
    staggered.purge(10);
    expect(staggered.size).toBe(1);
    staggered.claim('same', requestId(6), 30, 10);
    expect(staggered.size).toBe(2);
  });

  it('preserves typed wire errors and bounds unknown failures', () => {
    const typed = new WalWireError(4, 'busy', 8, 50n, requestId(1));
    expect(asWalWireError(typed)).toBe(typed);
    expect(typed.toTuple()).toEqual([4n, 50n, 8n]);
    expect(asWalWireError(new Error('boom')).toTuple()).toEqual([6n, null, null]);
    expect(asWalWireError('boom').toTuple()).toEqual([6n, null, null]);
  });
});
