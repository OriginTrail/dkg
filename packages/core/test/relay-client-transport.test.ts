import { describe, expect, it } from 'vitest';
import {
  RelayReservationNotAllowedError,
  buildRelayClientTransport,
  relayClientTransportInit,
  restrictRelayReservations,
} from '../src/relay-client-transport.js';
import { buildActiveRelayNetworkPolicy } from '../src/relay-network-policy.js';

const LISTED = '12D3KooWListedRelayAAAAAAAA';
const OUTSIDE = '12D3KooWOutsideRelayBBBBBBBB';

function peer(id: string) {
  return { toString: () => id };
}

/** The part of libp2p's client reservation store the guard touches. */
class FakeReservationStore {
  readonly requested: Array<{ peerId: string; type: unknown }> = [];
  /** Arguments of the last request after the first two. */
  lastExtraArguments: unknown[] = [];

  async addRelay(peerId: { toString(): string }, type?: unknown, ...extra: unknown[]): Promise<unknown> {
    this.requested.push({ peerId: peerId.toString(), type });
    this.lastExtraArguments = extra;
    return { relay: peerId };
  }

  /** libp2p renews through `this.addRelay`, not through the transport. */
  async renew(peerId: { toString(): string }): Promise<unknown> {
    return this.addRelay(peerId, 'discovered');
  }
}

const allowListed = (peerId: string): boolean => peerId === LISTED;

describe('relayClientTransportInit', () => {
  const policy = buildActiveRelayNetworkPolicy(new Set([LISTED]))!;

  it('passes no init on a node with neither a relay server nor usable relays', () => {
    expect(relayClientTransportInit({ relayCaps: null })).toBeUndefined();
    expect(relayClientTransportInit({ relayCaps: null, networkPolicy: policy })).toBeUndefined();
  });

  it('raises the stop-stream caps on a relay server and keeps the allowlist filter', () => {
    expect(relayClientTransportInit({
      relayCaps: { maxInboundStopStreams: 2048, maxOutboundStopStreams: 2048 },
      networkPolicy: policy,
    })).toEqual({
      maxInboundStopStreams: 2048,
      maxOutboundStopStreams: 2048,
      discoveryFilter: policy.discoveryFilter,
    });
    expect(relayClientTransportInit({
      relayCaps: { maxInboundStopStreams: 512, maxOutboundStopStreams: 512 },
    })).toEqual({ maxInboundStopStreams: 512, maxOutboundStopStreams: 512 });
  });

  it('requests an edge\'s reservations in parallel', () => {
    expect(relayClientTransportInit({ relayCaps: null, reservationConcurrency: 3 }))
      .toEqual({ reservationConcurrency: 3 });
    expect(relayClientTransportInit({
      relayCaps: null,
      reservationConcurrency: 3,
      networkPolicy: policy,
    })).toEqual({ reservationConcurrency: 3, discoveryFilter: policy.discoveryFilter });
  });
});

