import { afterEach, describe, expect, it, vi } from 'vitest';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import {
  createReservationSignal,
  isFaultyRetimeableSignalVersion,
  readDependencyVersion,
  readRetimeableSignalVersion,
  repairRelayReservationTimers,
} from '../src/relay-reservation-timers.js';

type Reservation = { expiry: Date; signal: AbortSignal };
type ReservationStore = {
  reservations: { get(peer: unknown): Reservation | undefined; size: number };
  reserve(peer: unknown, addr: unknown): { status: number; expire?: number };
  removeReservation(peer: unknown): void;
  clear(): void;
};
type RelayService = { reservationStore: ReservationStore };

const quiet = { log: () => {}, warn: () => {} };
const addr = multiaddr('/ip4/127.0.0.1/tcp/4001');
const silentLogger = { forComponent: () => Object.assign(() => {}, { error: () => {}, trace: () => {}, enabled: false }) };

/** The real circuit-relay-v2 server service, without a libp2p node around it. */
function relayServer(reservationTtl: number): RelayService {
  const create = circuitRelayServer({ reservations: { reservationTtl, maxReservations: 8 } });
  return create({ logger: silentLogger } as never) as unknown as RelayService;
}

async function newPeer() {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
}

function sleepUntil(at: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())));
}

const nodes: DKGNode[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
});

describe('relay reservation timers on the installed circuit-relay-v2 (time-scaled)', () => {
  // One TTL is 1 s here; production is 2 h refreshed 5 min early, where the
  // unrepaired relay deletes the reservation 235 minutes after creating it.
  const ttl = 1_000;

  it('keeps a twice-refreshed reservation until one TTL after its last refresh', async () => {
    const repaired = relayServer(ttl);
    const unrepaired = relayServer(ttl);
    expect(repairRelayReservationTimers(repaired, quiet)).toBe('repaired');
    const peer = await newPeer();
    const both = (act: (store: ReservationStore) => void) => [repaired, unrepaired].forEach((relay) => act(relay.reservationStore));

    const created = Date.now();
    both((store) => store.reserve(peer, addr));
    await sleepUntil(created + 150);
    const firstRefresh = Date.now();
    both((store) => store.reserve(peer, addr));
    await sleepUntil(created + 700);
    const secondRefresh = Date.now();
    both((store) => store.reserve(peer, addr));

    // One TTL after the first refresh: the timer that refresh armed fires.
    await sleepUntil(firstRefresh + ttl + 250);
    expect(Date.now()).toBeLessThan(secondRefresh + ttl);
    expect(repaired.reservationStore.reservations.get(peer)).toBeDefined();
    expect(
      unrepaired.reservationStore.reservations.get(peer),
      'circuit-relay-v2 no longer drops a refreshed reservation early: relay-reservation-timers.ts can go',
    ).toBeUndefined();

    await sleepUntil(secondRefresh + ttl + 250);
    expect(repaired.reservationStore.reservations.get(peer)).toBeUndefined();
  });

  it("does not let a removed reservation's timer delete the peer's next reservation", async () => {
    const repaired = relayServer(ttl);
    const unrepaired = relayServer(ttl);
    expect(repairRelayReservationTimers(repaired, quiet)).toBe('repaired');
    const peer = await newPeer();
    const both = (act: (store: ReservationStore) => void) => [repaired, unrepaired].forEach((relay) => act(relay.reservationStore));

    const created = Date.now();
    both((store) => store.reserve(peer, addr));
    await sleepUntil(created + 100);
    // The path the relay takes when it cannot deliver a reservation reply.
    both((store) => store.removeReservation(peer));
    await sleepUntil(created + 500);
    const recreated = Date.now();
    both((store) => store.reserve(peer, addr));

    // One TTL after the first reservation: its timer fires.
    await sleepUntil(created + ttl + 200);
    expect(Date.now()).toBeLessThan(recreated + ttl);
    expect(repaired.reservationStore.reservations.get(peer)).toBeDefined();
    expect(unrepaired.reservationStore.reservations.get(peer)).toBeUndefined();

    await sleepUntil(recreated + ttl + 250);
    expect(repaired.reservationStore.reservations.get(peer)).toBeUndefined();
  });
});

