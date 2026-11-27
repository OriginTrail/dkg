/**
 * GH#3081 — the lifecycle of catalog head delivery: the close path aborts and drains every
 * fan-out, and the awaited announce behind the explicit API shares the bounded fan-out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 } from '../src/rfc64/public-catalog-head-delivery-v1.js';
import {
  RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1,
  RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1,
} from '../src/rfc64/public-catalog-head-fanout-v1.js';
import {
  BUDGET_MS,
  author,
  harness,
  head,
  peers,
  settle,
} from './support/rfc64-catalog-head-delivery-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 catalog head delivery: close', () => {
  it('aborts a running fan-out, drops waiting heads and resolves once the sends have settled', async () => {
    vi.useFakeTimers();
    const sends: string[] = [];
    let unwinding = 0;
    const { delivery, outcomes } = harness({
      send: (peerId, announcement, options) => new Promise<void>((resolve, reject) => {
        sends.push(`${peerId}@${announcement.catalogVersion}`);
        if (peerId === 'quick-peer') {
          resolve();
          return;
        }
        // A send that needs a moment to unwind after its signal aborts.
        options.signal!.addEventListener('abort', () => {
          unwinding += 1;
          setTimeout(() => {
            unwinding -= 1;
            reject(options.signal!.reason);
          }, 50);
        }, { once: true });
      }),
    });

    delivery.deliver({ announcement: head('1'), peers: ['quick-peer', 'slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: ['quick-peer', 'slow-peer'] });
    expect(sends).toEqual(['quick-peer@1', 'slow-peer@1']);

    let closed = false;
    const closing = delivery.close().then(() => { closed = true; });
    await settle();
    expect(unwinding).toBe(1);
    expect(closed).toBe(false);
    expect(delivery.deliver({ announcement: head('3'), peers: ['quick-peer'] }))
      .toEqual({ status: 'not-queued', reason: 'closed' });

    await vi.advanceTimersByTimeAsync(50);
    await closing;
    expect(closed).toBe(true);
    expect(unwinding).toBe(0);
    // Nothing was sent after close began: neither the waiting head nor a later hand-off.
    expect(sends).toEqual(['quick-peer@1', 'slow-peer@1']);
    expect(delivery.pendingScopes).toBe(0);
    // The send that close cut short is not a failed delivery.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['quick-peer'],
      failedPeers: [],
      refusedPeers: [],
      notDeliverable: 'RFC-64 catalog head delivery closed',
    });
    expect(vi.getTimerCount()).toBe(0);
    await expect(delivery.close()).resolves.toBeUndefined();
  });

  it('releases scopes that were waiting for their turn, and does not wait for policy reads in flight', async () => {
    vi.useFakeTimers();
    const finishSelection: Array<() => void> = [];
    const { delivery, sends, outcomes } = harness({
      isPeerAuthorized: () => new Promise((resolve) => {
        finishSelection.push(() => resolve(true));
      }),
    });
    const scopes = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 3;
    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('1', author(index)), peers: ['peer-a', 'peer-b'] });
    }
    await settle();
    // Four fan-outs are selecting their peers; three scopes wait for a turn.
    expect(finishSelection).toHaveLength(RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 * 2);

    // A policy decision that is being read cannot be cut short, and close does not wait for it:
    // the fan-outs end where they are.
    await delivery.close();

    expect(sends).toEqual([]);
    expect(delivery.pendingScopes).toBe(0);
    // A decision that arrives afterwards changes nothing.
    for (const finish of finishSelection.splice(0)) finish();
    await settle();
    expect(sends).toEqual([]);
    expect(outcomes).toHaveLength(RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1);
    expect(new Set(outcomes.map(({ notDeliverable }) => notDeliverable)))
      .toEqual(new Set(['RFC-64 catalog head delivery closed']));
    // Giving up on a read because the owner closes is not the same as being unable to check.
    expect(outcomes.every(({ failedPeers, refusedPeers, uncheckedPeers }) => (
      failedPeers.length === 0 && refusedPeers.length === 0 && uncheckedPeers.length === 0
    ))).toBe(true);
  });

  it('stops asking the policy once it is closing', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const finishSelection: Array<() => void> = [];
    const { delivery, sends, outcomes } = harness({
      isPeerAuthorized: (peerId) => new Promise((resolve) => {
        asked.push(peerId);
        finishSelection.push(() => resolve(true));
      }),
    });
    const everyone = peers(7);

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await settle();
    // Four decisions are being read; three peers have not been asked about yet.
    expect(asked).toEqual(everyone.slice(0, 4));

    await delivery.close();
    for (const finish of finishSelection.splice(0)) finish();
    await settle();

    expect(asked).toEqual(everyone.slice(0, 4));
    expect(sends).toEqual([]);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: [],
      failedPeers: [],
      refusedPeers: [],
      notDeliverable: 'RFC-64 catalog head delivery closed',
    });
  });

  it('asks the policy about nobody when a fan-out only starts after close', async () => {
    let startFanout!: () => void;
    const hostReady = new Promise<void>((resolve) => { startFanout = resolve; });
    const { delivery, sends, outcomes, decisions } = harness({
      // The host takes a moment before it runs the fan-out, and the owner closes meanwhile.
      runFanout: async (fanout) => {
        await hostReady;
        await fanout();
      },
    });

    delivery.deliver({ announcement: head('1'), peers: peers(6) });
    await Promise.resolve();
    const closing = delivery.close();
    startFanout();
    await closing;

    expect(decisions).toEqual([]);
    expect(sends).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: [],
      refusedPeers: [],
      uncheckedPeers: [],
      notDeliverable: 'RFC-64 catalog head delivery closed',
    });
  });

  it('waits at close only a moment for a send whose policy check never answers', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, hungChecks } = harness();
    hungChecks.add('hung-check');

    delivery.deliver({ announcement: head('1'), peers: ['hung-check'] });
    await settle();
    let closed = false;
    const closing = delivery.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1 - 1);
    // A send gets the time it needs to unwind ...
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // ... and no longer: the read it is waiting for cannot be cut short.
    await closing;

    expect(sends).toEqual([]);
    expect(delivery.pendingScopes).toBe(0);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: [],
      failedPeers: [],
      notDeliverable: 'RFC-64 catalog head delivery closed',
    });
  });

  it('settles an awaited announce that is in flight', async () => {
    vi.useFakeTimers();
    const { delivery, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    const announcing = delivery.announce(head('1'), ['slow-peer']);
    await settle();
    await delivery.close();

    await expect(announcing).resolves.toMatchObject({
      announcedPeers: [],
      failedPeers: [{ peerId: 'slow-peer', error: 'RFC-64 catalog head delivery closed' }],
    });
  });
});

describe('RFC-64 catalog head delivery: awaited announce', () => {
  it('attempts every requested peer, a locally refused one included, and reports in input order', async () => {
    const { delivery, sends, behaviour, refused, decisions } = harness();
    refused.add('outsider');
    behaviour.set('offline-peer', 'unreachable');

    const result = await delivery.announce(head('1'), ['outsider', 'member', 'offline-peer', 'member-2']);

    expect(result.announcedPeers).toEqual(['member', 'member-2']);
    expect(result.failedPeers).toEqual([
      {
        peerId: 'outsider',
        error: '[catalog-transport-policy-denied] catalog operation is not access-policy authorized',
        code: 'catalog-transport-policy-denied',
      },
      { peerId: 'offline-peer', error: 'all multiaddr dials failed' },
    ]);
    expect(sends.map(({ peerId }) => peerId)).toEqual(['member', 'offline-peer', 'member-2']);
    // The explicit API has no selection step of its own: the transport decides per send.
    expect(decisions).toEqual([]);
    expect(Object.isFrozen(result.failedPeers[0])).toBe(true);
  });

  it('ends at one budget for the whole fan-out, not one per peer', async () => {
    vi.useFakeTimers();
    const { delivery, behaviour } = harness();
    const everyone = peers(11);
    for (const peerId of everyone) behaviour.set(peerId, 'stall');
    const startedAt = Date.now();

    const announcing = delivery.announce(head('1'), everyone);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const result = await announcing;

    expect(Date.now() - startedAt).toBe(BUDGET_MS);
    expect(result.failedPeers.map(({ peerId }) => peerId)).toEqual(everyone);
  });

  it('ends the in-flight wave on the caller\'s abort and does not report the waves it skipped', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    const everyone = peers(RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1 + 2);
    for (const peerId of everyone) behaviour.set(peerId, 'stall');
    const caller = new AbortController();

    const announcing = delivery.announce(head('1'), everyone, caller.signal);
    await settle();
    caller.abort(new Error('caller gave up'));
    const result = await announcing;

    const firstWave = everyone.slice(0, RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1);
    expect(sends.map(({ peerId }) => peerId)).toEqual(firstWave);
    expect(result.announcedPeers).toEqual([]);
    expect(result.failedPeers).toEqual(firstWave.map((peerId) => ({ peerId, error: 'caller gave up' })));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends nothing when the caller\'s signal is already aborted', async () => {
    const { delivery, sends } = harness();
    const caller = new AbortController();
    caller.abort(new Error('already cancelled'));

    await expect(delivery.announce(head('1'), ['peer-a'], caller.signal)).resolves.toMatchObject({
      announcedPeers: [],
      failedPeers: [],
    });
    expect(sends).toEqual([]);
  });

  it('stops following the caller\'s signal once the fan-out has ended', async () => {
    const { delivery } = harness();
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, 'addEventListener');
    const removed = vi.spyOn(caller.signal, 'removeEventListener');

    await delivery.announce(head('1'), ['peer-a', 'peer-b'], caller.signal);

    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]![1]).toBe(added.mock.calls[0]![1]);
  });
});
