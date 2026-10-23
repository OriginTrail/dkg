import { describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import type { DKGNode } from '../src/node.js';
import type { Network } from '../src/network/network.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import { RELAY_DEFAULT_DURATION_LIMIT_MS } from '../src/relay-capacity-policy.js';

// A peer reached through a relay whose peer store also lists a direct (LAN)
// address. libp2p dials a circuit address through a public relay before a
// private address, and when the new circuit has the same remote address as the
// open one it aborts the new circuit and returns the open one. A dial that
// "succeeds" therefore leaves the peer with its limited connection only.

const PEER = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const PROTOCOL = '/test/relay-only-peer/1.0.0';
const REQUEST = new Uint8Array([1]);
const RESPONSE = new Uint8Array([2]);
const OPTIONS = { timeoutMs: 2_000, maxReadBufferBytes: 1_024 };
const LAN_ADDRESS = '/ip4/192.168.1.20/tcp/4001';
const OTHER_LAN_ADDRESS = '/ip4/192.168.1.21/tcp/4001';
const CIRCUIT_ADDRESS = `/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/${PEER}`;
const MIB = 1024n * 1024n;

class FakeStream extends EventTarget {
  status = 'open';
  writeStatus = 'writable';
  maxReadBufferLength = 4_096;
  maxWriteBufferLength = 4_096;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array) { this.sent.push(data); return true; }
  async close() {
    this.status = 'closed';
    this.writeStatus = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  abort = vi.fn(() => { this.status = 'aborted'; });
  async *[Symbol.asyncIterator]() { yield RESPONSE; }
}

interface FakeConnection {
  status: string;
  limits?: { bytes?: bigint; seconds?: number };
  timeline: { open: number };
  remoteAddr: { toString(): string };
  remotePeer: { toString(): string; equals(other: unknown): boolean };
  newStream: ReturnType<typeof vi.fn>;
}

function fixture(options: { publicDirectAddressesOnly?: boolean } = {}) {
  const connections: FakeConnection[] = [];
  const connection = (opts: { limits?: FakeConnection['limits']; openedAt?: number; remoteAddr?: string } = {}) => {
    const created: FakeConnection = {
      status: 'open',
      ...(opts.limits ? { limits: opts.limits } : {}),
      timeline: { open: opts.openedAt ?? Date.now() },
      remoteAddr: { toString: () => opts.remoteAddr ?? (opts.limits ? CIRCUIT_ADDRESS : LAN_ADDRESS) },
      remotePeer: { toString: () => PEER, equals: (other: unknown) => String(other) === PEER },
      newStream: vi.fn(async () => new FakeStream() as unknown as Stream),
    };
    return created;
  };
  // A circuit through a relay that grants 256 MiB and 30 minutes.
  const relay = (opts: { bytes?: bigint; openedAt?: number } = {}) =>
    connection({ limits: { bytes: opts.bytes ?? 256n * MIB, seconds: 1_800_000 }, openedAt: opts.openedAt });
  const addresses = [{ multiaddr: { toString: () => LAN_ADDRESS } }];
  const resolve = vi.fn(async () => [] as string[]);
  const dial = vi.fn(async (..._args: unknown[]) => new FakeStream() as unknown as Stream);
  const router = new ProtocolRouter({
    stopSignal: new AbortController().signal,
    libp2p: {
      getConnections: () => connections,
      peerStore: { get: vi.fn(async () => ({ addresses })) },
      handle: vi.fn(),
    },
  } as unknown as DKGNode, {
    network: { dialProtocol: dial } as unknown as Network,
    peerResolver: { resolve } as unknown as PeerResolver,
    ...options,
  });
  return { router, connections, connection, relay, addresses, dial };
}

const callers = [
  { name: 'send', invoke: (router: ProtocolRouter) => router.send(PEER, PROTOCOL, REQUEST, OPTIONS) },
  { name: 'duplex', invoke: (router: ProtocolRouter) => router.withDuplexStream(PEER, PROTOCOL, OPTIONS,
    async (stream) => { stream.send(REQUEST); return RESPONSE; }) },
];

describe.each(callers)('relay-only peer with a direct address in the peer store, through $name', ({ invoke }) => {
  it('reuses the open circuit once a dial has ended on it, without dialing another circuit', async () => {
    const f = fixture(), circuit = f.relay();
    f.connections.push(circuit);

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).not.toHaveBeenCalled();

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).toHaveBeenCalledTimes(2);
    expect(circuit.newStream).toHaveBeenCalledWith(PROTOCOL, expect.objectContaining({ runOnLimitedConnection: true }));
  });

  it('reuses the open circuit on later operations after a dial to the direct address failed', async () => {
    const f = fixture(), circuit = f.relay();
    f.connections.push(circuit);
    f.dial.mockRejectedValue(new Error('All multiaddr dials failed'));

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).toHaveBeenCalledOnce();

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).toHaveBeenCalledTimes(2);
  });

  it('keeps dialing past the circuit when a dial reaches the peer directly', async () => {
    const f = fixture(), circuit = f.relay(), direct = f.connection();
    f.connections.push(circuit);
    f.dial.mockImplementation(async () => {
      f.connections.push(direct);
      return new FakeStream() as unknown as Stream;
    });

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    // The direct connection closes; the next operation must not take the
    // circuit while the direct address is known to work.
    f.connections.splice(f.connections.indexOf(direct), 1);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledTimes(2);
    expect(circuit.newStream).not.toHaveBeenCalled();
  });

  it('forgets an earlier relay-only dial once a dial reaches the peer directly', async () => {
    const f = fixture(), circuit = f.relay(), direct = f.connection();
    f.connections.push(circuit);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).toHaveBeenCalledOnce();

    // The circuit refuses a stream once, so this operation dials, and the
    // dial reaches the peer directly.
    circuit.newStream.mockRejectedValueOnce(new Error('stream reset'));
    f.dial.mockImplementationOnce(async () => {
      f.connections.push(direct);
      return new FakeStream() as unknown as Stream;
    });
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledTimes(2);

    // With the direct connection gone, the direct address is known to work:
    // the next operation dials instead of taking the circuit.
    f.connections.splice(f.connections.indexOf(direct), 1);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.dial).toHaveBeenCalledTimes(3);
    expect(circuit.newStream).toHaveBeenCalledTimes(2);
  });

  it('dials again when the peer store lists a different direct address', async () => {
    const f = fixture(), circuit = f.relay();
    f.connections.push(circuit);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    f.addresses.push({ multiaddr: { toString: () => OTHER_LAN_ADDRESS } });
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledTimes(2);
    expect(circuit.newStream).not.toHaveBeenCalled();
  });

  it('does not reuse a circuit with less than 16 MiB of its data allowance left', async () => {
    const f = fixture(), circuit = f.relay({ bytes: 16n * MIB - 1n });
    f.connections.push(circuit);

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledTimes(2);
    expect(circuit.newStream).not.toHaveBeenCalled();
  });

  it('does not reuse a circuit the relay closes before the operation deadline', async () => {
    const f = fixture();
    const circuit = f.relay({ openedAt: Date.now() - RELAY_DEFAULT_DURATION_LIMIT_MS + 1_000 });
    f.connections.push(circuit);

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledTimes(2);
    expect(circuit.newStream).not.toHaveBeenCalled();
  });
});

