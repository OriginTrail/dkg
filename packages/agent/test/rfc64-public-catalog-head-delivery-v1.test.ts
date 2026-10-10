/**
 * GH#3081 — delivery of catalog head announcements outside the serialized catalog mutation:
 * the hand-off returns at once, one owner per scope sends the newest head, peers the local
 * policy refuses receive nothing and are not failures, and one budget bounds a whole fan-out.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { SendOptions } from '@origintrail-official/dkg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 } from '../src/rfc64/catalog-head-lineage-v1.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from '../src/rfc64/catalog-peers-v1.js';
import {
  RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1,
  RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_V1,
  RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1,
  RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1,
  Rfc64CatalogHeadDeliveryV1,
  type Rfc64CatalogHeadDeliveryOptionsV1,
  type Rfc64CatalogHeadDeliveryOutcomeV1,
} from '../src/rfc64/public-catalog-head-delivery-v1.js';
import {
  Rfc64PublicCatalogTransportErrorV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

const BUDGET_MS = 10_000;
const AUTHOR = `0x${'a1'.repeat(20)}`;
const POLICY_DIGEST = `0x${'2e'.repeat(32)}`;

function head(
  version: string,
  authorAddress = AUTHOR,
  policyDigest = POLICY_DIGEST,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return {
    kind: 'rfc64-author-catalog-head-availability-v1',
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/head-delivery',
    subGraphName: null,
    authorAddress,
    catalogEra: '0',
    catalogVersion: version,
    policyDigest,
    catalogHeadObjectDigest: `0x${'aa'.repeat(32)}`,
    signatureVariantDigest: `0x${'bb'.repeat(32)}`,
  } as Rfc64PublicCatalogHeadAnnouncementV1;
}

function author(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

function peers(count: number, prefix = 'peer'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
}

type PeerBehaviour = 'ack' | 'stall' | 'remote-denial' | 'unreachable';

interface RecordedSend {
  readonly peerId: string;
  readonly version: string;
  readonly author: string;
  readonly options: SendOptions;
}

/**
 * A delivery over a simulated transport. `send` behaves as the head transport does: it asks the
 * policy immediately before the send and refuses with the typed denial, sending nothing.
 */
