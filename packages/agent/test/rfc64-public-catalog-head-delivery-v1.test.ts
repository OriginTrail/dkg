/**
 * GH#3081 — delivery of catalog head announcements outside the serialized catalog mutation:
 * the hand-off returns at once, peers the local policy refuses receive nothing and are not
 * failures, and one budget bounds a whole fan-out. The scope owner's rules and the lifecycle
 * have their own suites beside this one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1,
  RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1,
} from '../src/rfc64/public-catalog-head-delivery-v1.js';
import { BUDGET_MS, harness, head, peers, settle } from './support/rfc64-catalog-head-delivery-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 catalog head delivery: hand-off', () => {
  it('returns from the hand-off before anything is sent, then delivers', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes } = harness();

    const receipt = delivery.deliver({ announcement: head('7'), peers: ['peer-a', 'peer-b'] });

    // The receipt says what became of the hand-off, and nothing about a delivery.
    expect(receipt).toEqual({ status: 'queued' });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(sends).toEqual([]);
    expect(delivery.pendingScopes).toBe(1);

    await delivery.whenIdle();
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['peer-a', '7'],
      ['peer-b', '7'],
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['peer-a', 'peer-b'],
      failedPeers: [],
      refusedPeers: [],
      supersededHeads: 0,
      checkpointCapacityExceeded: false,
      notDeliverable: null,
    });
    expect(Object.isFrozen(outcomes[0])).toBe(true);
    expect(delivery.pendingScopes).toBe(0);
  });

  it('keeps an empty peer list meaning nobody, and removes this node from a list', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, decisions } = harness({ localPeerId: 'peer-self' });

    expect(delivery.deliver({ announcement: head('1'), peers: [] }).status).toBe('nobody');
    expect(delivery.deliver({ announcement: head('1'), peers: ['peer-self'] }).status).toBe('nobody');
    expect(delivery.pendingScopes).toBe(0);

    expect(delivery.deliver({ announcement: head('2'), peers: ['peer-self', 'peer-a'] }).status)
      .toBe('queued');
    await delivery.whenIdle();
    expect(sends.map(({ peerId }) => peerId)).toEqual(['peer-a']);
    expect(decisions).toEqual(['peer-a']);
    expect(outcomes).toHaveLength(1);
  });

  it('never throws on malformed input: the head is simply not queued', async () => {
    const { delivery, sends } = harness();
    const malformed = { ...head('1'), catalogVersion: 'not-a-version' } as never;

    expect(delivery.deliver({ announcement: malformed, peers: ['peer-a'] }).status).toBe('not-queued');
    expect(delivery.deliver({ announcement: head('1'), peers: ['peer-a', 'peer-a'] }).status)
      .toBe('not-queued');
    expect(delivery.deliver(undefined as never).status).toBe('not-queued');
    await delivery.whenIdle();
    expect(sends).toEqual([]);
  });

  it('runs an owner in the context the delivery was constructed in, not the caller\'s', async () => {
    const callerContext = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const { delivery } = harness({
      isPeerAuthorized: async () => {
        seen.push(callerContext.getStore());
        return true;
      },
      send: async () => { seen.push(callerContext.getStore()); },
      runFanout: (fanout) => {
        seen.push(callerContext.getStore());
        return fanout();
      },
    });

    callerContext.run('the mutation that handed the head off', () => {
      delivery.deliver({ announcement: head('1'), peers: ['peer-a'] });
    });
    await delivery.whenIdle();

    // The host wrapper, the policy decision and the send: none of them saw the caller's context.
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  it('lets the host run each fan-out, and survives a host that fails to', async () => {
    const hosted: string[] = [];
    let failNext = true;
    const { delivery, sends, outcomes } = harness({
      runFanout: async (fanout) => {
        if (failNext) {
          failNext = false;
          throw new Error('host lane unavailable');
        }
        hosted.push('start');
        await fanout();
        hosted.push('end');
      },
    });

    delivery.deliver({ announcement: head('1'), peers: ['peer-a'] });
    await delivery.whenIdle();
    expect(sends).toEqual([]);
    expect(outcomes).toEqual([]);

    delivery.deliver({ announcement: head('2'), peers: ['peer-a'] });
    await delivery.whenIdle();
    expect(hosted).toEqual(['start', 'end']);
    expect(sends.map(({ version }) => version)).toEqual(['2']);
  });

  it('keeps delivering when the outcome observer throws', async () => {
    let calls = 0;
    const { delivery, sends } = harness({
      onDelivered: () => {
        calls += 1;
        throw new Error('observer failed');
      },
    });

    delivery.deliver({ announcement: head('1'), peers: ['peer-a'] });
    await delivery.whenIdle();
    delivery.deliver({ announcement: head('2'), peers: ['peer-a'] });
    await delivery.whenIdle();

    expect(calls).toBe(2);
    expect(sends.map(({ version }) => version)).toEqual(['1', '2']);
  });
});

describe('RFC-64 catalog head delivery: peers the local policy refuses', () => {
  it('sends nothing to a refused peer and does not count it as a failure', async () => {
    const { delivery, sends, transportCalls, outcomes, refused, decisions } = harness();
    refused.add('outsider-1');
    refused.add('outsider-2');

    delivery.deliver({
      announcement: head('3'),
      peers: ['outsider-1', 'member', 'outsider-2'],
    });
    await delivery.whenIdle();

    expect(sends.map(({ peerId }) => peerId)).toEqual(['member']);
    // Refused peers are left out before the fan-out: one decision each, and the transport is
    // never asked to send to them.
    expect(decisions).toEqual(['outsider-1', 'member', 'outsider-2']);
    expect(transportCalls).toEqual(['member']);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: ['outsider-1', 'outsider-2'],
    });
  });

  it('reports a head with no eligible peer as delivered to nobody, with no failure', async () => {
    const { delivery, sends, transportCalls, outcomes, refused, decisions } = harness();
    const everyone = peers(11);
    for (const peerId of everyone) refused.add(peerId);

    delivery.deliver({ announcement: head('3'), peers: everyone });
    await delivery.whenIdle();

    expect(sends).toEqual([]);
    expect(transportCalls).toEqual([]);
    expect(decisions).toEqual(everyone);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: [],
      failedPeers: [],
      refusedPeers: everyone,
      notDeliverable: null,
    });
  });

  it('asks the policy again for every fan-out: a refusal is not remembered', async () => {
    const { delivery, sends, outcomes, refused, decisions } = harness();
    refused.add('late-member');

    delivery.deliver({ announcement: head('1'), peers: ['late-member'] });
    await delivery.whenIdle();
    expect(sends).toEqual([]);

    refused.delete('late-member');
    delivery.deliver({ announcement: head('2'), peers: ['late-member'] });
    await delivery.whenIdle();

    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([['late-member', '2']]);
    expect(decisions).toEqual(['late-member', 'late-member']);
    expect(outcomes.map(({ refusedPeers }) => refusedPeers)).toEqual([['late-member'], []]);
  });

  it('treats a peer that stops being authorized between selection and send as refused', async () => {
    // The peer passes selection; before its send the policy changes, so the transport's own
    // recheck refuses and nothing is sent. That is a refusal, not a failed delivery.
    const { delivery, sends, transportCalls, outcomes, refused } = harness({
      isPeerAuthorized: (() => {
        let selections = 0;
        return async (peerId) => {
          if (peerId !== 'leaving-member') return true;
          selections += 1;
          if (selections > 1) return false;
          refused.add('leaving-member');
          return true;
        };
      })(),
    });

    delivery.deliver({ announcement: head('4'), peers: ['member', 'leaving-member'] });
    await delivery.whenIdle();

    // It passed selection, so the transport was asked; the transport's own recheck refused it.
    expect(transportCalls).toEqual(['member', 'leaving-member']);
    expect(sends.map(({ peerId }) => peerId)).toEqual(['member']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: ['leaving-member'],
    });
  });

  it('keeps a remote peer\'s denial and an unreachable peer as failures', async () => {
    const { delivery, outcomes, behaviour } = harness();
    behaviour.set('denying-peer', 'remote-denial');
    behaviour.set('offline-peer', 'unreachable');

    delivery.deliver({
      announcement: head('5'),
      peers: ['denying-peer', 'member', 'offline-peer'],
    });
    await delivery.whenIdle();

    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      refusedPeers: [],
      failedPeers: [
        {
          peerId: 'denying-peer',
          error: '[catalog-transport-policy-denied] remote peer denied the catalog-head announcement',
          code: 'catalog-transport-policy-denied',
        },
        { peerId: 'offline-peer', error: 'all multiaddr dials failed' },
      ],
    });
    expect(outcomes[0]!.failedPeers[1]).not.toHaveProperty('code');
  });

  it('fails closed when the policy decision throws or is anything but a plain yes', async () => {
    // What a yes takes (the policy cell, its generation) is the transport's to decide and is
    // covered there and in the service suite. Here: no answer, or an unclear one, is a refusal.
    const { delivery, sends, outcomes } = harness({
      isPeerAuthorized: async (peerId) => {
        if (peerId === 'throws') throw new Error('store unavailable');
        if (peerId === 'unclear') return { authorized: true } as never;
        return true;
      },
      send: async (peerId, announcement, options) => {
        sends.push({ peerId, version: announcement.catalogVersion, author: '', options });
      },
    });

    delivery.deliver({ announcement: head('6'), peers: ['throws', 'unclear', 'member'] });
    await delivery.whenIdle();

    expect(sends.map(({ peerId }) => peerId)).toEqual(['member']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: ['throws', 'unclear'],
    });
  });

  it('sends nothing when the head may no longer be fanned out', async () => {
    const { delivery, sends, outcomes, decisions } = harness({
      assertDeliverable: () => {
        throw new Error('RFC-64 catalog announcement is not bound to the locally accepted policy snapshot');
      },
    });

    delivery.deliver({ announcement: head('1'), peers: ['peer-a'] });
    await delivery.whenIdle();

    expect(sends).toEqual([]);
    expect(decisions).toEqual([]);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: [],
      failedPeers: [],
      refusedPeers: [],
      notDeliverable: 'RFC-64 catalog announcement is not bound to the locally accepted policy snapshot',
    });
  });
});

describe('RFC-64 catalog head delivery: one budget, bounded waves', () => {
  it('does not let a stalled peer delay its own wave, and delays later waves by one interval', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    const everyone = peers(RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1 + 4);
    behaviour.set(everyone[0]!, 'stall');

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await settle();
    // The whole first wave is in flight at once; the other fifteen peers have their head already.
    expect(sends.map(({ peerId }) => peerId))
      .toEqual(everyone.slice(0, RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1));

    await vi.advanceTimersByTimeAsync(RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1 - 1);
    expect(sends).toHaveLength(RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1);
    await vi.advanceTimersByTimeAsync(1);
    // One interval later the next wave starts although the stalled peer has not answered.
    expect(sends.map(({ peerId }) => peerId)).toEqual(everyone);
    expect(outcomes).toEqual([]);

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.announcedPeers).toEqual(everyone.slice(1));
    expect(outcomes[0]!.failedPeers).toEqual([{
      peerId: everyone[0],
      error: `RFC-64 catalog head fan-out exceeded its ${BUDGET_MS} ms budget`,
    }]);
  });

  it('starts the next wave as soon as the previous one has settled', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes } = harness();
    const everyone = peers(64);

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await settle();

    expect(sends.map(({ peerId }) => peerId)).toEqual(everyone);
    expect(outcomes[0]!.announcedPeers).toEqual(everyone);
    expect(outcomes[0]!.durationMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a fan-out at its one budget, however many peers stall', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    const everyone = peers(64);
    for (const peerId of everyone) behaviour.set(peerId, 'stall');
    const startedAt = Date.now();

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(outcomes).toEqual([]);
    // Four waves, one interval apart: every peer was attempted well inside the budget.
    expect(sends).toHaveLength(64);
    await vi.advanceTimersByTimeAsync(1);

    expect(Date.now() - startedAt).toBe(BUDGET_MS);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.durationMs).toBe(BUDGET_MS);
    expect(outcomes[0]!.announcedPeers).toEqual([]);
    expect(outcomes[0]!.failedPeers.map(({ peerId }) => peerId)).toEqual(everyone);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives every send the fan-out\'s one signal and the time that is left', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    const everyone = peers(RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1 + 1);
    behaviour.set(everyone[0]!, 'stall');

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await vi.advanceTimersByTimeAsync(RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1);

    const signals = new Set(sends.map(({ options }) => options.signal));
    expect(signals.size).toBe(1);
    expect(sends[0]!.options.timeoutMs).toBe(BUDGET_MS);
    expect(sends.at(-1)!.options.timeoutMs)
      .toBe(BUDGET_MS - RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
  });

  it('reports peers the budget ended before as failed, without sending to them', async () => {
    vi.useFakeTimers();
    const budgetMs = RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1 + 500;
    const { delivery, sends, outcomes, behaviour } = harness({ fanoutBudgetMs: budgetMs });
    const everyone = peers(40);
    for (const peerId of everyone) behaviour.set(peerId, 'stall');

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await vi.advanceTimersByTimeAsync(budgetMs);

    // Two waves started; the budget ended before the third.
    expect(sends.map(({ peerId }) => peerId))
      .toEqual(everyone.slice(0, 2 * RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1));
    expect(outcomes[0]!.failedPeers.map(({ peerId }) => peerId)).toEqual(everyone);
    expect(new Set(outcomes[0]!.failedPeers.map(({ error }) => error))).toEqual(new Set([
      `RFC-64 catalog head fan-out exceeded its ${budgetMs} ms budget`,
    ]));
  });

  it('starts the budget with the first send: a slow selection does not use it up', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness({
      // This node's own policy reads take longer than a whole fan-out budget.
      isPeerAuthorized: () => new Promise((resolve) => {
        setTimeout(() => resolve(true), BUDGET_MS + 1_000);
      }),
    });
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['peer-a', 'slow-peer'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS + 1_000);
    await settle();

    // Both peers were still attempted, each with the whole budget ahead of it.
    expect(sends.map(({ peerId, options }) => [peerId, options.timeoutMs])).toEqual([
      ['peer-a', BUDGET_MS],
      ['slow-peer', BUDGET_MS],
    ]);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['peer-a'],
      failedPeers: [{ peerId: 'slow-peer' }],
      refusedPeers: [],
      durationMs: 2 * BUDGET_MS + 1_000,
    });
  });
});
