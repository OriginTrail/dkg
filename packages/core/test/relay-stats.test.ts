import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGNode } from '../src/node.js';
import { RELAY_V2_HOP_CODEC, RELAY_V2_STOP_CODEC } from '../src/libp2p-metrics-adapter.js';

type Reservation = { expiry?: Date; addr?: { toString(): string }; limit?: { duration?: number; data?: number | bigint } };
type Connection = { streams?: Array<{ protocol?: string; direction?: string }> };

const transport = vi.hoisted(() => ({
  reservations: new Map<string, Reservation | undefined>(),
  connections: vi.fn<() => Connection[]>(() => []),
}));

// Stub the transport boundary; exercise DKGNode's real startup, metrics and
// public stats API without relying on background network events for coverage.
vi.mock('libp2p', () => ({
  createLibp2p: vi.fn(async () => ({
    peerId: { toString: () => 'relay-test-peer' },
    services: { relay: { reservations: transport.reservations } },
    getConnections: transport.connections,
    getMultiaddrs: () => [],
    addEventListener: vi.fn(),
    stop: vi.fn(),
  })),
}));

const nodes: DKGNode[] = [];
async function startRelay(): Promise<DKGNode> {
  const node = new DKGNode({ enableMdns: false, enableRelayServer: true, relayServerCapacity: 17 });
  nodes.push(node);
  await node.start();
  return node;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
  transport.reservations.clear();
  transport.connections.mockReset().mockReturnValue([]);
});

describe('relay statistics', () => {
  it('reports unavailable statistics before start and after stop', async () => {
    const node = new DKGNode({ enableMdns: false, enableRelayServer: true });
    expect(node.getRelayStats()).toBeNull();
    nodes.push(node);
    await node.start();
    expect(node.getRelayStats()?.reservationCount).toBe(0);
    await node.stop();
    expect(node.getRelayStats()).toBeNull();
  });

  it('counts forwarded circuits once and reports current reservation details', async () => {
    const node = await startRelay();
    transport.reservations.set('limited-peer', {
      expiry: new Date('2026-01-01T00:00:00Z'),
      addr: { toString: () => '/ip4/127.0.0.1/tcp/4001' },
      limit: { duration: 120_000, data: 4096n },
    });
    transport.reservations.set('numeric-limit-peer', { limit: { data: 2048 } });
    transport.reservations.set('pending-peer', undefined);
    transport.connections.mockReturnValue([
      { streams: [
        { protocol: RELAY_V2_HOP_CODEC, direction: 'inbound' },
        { protocol: RELAY_V2_STOP_CODEC, direction: 'outbound' },
        { protocol: RELAY_V2_STOP_CODEC, direction: 'inbound' },
        { protocol: '/dkg/query', direction: 'outbound' },
      ] },
      {},
    ]);

    expect(node.getRelayStats()).toEqual({
      capacity: 17,
      reservationCount: 3,
      activeCircuits: 1,
      bytesIn: 0n,
      bytesOut: 0n,
      reservations: [
        { peerId: 'limited-peer', expiryTs: 1767225600000, addr: '/ip4/127.0.0.1/tcp/4001', limitDurationMs: 120_000, limitDataBytes: 4096 },
        { peerId: 'numeric-limit-peer', expiryTs: null, addr: null, limitDurationMs: null, limitDataBytes: 2048 },
        { peerId: 'pending-peer', expiryTs: null, addr: null, limitDurationMs: null, limitDataBytes: null },
      ],
    });
    transport.reservations.delete('limited-peer');
    transport.connections.mockReturnValue([]);
    expect(node.getRelayStats()).toMatchObject({ reservationCount: 2, activeCircuits: 0 });
  });

  it('keeps valid reservations when one entry or the connection snapshot is malformed', async () => {
    const node = await startRelay();
    transport.reservations.set('malformed-peer', { addr: { toString() { throw new Error('bad address'); } } });
    transport.reservations.set('healthy-peer', {});
    transport.connections.mockImplementation(() => { throw new Error('connection snapshot unavailable'); });

    expect(node.getRelayStats()).toMatchObject({
      reservationCount: 2,
      activeCircuits: 0,
      reservations: [{ peerId: 'healthy-peer' }],
    });
  });
});