// What a node lists when it announces every interface it has: loopback, a LAN,
// a container bridge and a VPN in the shared range. None is reachable from
// another network.
const UNREACHABLE_ADDRESSES = [
  '/ip4/127.0.0.1/tcp/4001', '/ip4/10.0.0.4/tcp/4001', '/ip4/172.17.0.1/tcp/4001', '/ip4/100.64.0.9/tcp/4001',
];
const PUBLIC_ADDRESS = '/ip4/198.51.100.20/tcp/4001';

function listAddresses(f: ReturnType<typeof fixture>, addresses: readonly string[]): void {
  f.addresses.splice(0, f.addresses.length, ...addresses.map((address) => ({ multiaddr: { toString: () => address } })));
}

describe.each(callers)('relay-only peer that announces no public address, through $name', ({ invoke }) => {
  it('with publicDirectAddressesOnly, takes the open circuit from the first operation, without a dial', async () => {
    const f = fixture({ publicDirectAddressesOnly: true }), circuit = f.relay();
    listAddresses(f, UNREACHABLE_ADDRESSES);
    f.connections.push(circuit);

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).not.toHaveBeenCalled();
    expect(circuit.newStream).toHaveBeenCalledTimes(2);
  });

  it('without the option, dials past the circuit first', async () => {
    const f = fixture(), circuit = f.relay();
    listAddresses(f, UNREACHABLE_ADDRESSES);
    f.connections.push(circuit);

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).not.toHaveBeenCalled();
  });

  it('with publicDirectAddressesOnly, still dials a peer that also announces a public address', async () => {
    const f = fixture({ publicDirectAddressesOnly: true }), circuit = f.relay();
    listAddresses(f, [...UNREACHABLE_ADDRESSES, PUBLIC_ADDRESS]);
    f.connections.push(circuit);

    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledOnce();
    expect(circuit.newStream).not.toHaveBeenCalled();
  });
});