describe('restrictRelayReservations', () => {
  it('passes a request for a listed relay through unchanged', async () => {
    const store = new FakeReservationStore();
    expect(restrictRelayReservations({ reservationStore: store }, { allowsRelay: allowListed })).toBe(true);

    const listed = peer(LISTED);
    await expect(store.addRelay(listed, 'discovered')).resolves.toEqual({ relay: listed });
    expect(store.requested).toEqual([{ peerId: LISTED, type: 'discovered' }]);
  });

  it('passes on arguments it does not know', async () => {
    const store = new FakeReservationStore();
    restrictRelayReservations({ reservationStore: store }, { allowsRelay: allowListed });

    const options = { signal: undefined };
    await store.addRelay(peer(LISTED), 'configured', options);
    expect(store.requested).toEqual([{ peerId: LISTED, type: 'configured' }]);
    expect(store.lastExtraArguments).toEqual([options]);
  });

  it('refuses a request for a relay outside the list without asking it', async () => {
    const store = new FakeReservationStore();
    restrictRelayReservations({ reservationStore: store }, { allowsRelay: allowListed });

    const refusal = store.addRelay(peer(OUTSIDE), 'discovered');
    await expect(refusal).rejects.toBeInstanceOf(RelayReservationNotAllowedError);
    await expect(refusal).rejects.toMatchObject({ name: 'RelayReservationNotAllowedError' });
    // A request made for one specific relay (libp2p's "configured" kind, used
    // when a stop request arrives through a relay without a reservation) is
    // held to the same list.
    await expect(store.addRelay(peer(OUTSIDE), 'configured')).rejects.toThrow(OUTSIDE);
    expect(store.requested).toEqual([]);
  });

  it('covers the store\'s own calls, such as a renewal', async () => {
    const store = new FakeReservationStore();
    restrictRelayReservations({ reservationStore: store }, { allowsRelay: allowListed });

    await expect(store.renew(peer(OUTSIDE))).rejects.toBeInstanceOf(RelayReservationNotAllowedError);
    await store.renew(peer(LISTED));
    expect(store.requested).toEqual([{ peerId: LISTED, type: 'discovered' }]);
  });

  it('logs a refused relay once per interval, however often libp2p offers it', async () => {
    const store = new FakeReservationStore();
    const logs: string[] = [];
    let now = 1_000;
    restrictRelayReservations({ reservationStore: store }, {
      allowsRelay: allowListed,
      log: (message) => logs.push(message),
      now: () => now,
    });

    for (let offer = 0; offer < 3; offer++) {
      await store.addRelay(peer(OUTSIDE), 'discovered').catch(() => {});
    }
    expect(logs).toEqual([
      `Relay reservation skipped: peer=${OUTSIDE.slice(-8)} offers a relay but is not in this node's relay set`,
    ]);

    now += 10 * 60_000;
    await store.addRelay(peer(OUTSIDE), 'discovered').catch(() => {});
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('suppressedSinceLast=2');
  });

  it('warns and leaves the transport alone when it has no reservation store to guard', () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    for (const transport of [undefined, null, 'transport', {}, { reservationStore: null }, { reservationStore: {} }]) {
      expect(restrictRelayReservations(transport, { allowsRelay: allowListed, warn })).toBe(false);
    }
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('not restricted to the configured relays');
    // No sink configured: still no throw.
    expect(restrictRelayReservations({}, { allowsRelay: allowListed })).toBe(false);
  });
});

describe('buildRelayClientTransport', () => {
  function fakeLibp2pTransport() {
    const inits: unknown[] = [];
    const stores: FakeReservationStore[] = [];
    const createTransport = ((init?: unknown) => {
      inits.push(init);
      return () => {
        const store = new FakeReservationStore();
        stores.push(store);
        return { reservationStore: store };
      };
    }) as unknown as NonNullable<Parameters<typeof buildRelayClientTransport>[0]['createTransport']>;
    return { inits, stores, createTransport };
  }

  it('guards the transport of a node that has a relay allowlist', async () => {
    const fake = fakeLibp2pTransport();
    const policy = buildActiveRelayNetworkPolicy(new Set([LISTED]))!;
    const factory = buildRelayClientTransport({
      relayCaps: null,
      reservationConcurrency: 3,
      networkPolicy: policy,
      createTransport: fake.createTransport,
    });

    expect(fake.inits).toEqual([{ reservationConcurrency: 3, discoveryFilter: policy.discoveryFilter }]);
    factory({} as never);
    const [store] = fake.stores;
    await expect(store!.addRelay(peer(OUTSIDE), 'discovered'))
      .rejects.toBeInstanceOf(RelayReservationNotAllowedError);
    await store!.addRelay(peer(LISTED), 'discovered');
    expect(store!.requested).toEqual([{ peerId: LISTED, type: 'discovered' }]);
  });

  it('leaves the transport of a node without a network identity as libp2p built it', async () => {
    const fake = fakeLibp2pTransport();
    const factory = buildRelayClientTransport({
      relayCaps: null,
      reservationConcurrency: 2,
      createTransport: fake.createTransport,
    });

    factory({} as never);
    const [store] = fake.stores;
    await store!.addRelay(peer(OUTSIDE), 'discovered');
    expect(store!.requested).toEqual([{ peerId: OUTSIDE, type: 'discovered' }]);
  });

  it('installs no guard, and logs nothing, on a node that lists no relay', async () => {
    // Such a node asks for no reservation. libp2p still offers it every
    // relay-capable peer it identifies and drops the offer itself.
    const fake = fakeLibp2pTransport();
    const logs: string[] = [];
    const factory = buildRelayClientTransport({
      relayCaps: { maxInboundStopStreams: 2048, maxOutboundStopStreams: 2048 },
      networkPolicy: buildActiveRelayNetworkPolicy(new Set())!,
      log: (message) => logs.push(message),
      createTransport: fake.createTransport,
    });

    factory({} as never);
    const [store] = fake.stores;
    await store!.addRelay(peer(OUTSIDE), 'discovered');
    expect(store!.requested).toEqual([{ peerId: OUTSIDE, type: 'discovered' }]);
    expect(logs).toEqual([]);
  });
});