function harness(overrides: Partial<Rfc64CatalogHeadDeliveryOptionsV1> = {}) {
  const sends: RecordedSend[] = [];
  /** Every peer the transport was asked to send to, including those its own check then refused. */
  const transportCalls: string[] = [];
  const outcomes: Rfc64CatalogHeadDeliveryOutcomeV1[] = [];
  const behaviour = new Map<string, PeerBehaviour>();
  const refused = new Set<string>();
  const decisions: string[] = [];
  const inFlightByAuthor = new Map<string, number>();
  const mostInFlightByAuthor = new Map<string, number>();
  const authorize: Rfc64CatalogHeadDeliveryOptionsV1['authorize'] = async (input) => {
    decisions.push(input.remotePeerId);
    return refused.has(input.remotePeerId)
      ? null
      : { accessPolicy: 1, policyDigest: input.policyDigest };
  };
  const send: Rfc64CatalogHeadDeliveryOptionsV1['send'] = async (peerId, announcement, options) => {
    transportCalls.push(peerId);
    if (refused.has(peerId)) {
      throw new Rfc64PublicCatalogTransportErrorV1(
        'catalog-transport-policy-denied',
        'catalog operation is not access-policy authorized',
      );
    }
    sends.push({
      peerId,
      version: announcement.catalogVersion,
      author: announcement.authorAddress,
      options,
    });
    const key = announcement.authorAddress;
    const inFlight = (inFlightByAuthor.get(key) ?? 0) + 1;
    inFlightByAuthor.set(key, inFlight);
    mostInFlightByAuthor.set(key, Math.max(mostInFlightByAuthor.get(key) ?? 0, inFlight));
    try {
      switch (behaviour.get(peerId) ?? 'ack') {
        case 'ack':
          return;
        case 'remote-denial':
          throw new Rfc64PublicCatalogTransportErrorV1(
            'catalog-transport-policy-denied',
            'remote peer denied the catalog-head announcement',
          );
        case 'unreachable':
          throw new Error('all multiaddr dials failed');
        case 'stall':
          await new Promise<void>((_resolve, reject) => {
            const signal = options.signal!;
            const onAbort = (): void => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
      }
    } finally {
      inFlightByAuthor.set(key, (inFlightByAuthor.get(key) ?? 1) - 1);
    }
  };
  const delivery = new Rfc64CatalogHeadDeliveryV1({
    send,
    authorize,
    assertDeliverable: () => undefined,
    fanoutBudgetMs: BUDGET_MS,
    onDelivered: (outcome) => { outcomes.push(outcome); },
    now: () => Date.now(),
    ...overrides,
  });
  return {
    delivery, sends, transportCalls, outcomes, behaviour, refused, decisions, mostInFlightByAuthor,
  };
}

/** Run every microtask and timer that is due now, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RFC-64 catalog head delivery: hand-off', () => {
  it('returns from the hand-off before anything is sent, then delivers', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes } = harness();

    const receipt = delivery.deliver({ announcement: head('7'), peers: ['peer-a', 'peer-b'] });

    expect(receipt).toMatchObject({ status: 'queued', announcedPeers: [], failedPeers: [] });
    expect(receipt.announcement).toEqual(head('7'));
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
      authorize: async (input) => {
        seen.push(callerContext.getStore());
        return { accessPolicy: 0, policyDigest: input.policyDigest };
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
      authorize: (() => {
        let selections = 0;
        return async (input) => {
          if (input.remotePeerId !== 'leaving-member') {
            return { accessPolicy: 1 as const, policyDigest: input.policyDigest };
          }
          selections += 1;
          if (selections === 1) {
            refused.add('leaving-member');
            return { accessPolicy: 1 as const, policyDigest: input.policyDigest };
          }
          return null;
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

  it('fails closed when the policy decision itself throws or names another policy', async () => {
    const { delivery, sends, outcomes } = harness({
      authorize: async (input) => {
        if (input.remotePeerId === 'throws') throw new Error('store unavailable');
        if (input.remotePeerId === 'other-policy') {
          return { accessPolicy: 1, policyDigest: `0x${'99'.repeat(32)}` as never };
        }
        if (input.remotePeerId === 'unknown-cell') {
          return { accessPolicy: 7 as never, policyDigest: input.policyDigest };
        }
        return { accessPolicy: 0, policyDigest: input.policyDigest };
      },
      send: async (peerId, announcement, options) => {
        sends.push({ peerId, version: announcement.catalogVersion, author: '', options });
      },
    });

    delivery.deliver({
      announcement: head('6'),
      peers: ['throws', 'other-policy', 'unknown-cell', 'open-peer'],
    });
    await delivery.whenIdle();

    expect(sends.map(({ peerId }) => peerId)).toEqual(['open-peer']);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: ['open-peer'],
      failedPeers: [],
      refusedPeers: ['throws', 'other-policy', 'unknown-cell'],
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
      authorize: (input) => new Promise((resolve) => {
        setTimeout(
          () => resolve({ accessPolicy: 1, policyDigest: input.policyDigest }),
          BUDGET_MS + 1_000,
        );
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

describe('RFC-64 catalog head delivery: one owner per scope, newest head', () => {
  it('replaces a head that was not sent yet with a newer one', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour, mostInFlightByAuthor } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    expect(sends.map(({ version }) => version)).toEqual(['1']);

    // Three more changes of the scope commit while the first head is still being sent.
    expect(delivery.deliver({ announcement: head('2'), peers: ['slow-peer'] }).status).toBe('queued');
    expect(delivery.deliver({ announcement: head('3'), peers: ['slow-peer'] }).status).toBe('queued');
    expect(delivery.deliver({ announcement: head('4'), peers: ['slow-peer', 'new-peer'] }).status)
      .toBe('queued');
    await settle();
    expect(sends.map(({ version }) => version)).toEqual(['1']);
    expect(delivery.pendingScopes).toBe(1);

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    // The newest head goes out next, to the peers handed off with it; 2 and 3 are never sent.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '1'],
      ['slow-peer', '4'],
      ['new-peer', '4'],
    ]);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);

    expect(outcomes.map(({ announcement, supersededHeads }) => [
      announcement.catalogVersion,
      supersededHeads,
    ])).toEqual([['1', 0], ['4', 2]]);
    expect(mostInFlightByAuthor.get(AUTHOR)).toBe(2);
    expect(delivery.pendingScopes).toBe(0);
  });

  it('never trades the newest waiting head for an older one handed off late', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('4'), peers: ['slow-peer'] });
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS);

    expect(sends.map(({ version }) => version)).toEqual(['1', '5']);
    expect(outcomes.map(({ supersededHeads }) => supersededHeads)).toEqual([0, 1]);
  });

  it('sends the newest head to the peers of every head it replaced', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    // Two more changes commit while the first head is being sent, each naming another peer.
    delivery.deliver({ announcement: head('2'), peers: ['peer-a'] });
    delivery.deliver({ announcement: head('3'), peers: ['peer-b'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // Version 2 is never sent, but the peer it was meant for gets the head that replaced it.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '1'],
      ['peer-b', '3'],
      ['peer-a', '3'],
    ]);
    expect(outcomes[1]).toMatchObject({ announcedPeers: ['peer-b', 'peer-a'], supersededHeads: 1 });
  });

  it('gives the peers of an older head handed off late the newest head', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: ['peer-a'] });
    delivery.deliver({ announcement: head('4'), peers: ['peer-b'] });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '1'],
      ['peer-a', '5'],
      ['peer-b', '5'],
    ]);
  });

  it('keeps the peers carried over within the wire limit, the newest head\'s own peers first', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const earlier = peers(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1, 'earlier');
    const newest = peers(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 - 2, 'newest');

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: earlier });
    delivery.deliver({ announcement: head('3'), peers: newest });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    expect(sends.slice(1).map(({ peerId }) => peerId)).toEqual([...newest, ...earlier.slice(0, 2)]);
    expect(sends.slice(1).every(({ version }) => version === '3')).toBe(true);
  });

  it('keeps the heads of two policy generations of one catalog scope apart', async () => {
    // A graph authored before its registration has owner-signed heads and, after it, heads of the
    // registered generation. Both carry the same graph, author and era on the wire, and the new
    // generation starts again at version 1.
    vi.useFakeTimers();
    const registered = `0x${'3f'.repeat(32)}`;
    let accepted = POLICY_DIGEST;
    const { delivery, sends, outcomes, behaviour } = harness({
      assertDeliverable: (announcement) => {
        if (announcement.policyDigest !== accepted) {
          throw new Error('announcement is not bound to the accepted policy');
        }
      },
    });
    behaviour.set('slow-peer', 'stall');

    delivery.deliver({ announcement: head('4'), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('5'), peers: ['slow-peer'] });
    // The registration is accepted while version 4 is being sent and version 5 waits.
    accepted = registered;
    expect(delivery.deliver({
      announcement: head('1', AUTHOR, registered),
      peers: ['peer-a'],
    }).status).toBe('queued');
    await settle();

    // The new generation's first head is not compared with the old generation's versions, and it
    // does not wait behind them.
    expect(sends.map(({ peerId, version }) => [peerId, version])).toEqual([
      ['slow-peer', '4'],
      ['peer-a', '1'],
    ]);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await settle();

    // The old generation's waiting head is no longer deliverable, and says so.
    expect(sends).toHaveLength(2);
    expect(outcomes.map(({ announcement, notDeliverable }) => [
      announcement.catalogVersion,
      announcement.policyDigest === registered ? 'registered' : 'owner-signed',
      notDeliverable,
    ])).toEqual([
      ['1', 'registered', null],
      ['4', 'owner-signed', null],
      ['5', 'owner-signed', 'announcement is not bound to the accepted policy'],
    ]);
  });

  it('keeps a checkpoint so that two sent heads are never further apart than a receiver can prove', async () => {
    vi.useFakeTimers();
    const { delivery, sends, outcomes, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const step = RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1;
    expect(step * 2).toBe(RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1);
    const last = 2 * step + 3;

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer', 'peer-a'] });
    await settle();
    // More than a whole lineage window of versions commits while version 1 is being sent.
    for (let version = 2; version <= last; version += 1) {
      delivery.deliver({ announcement: head(String(version)), peers: ['slow-peer', 'peer-a'] });
    }
    expect(delivery.pendingScopes).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * BUDGET_MS);
    await settle();

    const sentToPeerA = sends.filter(({ peerId }) => peerId === 'peer-a')
      .map(({ version }) => Number(version));
    expect(sentToPeerA).toEqual([1, 1 + step, 1 + 2 * step, last]);
    for (let index = 1; index < sentToPeerA.length; index += 1) {
      expect(sentToPeerA[index]! - sentToPeerA[index - 1]!).toBeLessThanOrEqual(step);
    }
    // Every other waiting head was replaced, and each is counted once.
    expect(outcomes.reduce((sum, { supersededHeads }) => sum + supersededHeads, 0))
      .toBe(last - sentToPeerA.length);
  });

  it('bounds the checkpoints of one scope: past them the newest head still replaces the waiting one', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const step = RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1;
    const waitingHeads = RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_V1;
    const last = (waitingHeads + 2) * step;

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    await settle();
    for (let version = 2; version <= last; version += 1) {
      delivery.deliver({ announcement: head(String(version)), peers: ['slow-peer'] });
    }
    await vi.advanceTimersByTimeAsync((waitingHeads + 1) * BUDGET_MS);
    await settle();

    expect(sends.map(({ version }) => Number(version))).toEqual([
      1,
      ...Array.from({ length: waitingHeads - 1 }, (_, index) => 1 + (index + 1) * step),
      last,
    ]);
  });

  it('never runs two fan-outs of one scope at once, and runs different scopes side by side', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour, mostInFlightByAuthor } = harness();
    behaviour.set('slow-peer', 'stall');
    const other = author(1);

    delivery.deliver({ announcement: head('1'), peers: ['slow-peer'] });
    delivery.deliver({ announcement: head('1', other), peers: ['slow-peer'] });
    await settle();
    delivery.deliver({ announcement: head('2'), peers: ['slow-peer'] });
    await settle();

    // Both scopes are sending their first head; the second head of the first scope waits.
    expect(sends.map(({ author: sender, version }) => [sender, version])).toEqual([
      [AUTHOR, '1'],
      [other, '1'],
    ]);
    expect(delivery.pendingScopes).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS);

    expect(sends.map(({ author: sender, version }) => [sender, version])).toEqual([
      [AUTHOR, '1'],
      [other, '1'],
      [AUTHOR, '2'],
    ]);
    expect(mostInFlightByAuthor.get(AUTHOR)).toBe(1);
    expect(mostInFlightByAuthor.get(other)).toBe(1);
  });

  it('bounds the fan-outs that select peers at once; a scope waiting for its turn sends its newest head', async () => {
    vi.useFakeTimers();
    const selecting: string[] = [];
    const finishSelection: Array<() => void> = [];
    const { delivery, sends } = harness({
      authorize: (input) => new Promise((resolve) => {
        selecting.push(input.remotePeerId);
        finishSelection.push(() => resolve({ accessPolicy: 1, policyDigest: input.policyDigest }));
      }),
    });
    const scopes = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 2;
    const peerOf = (index: number): string => `peer-of-scope-${index}`;

    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('5000', author(index)), peers: [peerOf(index)] });
    }
    await settle();
    expect(selecting).toEqual(
      Array.from({ length: RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 }, (_, index) => peerOf(index)),
    );
    // The last scope has not had its turn: a newer head replaces the one it is waiting with,
    // also when its owner's first head is far from version 1.
    delivery.deliver({ announcement: head('5001', author(scopes - 1)), peers: [peerOf(scopes - 1)] });

    // One fan-out finishes selecting and starts its send: exactly one more scope gets a turn.
    finishSelection[0]!();
    await settle();
    expect(sends.map(({ peerId }) => peerId)).toEqual([peerOf(0)]);
    expect(selecting).toHaveLength(RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 1);

    while (delivery.pendingScopes > 0) {
      for (const finish of finishSelection.splice(0)) finish();
      await settle();
    }
    expect(sends).toHaveLength(scopes);
    expect(sends.find(({ author: sender }) => sender === author(scopes - 1))!.version).toBe('5001');
  });

  it('gives its turn back once the sends have started: a peer that never answers holds no other scope', async () => {
    vi.useFakeTimers();
    const { delivery, sends, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');
    const scopes = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 3;

    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('1', author(index)), peers: ['slow-peer', `peer-${index}`] });
    }
    await settle();

    // Every scope has started its sends, and every healthy peer has its head, although the
    // stalled peer keeps each of the fan-outs open until its budget ends.
    expect(sends).toHaveLength(2 * scopes);
    expect(delivery.pendingScopes).toBe(scopes);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(delivery.pendingScopes).toBe(0);
  });

  it('bounds the scopes that hold a waiting head', async () => {
    vi.useFakeTimers();
    const { delivery, behaviour } = harness();
    behaviour.set('slow-peer', 'stall');

    for (let index = 0; index < RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1; index += 1) {
      expect(delivery.deliver({ announcement: head('1', author(index)), peers: ['slow-peer'] }).status)
        .toBe('queued');
    }
    expect(delivery.pendingScopes).toBe(RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1);

    const overflow = author(RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1);
    expect(delivery.deliver({ announcement: head('1', overflow), peers: ['slow-peer'] }).status)
      .toBe('not-queued');
    // A scope that already has its slot still takes a newer head.
    expect(delivery.deliver({ announcement: head('2', author(0)), peers: ['slow-peer'] }).status)
      .toBe('queued');
    expect(delivery.pendingScopes).toBe(RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1);
    await delivery.close();
    expect(delivery.pendingScopes).toBe(0);
  });
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
    expect(delivery.deliver({ announcement: head('3'), peers: ['quick-peer'] }).status)
      .toBe('not-queued');

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

  it('releases scopes that were waiting for their turn, and sends nothing for a selection that ends after close', async () => {
    vi.useFakeTimers();
    const finishSelection: Array<() => void> = [];
    const { delivery, sends, outcomes } = harness({
      authorize: (input) => new Promise((resolve) => {
        finishSelection.push(() => resolve({ accessPolicy: 1, policyDigest: input.policyDigest }));
      }),
    });
    const scopes = RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 + 3;
    for (let index = 0; index < scopes; index += 1) {
      delivery.deliver({ announcement: head('1', author(index)), peers: ['peer-a', 'peer-b'] });
    }
    await settle();
    // Four fan-outs are selecting their peers; three scopes wait for a turn.
    expect(finishSelection).toHaveLength(RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 * 2);

    let closed = false;
    const closing = delivery.close().then(() => { closed = true; });
    await settle();
    // A policy decision that is being read cannot be cut short: close waits for it.
    expect(closed).toBe(false);
    for (const finish of finishSelection.splice(0)) finish();
    await closing;

    expect(sends).toEqual([]);
    expect(finishSelection).toEqual([]);
    expect(delivery.pendingScopes).toBe(0);
    expect(outcomes).toHaveLength(RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1);
    expect(new Set(outcomes.map(({ notDeliverable }) => notDeliverable)))
      .toEqual(new Set(['RFC-64 catalog head delivery closed']));
    expect(outcomes.every(({ failedPeers, refusedPeers }) => (
      failedPeers.length === 0 && refusedPeers.length === 0
    ))).toBe(true);
  });

  it('stops asking the policy once it is closing', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const finishSelection: Array<() => void> = [];
    const { delivery, sends, outcomes } = harness({
      authorize: (input) => new Promise((resolve) => {
        asked.push(input.remotePeerId);
        finishSelection.push(() => resolve({ accessPolicy: 1, policyDigest: input.policyDigest }));
      }),
    });
    const everyone = peers(7);

    delivery.deliver({ announcement: head('1'), peers: everyone });
    await settle();
    // Four decisions are being read; three peers have not been asked about yet.
    expect(asked).toEqual(everyone.slice(0, 4));

    const closing = delivery.close();
    for (const finish of finishSelection.splice(0)) finish();
    await closing;

    expect(asked).toEqual(everyone.slice(0, 4));
    expect(sends).toEqual([]);
    expect(outcomes[0]).toMatchObject({
      announcedPeers: [],
      failedPeers: [],
      refusedPeers: [],
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
