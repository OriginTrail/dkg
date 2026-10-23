import { describe, expect, it } from 'vitest';
import {
  RELAY_ONLY_PEER_MEMORY_MAX_PEERS,
  RELAY_ONLY_PEER_MEMORY_TTL_MS,
  RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES,
  RelayOnlyPeerMemory,
  circuitCarriesOperation,
} from '../src/relay-only-peer-memory.js';
import { RELAY_DEFAULT_DURATION_LIMIT_MS } from '../src/relay-capacity-policy.js';

const PEER_A = '12D3KooWPeerA';
const PEER_B = '12D3KooWPeerB';
const PEER_C = '12D3KooWPeerC';
const LAN = '/ip4/192.168.1.20/tcp/4001';
const LAN_WS = '/ip4/192.168.1.20/tcp/4002/ws';
const CIRCUIT = '/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWRelay/p2p-circuit';
const T0 = 1_000_000;

function clock() {
  let now = T0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const peer = (...addresses: Array<string | undefined>) => async () => ({
  addresses: addresses.map((address) => ({ multiaddr: address === undefined ? undefined : { toString: () => address } })),
});

const circuit = (overrides: { bytes?: unknown; seconds?: unknown; open?: unknown } = {}) => ({
  status: 'open',
  limits: { bytes: 'bytes' in overrides ? overrides.bytes : 256n * 1024n * 1024n, seconds: 'seconds' in overrides ? overrides.seconds : 1_800_000 },
  timeline: { open: 'open' in overrides ? overrides.open : T0 },
});
const direct = (status = 'open') => ({ status, timeline: { open: T0 } });

describe('RelayOnlyPeerMemory records', () => {
  it('holds a record for the exact address set until the time bound ends', () => {
    const c = clock(), memory = new RelayOnlyPeerMemory({ now: c.now, ttlMs: 1_000 });
    expect(memory.holds(PEER_A, LAN)).toBe(false);
    memory.remember(PEER_A, LAN);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
    expect(memory.holds(PEER_A, `${LAN}\n${LAN_WS}`)).toBe(false);
    expect(memory.holds(PEER_B, LAN)).toBe(false);
    c.advance(999);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
    c.advance(1);
    expect(memory.holds(PEER_A, LAN)).toBe(false);
    // An expired record is gone, not merely ignored.
    c.advance(-1);
    expect(memory.holds(PEER_A, LAN)).toBe(false);
  });

  it('forgets a peer on request', () => {
    const memory = new RelayOnlyPeerMemory();
    memory.remember(PEER_A, LAN);
    memory.forget(PEER_A);
    expect(memory.holds(PEER_A, LAN)).toBe(false);
  });

  it('keeps at most the configured number of peers, dropping the least recently used', () => {
    const memory = new RelayOnlyPeerMemory({ maxPeers: 2 });
    memory.remember(PEER_A, LAN);
    memory.remember(PEER_B, LAN);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
    memory.remember(PEER_C, LAN);
    expect(memory.holds(PEER_B, LAN)).toBe(false);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
    expect(memory.holds(PEER_C, LAN)).toBe(true);
  });

  it('defaults to a five-minute bound and a few thousand peers', () => {
    expect(RELAY_ONLY_PEER_MEMORY_TTL_MS).toBe(5 * 60_000);
    expect(RELAY_ONLY_PEER_MEMORY_MAX_PEERS).toBe(4_096);
    const c = clock(), memory = new RelayOnlyPeerMemory({ now: c.now });
    memory.remember(PEER_A, LAN);
    c.advance(RELAY_ONLY_PEER_MEMORY_TTL_MS - 1);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
    c.advance(1);
    expect(memory.holds(PEER_A, LAN)).toBe(false);
  });
});

describe('RelayOnlyPeerRoute', () => {
  it('reports direct addresses without counting circuit addresses', async () => {
    const memory = new RelayOnlyPeerMemory();
    await expect(memory.routeFor(PEER_A, peer(CIRCUIT)).peerHasDirectAddrs()).resolves.toBe(false);
    await expect(memory.routeFor(PEER_A, peer(CIRCUIT, LAN)).peerHasDirectAddrs()).resolves.toBe(true);
    await expect(memory.routeFor(PEER_A, peer(undefined, '')).peerHasDirectAddrs()).resolves.toBe(false);
    await expect(memory.routeFor(PEER_A, async () => ({})).peerHasDirectAddrs()).resolves.toBe(false);
  });

  it('passes a peer-store miss through to the caller', async () => {
    const route = new RelayOnlyPeerMemory().routeFor(PEER_A, async () => { throw new Error('NotFound'); });
    await expect(route.peerHasDirectAddrs()).rejects.toThrow('NotFound');
    route.afterNormalDial([circuit()]);
    expect(route.reuseLimited(circuit(), 1_000)).toBe(false);
  });

  it('remembers a dial that left only limited connections, keyed by the direct address set in any order', async () => {
    const c = clock(), memory = new RelayOnlyPeerMemory({ now: c.now });
    const first = memory.routeFor(PEER_A, peer(LAN_WS, CIRCUIT, LAN, LAN));
    await first.peerHasDirectAddrs();
    expect(first.reuseLimited(circuit(), 1_000)).toBe(false);
    first.afterNormalDial([circuit(), direct('closed')]);
    expect(first.reuseLimited(circuit(), 1_000)).toBe(true);

    const later = memory.routeFor(PEER_A, peer(LAN, LAN_WS));
    expect(later.reuseLimited(circuit(), 1_000)).toBe(false);
    await later.peerHasDirectAddrs();
    expect(later.reuseLimited(circuit(), 1_000)).toBe(true);

    const moved = memory.routeFor(PEER_A, peer(LAN));
    await moved.peerHasDirectAddrs();
    expect(moved.reuseLimited(circuit(), 1_000)).toBe(false);
  });

  it('forgets the peer when a dial leaves an open direct connection', async () => {
    const memory = new RelayOnlyPeerMemory();
    memory.remember(PEER_A, LAN);
    const route = memory.routeFor(PEER_A, peer(LAN));
    await route.peerHasDirectAddrs();
    route.afterNormalDial([circuit(), { timeline: { open: T0 } }]);
    expect(memory.holds(PEER_A, LAN)).toBe(false);
  });

  it('records nothing when the dial left no open connection or the addresses were not read', async () => {
    const memory = new RelayOnlyPeerMemory();
    const unread = memory.routeFor(PEER_A, peer(LAN));
    unread.afterNormalDial([circuit()]);
    expect(memory.holds(PEER_A, LAN)).toBe(false);

    const route = memory.routeFor(PEER_A, peer(LAN));
    await route.peerHasDirectAddrs();
    route.afterNormalDial([{ ...circuit(), status: 'closing' }]);
    expect(memory.holds(PEER_A, LAN)).toBe(false);

    memory.remember(PEER_A, LAN);
    route.afterNormalDial([]);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
  });

  it('records a dial the request deadline cut short, not one the caller or a stop cancelled', async () => {
    const aborted = (reason: unknown) => { const controller = new AbortController(); controller.abort(reason); return controller.signal; };
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const memory = new RelayOnlyPeerMemory();
    const route = memory.routeFor(PEER_A, peer(LAN));
    await route.peerHasDirectAddrs();

    route.afterNormalDial([circuit()], aborted(new DOMException('aborted', 'AbortError')));
    route.afterNormalDial([circuit()], aborted(new Error('node stopping')));
    expect(memory.holds(PEER_A, LAN)).toBe(false);

    route.afterNormalDial([circuit()], aborted(timeout));
    expect(memory.holds(PEER_A, LAN)).toBe(true);
    // A deadline-cut dial that left a direct connection open still forgets the peer.
    route.afterNormalDial([circuit(), direct()], aborted(timeout));
    expect(memory.holds(PEER_A, LAN)).toBe(false);
    route.afterNormalDial([circuit()], new AbortController().signal);
    expect(memory.holds(PEER_A, LAN)).toBe(true);
  });

  it('still requires the circuit to carry the operation', async () => {
    const memory = new RelayOnlyPeerMemory({ now: () => T0 });
    memory.remember(PEER_A, LAN);
    const route = memory.routeFor(PEER_A, peer(LAN));
    await route.peerHasDirectAddrs();
    expect(route.reuseLimited(circuit(), 1_000)).toBe(true);
    expect(route.reuseLimited(circuit({ bytes: 1024n }), 1_000)).toBe(false);
  });
});

describe('circuitCarriesOperation', () => {
  const ok = (connection: Parameters<typeof circuitCarriesOperation>[0], operationMs = 20_000, now = T0) =>
    circuitCarriesOperation(connection, operationMs, now);

  it('accepts a fresh circuit from a relay that grants 256 MiB and 30 minutes', () => {
    expect(ok(circuit())).toBe(true);
  });

  it('needs a readable allowance object', () => {
    expect(ok({ limits: undefined })).toBe(false);
    expect(ok({ limits: null })).toBe(false);
    expect(ok({ limits: 'unlimited' })).toBe(false);
    expect(ok({ limits: {} })).toBe(true);
  });

  it('needs 16 MiB of data allowance left, as a bigint or a number', () => {
    expect(ok(circuit({ bytes: RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES }))).toBe(true);
    expect(ok(circuit({ bytes: RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES - 1n }))).toBe(false);
    expect(ok(circuit({ bytes: Number(RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES) }))).toBe(true);
    expect(ok(circuit({ bytes: Number(RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES) - 1 }))).toBe(false);
    expect(ok(circuit({ bytes: Number.NaN }))).toBe(false);
    expect(ok(circuit({ bytes: '256' }))).toBe(false);
    expect(ok(circuit({ bytes: undefined }))).toBe(true);
    expect(ok(circuit({ bytes: null }))).toBe(true);
  });

  it('needs the reported seconds to outlast the operation', () => {
    expect(ok(circuit({ seconds: 21 }))).toBe(true);
    expect(ok(circuit({ seconds: 20 }))).toBe(false);
    expect(ok(circuit({ seconds: Number.NaN }))).toBe(false);
    expect(ok(circuit({ seconds: '1800' }))).toBe(false);
    expect(ok(circuit({ seconds: null }))).toBe(true);
  });

  it('needs the circuit to outlast the operation by its age against the relay duration limit', () => {
    const lastStart = T0 + RELAY_DEFAULT_DURATION_LIMIT_MS - 20_001;
    expect(ok(circuit(), 20_000, lastStart)).toBe(true);
    expect(ok(circuit(), 20_000, lastStart + 1)).toBe(false);
    expect(ok({ limits: {}, timeline: null })).toBe(true);
    expect(ok({ limits: {}, timeline: {} })).toBe(false);
    expect(ok(circuit({ open: Number.NaN }))).toBe(false);
  });
});
