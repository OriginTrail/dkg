/**
 * GH#3081 — delivery of catalog head announcements outside the serialized catalog mutation:
 * the hand-off returns at once, peers the local policy refuses receive nothing and are not
 * failures, and one budget bounds a whole fan-out. The scope owner's rules and the lifecycle
 * have their own suites beside this one.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { noteRfc64CatalogPolicyUndecidedV1 } from '../src/rfc64/catalog-policy-decision-probe-v1.js';
import { RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 } from '../src/rfc64/public-catalog-head-delivery-v1.js';
import {
  RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1,
  RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1,
  RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1,
  RFC64_CATALOG_HEAD_MAX_DECISIONS_IN_FLIGHT_V1,
  RFC64_CATALOG_HEAD_SELECTION_CONCURRENCY_V1,
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
      uncheckedPeers: [],
      unconfirmedPeers: [],
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

    const invalid = { status: 'not-queued', reason: 'invalid' };
    expect(delivery.deliver({ announcement: malformed, peers: ['peer-a'] })).toEqual(invalid);
    expect(delivery.deliver({ announcement: head('1'), peers: ['peer-a', 'peer-a'] })).toEqual(invalid);
    expect(delivery.deliver({ announcement: head('1'), peers: peers(65) })).toEqual(invalid);
    expect(delivery.deliver(undefined as never)).toEqual(invalid);
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

  it('lets the host run each fan-out, and reports a head the host could not run a fan-out for', async () => {
    const hosted: string[] = [];
    let failNext = true;
    let failAfterwards = false;
    const { delivery, sends, outcomes } = harness({
      runFanout: async (fanout) => {
        if (failNext) {
          failNext = false;
          throw new Error('host lane unavailable');
        }
        hosted.push('start');
        await fanout();
        hosted.push('end');
        if (failAfterwards) throw new Error('host lane closed late');
      },
    });

    delivery.deliver({ announcement: head('1'), peers: ['peer-a'] });
    await delivery.whenIdle();
    expect(sends).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      announcement: { catalogVersion: '1' },
      announcedPeers: [],
      failedPeers: [],
      notDeliverable: 'the fan-out could not be run: host lane unavailable',
    });

    // The owner carries on with the next head, and a fan-out that ran is reported once.
    delivery.deliver({ announcement: head('2'), peers: ['peer-a'] });
    await delivery.whenIdle();
    expect(hosted).toEqual(['start', 'end']);
    expect(sends.map(({ version }) => version)).toEqual(['2']);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1]!.notDeliverable).toBeNull();

    // A host that fails after the fan-out has run does not add a second report for it.
    failAfterwards = true;
    delivery.deliver({ announcement: head('3'), peers: ['peer-a'] });
    await delivery.whenIdle();
    expect(outcomes).toHaveLength(3);
    expect(outcomes[2]).toMatchObject({ announcedPeers: ['peer-a'], notDeliverable: null });
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

  it('tells a denied send apart without asking the policy again', async () => {
    const { delivery, outcomes, behaviour, decisions } = harness();
    const denying = peers(8, 'denying');
    for (const peerId of denying) behaviour.set(peerId, 'remote-denial');

    delivery.deliver({ announcement: head('1'), peers: ['member', ...denying] });
    await delivery.whenIdle();

    // One question per peer, at selection. Where a send was denied says the rest: the transport
    // let these out, so the denial is the remote peer's.
    expect(decisions).toEqual(['member', ...denying]);
    expect(outcomes[0]!.announcedPeers).toEqual(['member']);
    expect(outcomes[0]!.failedPeers.map(({ peerId }) => peerId)).toEqual(denying);
    expect(outcomes[0]!.refusedPeers).toEqual([]);
  });

  it('reports a peer it sent the head to whose authorization ended while the send was under way', async () => {
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('leaving-member', 'lapse');

    delivery.deliver({ announcement: head('4'), peers: ['member', 'leaving-member'] });
    await delivery.whenIdle();

    // The head went out to both. For one of them this node's check after the send said no:
    // that is neither a refusal (something was sent) nor a delivery it can vouch for.
    expect(sends.map(({ peerId }) => peerId)).toEqual(['member', 'leaving-member']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: [],
      uncheckedPeers: [],
      unconfirmedPeers: ['leaving-member'],
    });
  });
});

describe('RFC-64 catalog head delivery: peers the local policy could not be asked about', () => {
  it('keeps a peer it could not check apart from a refused one, and looks a second time', async () => {
    const { delivery, sends, transportCalls, outcomes, refused, undecidable, decisions } = harness();
    refused.add('outsider');
    undecidable.add('unknown-1');
    undecidable.add('unknown-2');

    delivery.deliver({
      announcement: head('3'),
      peers: ['unknown-1', 'outsider', 'member', 'unknown-2'],
    });
    await delivery.whenIdle();

    // Nothing is sent without a yes. A refusal is final for this fan-out; a decision that could
    // not be made is asked for once more before the fan-out gives up on the peer.
    expect(sends.map(({ peerId }) => peerId)).toEqual(['member']);
    expect(transportCalls).toEqual(['member']);
    expect(decisions).toEqual([
      'unknown-1', 'outsider', 'member', 'unknown-2',
      'unknown-1', 'unknown-2',
    ]);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: ['outsider'],
      uncheckedPeers: ['unknown-1', 'unknown-2'],
      notDeliverable: null,
    });
  });

  it('sends to a peer whose decision could be made at the second look', async () => {
    const { delivery, sends, outcomes } = harness({
      isPeerAuthorized: (() => {
        let looks = 0;
        return async (peerId) => {
          if (peerId !== 'slow-to-resolve') return true;
          looks += 1;
          if (looks > 1) return true;
          // The first look fails the way a lookup that times out does.
          noteRfc64CatalogPolicyUndecidedV1();
          return false;
        };
      })(),
    });

    delivery.deliver({ announcement: head('3'), peers: ['member', 'slow-to-resolve'] });
    await delivery.whenIdle();

    expect(sends.map(({ peerId }) => peerId)).toEqual(['member', 'slow-to-resolve']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member', 'slow-to-resolve'],
      refusedPeers: [],
      uncheckedPeers: [],
    });
  });

  it('treats a decision that fails as no answer, and anything but a plain yes as a no', async () => {
    // What a yes takes (the policy cell, its generation) is the transport's to decide and is
    // covered there and in the service suite.
    const { delivery, sends, outcomes } = harness({
      isPeerAuthorized: async (peerId) => {
        if (peerId === 'throws') throw new Error('store unavailable');
        if (peerId === 'unclear') return { authorized: true } as never;
        return true;
      },
      send: async (peerId, announcement, options) => {
        sends.push({ peerId, version: announcement.catalogVersion, author: '', options, at: 0 });
      },
    });

    delivery.deliver({ announcement: head('6'), peers: ['throws', 'unclear', 'member'] });
    await delivery.whenIdle();

    expect(sends.map(({ peerId }) => peerId)).toEqual(['member']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: ['unclear'],
      uncheckedPeers: ['throws'],
    });
  });

  it('counts a peer as unchecked when the check before its send could not be made', async () => {
    // The peer passes selection; before its send the lookup fails, so the transport's own check
    // has no answer and nothing is sent.
    const { delivery, sends, transportCalls, outcomes, undecidable } = harness({
      isPeerAuthorized: async (peerId) => {
        if (peerId === 'flaky-lookup') undecidable.add(peerId);
        return true;
      },
    });

    delivery.deliver({ announcement: head('4'), peers: ['member', 'flaky-lookup'] });
    await delivery.whenIdle();

    expect(transportCalls).toEqual(['member', 'flaky-lookup']);
    expect(sends.map(({ peerId }) => peerId)).toEqual(['member']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [],
      refusedPeers: [],
      uncheckedPeers: ['flaky-lookup'],
    });
  });

  it('stops selecting at its deadline: unanswered peers are unchecked and the rest are sent to', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes } = harness({
      selectionBudgetMs: 2_000,
      // One lookup never answers; the others take half a second.
      isPeerAuthorized: (peerId) => (peerId === 'hung-lookup'
        ? new Promise(() => undefined)
        : new Promise((resolve) => { setTimeout(() => resolve(true), 500); })),
    });
    const others = peers(6);

    delivery.deliver({ announcement: head('1'), peers: ['hung-lookup', ...others] });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    // Three lanes answered six peers in a second; the deadline then ended the wait for the
    // fourth, and the fan-out went ahead without it.
    expect(sends.map(({ peerId }) => peerId)).toEqual(others);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: others,
      refusedPeers: [],
      uncheckedPeers: ['hung-lookup'],
      durationMs: 2_000,
    });
    expect(delivery.pendingScopes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives its turn back at the selection deadline: lookups that never answer hold no other scope for longer', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const { delivery, outcomes } = harness({
      selectionBudgetMs: 1_000,
      isPeerAuthorized: (peerId) => {
        asked.push(peerId);
        return new Promise(() => undefined);
      },
    });
    const turns = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1;
    const lanes = RFC64_CATALOG_HEAD_SELECTION_CONCURRENCY_V1;
    const scopes = turns + 2;
    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('1', author(index)), peers: peers(lanes, `s${index}`) });
    }
    await settle();
    expect(asked).toHaveLength(turns * lanes);
    expect(asked).toHaveLength(RFC64_CATALOG_HEAD_MAX_DECISIONS_IN_FLIGHT_V1);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    // The first four fan-outs gave up on their lookups and reported them; the two scopes behind
    // them got their turns. Their peers are not asked about while the hung lookups fill every
    // place for a decision in flight, so they are unchecked at once.
    expect(asked).toHaveLength(RFC64_CATALOG_HEAD_MAX_DECISIONS_IN_FLIGHT_V1);
    expect(outcomes).toHaveLength(scopes);
    expect(outcomes.every(({ uncheckedPeers, announcedPeers, refusedPeers }) => (
      uncheckedPeers.length === lanes && announcedPeers.length === 0 && refusedPeers.length === 0
    ))).toBe(true);
    expect(delivery.pendingScopes).toBe(0);
    await expect(delivery.close()).resolves.toBeUndefined();
  });
});

describe('RFC-64 catalog head delivery: what cannot be fanned out', () => {
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

  it('ends a fan-out a moment after its budget although the policy check of a send never answers', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, hungChecks } = harness();
    hungChecks.add('hung-check');

    delivery.deliver({ announcement: head('1'), peers: ['member', 'hung-check'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: ['member'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS + RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1 - 1);
    expect(outcomes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    // The budget ends the wait for a send, not only its time on the wire: a send gets a moment
    // to unwind and is then left behind. Nothing went out to the peer whose check never
    // answered, and it is a peer that did not get the head.
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['member'],
      failedPeers: [{
        peerId: 'hung-check',
        error: `RFC-64 catalog head fan-out exceeded its ${BUDGET_MS} ms budget`,
      }],
      refusedPeers: [],
    });
    // The scope's next head was not held by it.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['member', '1'],
      ['member', '2'],
    ]);
    expect(delivery.pendingScopes).toBe(0);
  });

  it('starts no send while too many sends of earlier fan-outs have not ended', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, hungChecks } = harness({ maxAbandonedSends: 2 });
    hungChecks.add('hung-a');
    hungChecks.add('hung-b');

    delivery.deliver({ announcement: head('1'), peers: ['hung-a', 'hung-b'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS + RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1);
    await settle();
    // Two sends outlived their fan-out, each on a policy read that cannot be cut short.
    delivery.deliver({ announcement: head('2'), peers: ['member'] });
    await settle();

    expect(sends).toEqual([]);
    expect(outcomes[1]!.announcedPeers).toEqual([]);
    expect(outcomes[1]!.failedPeers).toEqual([{
      peerId: 'member',
      error: 'RFC-64 catalog head sends of earlier fan-outs have not ended: no new send is started',
    }]);
  });

  it('takes the times stated for 4, 11 and 64 peers that acknowledge, are refused, stall, or a third each', async () => {
    vi.useFakeTimers();
    // An acknowledging peer answers after 25 ms; a stalled peer never answers.
    const fanout = async (count: number, kindOf: (index: number) => 'ack' | 'refused' | 'stall') => {
      const { delivery, sends, outcomes, behaviour, refused } = harness({ ackDelayMs: 25 });
      const everyone = peers(count);
      everyone.forEach((peerId, index) => {
        if (kindOf(index) === 'refused') refused.add(peerId);
        if (kindOf(index) === 'stall') behaviour.set(peerId, 'stall');
      });
      const startedAt = Date.now();
      delivery.deliver({ announcement: head('1'), peers: everyone });
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await settle();
      const acknowledged = sends.filter(({ peerId }) => !behaviour.has(peerId));
      return {
        fanoutMs: outcomes[0]!.durationMs,
        // When the last acknowledging peer had the head.
        servedMs: acknowledged.length === 0
          ? null
          : Math.max(...acknowledged.map(({ at }) => at)) - startedAt + 25,
        sent: sends.length,
        failed: outcomes[0]!.failedPeers.length,
      };
    };
    const mixed = (index: number) => (['ack', 'refused', 'stall'] as const)[index % 3]!;

    for (const [count, acknowledging, aThirdEach] of [
      [4, { fanoutMs: 25, servedMs: 25 }, { fanoutMs: BUDGET_MS, servedMs: 25 }],
      [11, { fanoutMs: 25, servedMs: 25 }, { fanoutMs: BUDGET_MS, servedMs: 25 }],
      // Four waves of acknowledging peers; with a stalled peer in every wave, three waves a second apart.
      [64, { fanoutMs: 100, servedMs: 100 }, { fanoutMs: BUDGET_MS, servedMs: 2_025 }],
    ] as const) {
      expect(await fanout(count, () => 'ack')).toMatchObject({ ...acknowledging, failed: 0 });
      expect(await fanout(count, () => 'refused')).toEqual({ fanoutMs: 0, servedMs: null, sent: 0, failed: 0 });
      expect(await fanout(count, () => 'stall')).toMatchObject({ fanoutMs: BUDGET_MS, failed: count });
      expect(await fanout(count, mixed)).toMatchObject(aThirdEach);
    }
  });

  it('starts the budget with the first send: a slow selection does not use it up', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness({
      // This node's own policy reads take most of the time selection has.
      isPeerAuthorized: () => new Promise((resolve) => {
        setTimeout(() => resolve(true), BUDGET_MS - 1_000);
      }),
    });
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['peer-a', 'slow-peer'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1_000);
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
      durationMs: 2 * BUDGET_MS - 1_000,
    });
  });
});