describe('relay reservation timer repair', () => {
  const hour = 60 * 60_000;

  it('records the refreshed expiry and expires the reservation one TTL after the refresh', async () => {
    const relay = relayServer(2 * hour);
    repairRelayReservationTimers(relay, quiet);
    const peer = await newPeer();
    vi.useFakeTimers();
    // Whole seconds, so the reply's expiry (seconds) equals the stored one.
    vi.setSystemTime(Date.UTC(2026, 9, 23));
    const store = relay.reservationStore;

    const created = store.reserve(peer, addr);
    expect(store.reservations.get(peer)?.expiry.getTime()).toBe(created.expire! * 1000);
    vi.advanceTimersByTime(115 * 60_000);
    const refreshed = store.reserve(peer, addr);
    expect(refreshed.expire).toBeGreaterThan(created.expire!);
    expect(store.reservations.get(peer)?.expiry.getTime()).toBe(refreshed.expire! * 1000);

    vi.advanceTimersByTime(2 * hour - 1_000);
    expect(store.reservations.get(peer)).toBeDefined();
    const signal = store.reservations.get(peer)!.signal;
    vi.advanceTimersByTime(1_000);
    expect(store.reservations.get(peer)).toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe('Relay reservation expired');
  });

  it('adopts reservations made before the repair and stops all timers when the relay stops', async () => {
    const relay = relayServer(2 * hour);
    const store = relay.reservationStore;
    const [early, late] = [await newPeer(), await newPeer()];
    vi.useFakeTimers();
    store.reserve(early, addr);
    const original = store.reservations.get(early)!.signal;

    repairRelayReservationTimers(relay, quiet);
    expect(store.reservations.get(early)!.signal).not.toBe(original);
    vi.advanceTimersByTime(2 * hour);
    expect(store.reservations.get(early)).toBeUndefined();
    expect(original.aborted).toBe(false);

    store.reserve(late, addr);
    const lateSignal = store.reservations.get(late)!.signal;
    store.clear();
    vi.advanceTimersByTime(3 * hour);
    expect(lateSignal.aborted).toBe(false);
    expect(store.reservations.size).toBe(0);
  });

  it('gives an adopted reservation whose recorded expiry has passed a full TTL', async () => {
    const relay = relayServer(2 * hour);
    const store = relay.reservationStore;
    const peer = await newPeer();
    vi.useFakeTimers();
    store.reserve(peer, addr);
    store.reservations.get(peer)!.expiry = new Date(Date.now() - 1);

    repairRelayReservationTimers(relay, quiet);
    vi.advanceTimersByTime(2 * hour - 1);
    expect(store.reservations.get(peer)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(store.reservations.get(peer)).toBeUndefined();
  });

  it('leaves a reservation with no usable lifetime to the store', async () => {
    const relay = relayServer(2 * hour);
    const store = relay.reservationStore as ReservationStore & { reservationTtl: unknown };
    const peer = await newPeer();
    store.reserve(peer, addr);
    const original = store.reservations.get(peer)!;
    // Saved before the repair: the repair would replace it on the same object.
    const originalSignal = original.signal;
    original.expiry = new Date(0);
    store.reservationTtl = undefined;

    repairRelayReservationTimers(relay, quiet);
    expect(store.reservations.get(peer)!.signal).toBe(originalSignal);
    store.clear();
  });

  it('installs once', () => {
    const relay = relayServer(2 * hour);
    expect(repairRelayReservationTimers(relay, quiet)).toBe('repaired');
    const wrapped = relay.reservationStore.reserve;
    expect(repairRelayReservationTimers(relay, quiet)).toBe('repaired');
    expect(relay.reservationStore.reserve).toBe(wrapped);
  });

  it('is a no-op once retimeable-signal is newer than the last faulty release', () => {
    const relay = relayServer(2 * hour);
    const reserve = relay.reservationStore.reserve;
    const log = vi.fn();
    expect(repairRelayReservationTimers(relay, { ...quiet, log, retimeableSignalVersion: '1.0.2' })).toBe('not-needed');
    expect(relay.reservationStore.reserve).toBe(reserve);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retimeable-signal 1.0.2'));
  });

  it('repairs when the installed version cannot be read', () => {
    const log = vi.fn();
    expect(repairRelayReservationTimers(relayServer(2 * hour), { ...quiet, log, retimeableSignalVersion: null })).toBe('repaired');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(version unknown)'));
  });

  it.each([
    ['no relay service', undefined],
    ['no reservation store', { reservations: new Map() }],
    ['a store without reserve()', { reservationStore: { reservations: new Map(), removeReservation() {}, clear() {} } }],
    ['a store without a reservation map', { reservationStore: { reserve() {}, removeReservation() {}, clear() {} } }],
    ['a reservation map without delete()', { reservationStore: { reservations: { get() {}, forEach() {} }, reserve() {}, removeReservation() {}, clear() {} } }],
  ])('reports %s as unavailable', (_case, relayService) => {
    const warn = vi.fn();
    expect(repairRelayReservationTimers(relayService, { log: () => {}, warn, retimeableSignalVersion: '1.0.1' })).toBe('unavailable');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'));
  });

  it('logs through the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    repairRelayReservationTimers(relayServer(2 * hour));
    repairRelayReservationTimers({}, { retimeableSignalVersion: '1.0.1' });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-.*Z\] Relay reservation timers: repaired/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[\d{4}-.*Z\] Relay reservation timers: .*unexpected shape/));
  });
});

describe('reservation signal', () => {
  it('fires once at the latest reset and not after clear()', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const signal = createReservationSignal(1_000, onExpire);
    vi.advanceTimersByTime(600);
    signal.reset!();
    vi.advanceTimersByTime(600);
    signal.reset!(2_000);
    vi.advanceTimersByTime(1_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    signal.reset!();
    vi.advanceTimersByTime(5_000);
    expect(onExpire).toHaveBeenCalledOnce();

    const cleared = createReservationSignal(1_000, onExpire);
    cleared.clear!();
    vi.advanceTimersByTime(5_000);
    expect(cleared.aborted).toBe(false);
  });
});

describe('retimeable-signal version', () => {
  it.each([
    ['0.0.0', true], ['1.0.0', true], ['1.0.1', true], ['1.0.2', false], ['1.0.2-rc.1', false],
    ['1.1.0', false], ['2.0.0', false], ['not-a-version', true],
  ])('treats %s as faulty: %s', (version, faulty) => {
    expect(isFaultyRetimeableSignalVersion(version)).toBe(faulty);
  });

  it('reads the version circuit-relay-v2 loads', () => {
    expect(readRetimeableSignalVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(readDependencyVersion(import.meta.url, '@libp2p/circuit-relay-v2', 'retimeable-signal')).toBe(readRetimeableSignalVersion());
    expect(readDependencyVersion(import.meta.url, '@libp2p/not-installed-package', 'retimeable-signal')).toBeNull();
    expect(readDependencyVersion(import.meta.url, '@libp2p/circuit-relay-v2', 'not-a-dependency-of-it')).toBeNull();
    expect(readRetimeableSignalVersion('not a url')).toBeNull();
  });
});

describe('relay node wiring', () => {
  it('repairs the reservation store of a node that runs the relay server', async () => {
    const node = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false, enableRelayServer: true });
    nodes.push(node);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await node.start();
    const relay = node.libp2p.services.relay as RelayService;
    expect(relay.reservationStore.reserve).not.toBe(Object.getPrototypeOf(relay.reservationStore).reserve);
  });
});
