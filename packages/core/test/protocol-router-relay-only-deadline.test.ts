import { describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import type { DKGNode } from '../src/node.js';
import type { Network } from '../src/network/network.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';
import { ProtocolRouter } from '../src/protocol-router.js';

// A peer reached through a relay whose peer store also lists a direct address
// that goes nowhere, as an address that drops every packet does: a dial to it
// hangs until the request's deadline ends it. The circuit stays open all the
// while (relay-only-peer-memory.ts, `afterNormalDial`).

const PEER = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const PROTOCOL = '/test/relay-only-deadline/1.0.0';
const REQUEST = new Uint8Array([1]);
const RESPONSE = new Uint8Array([2]);
const OPTIONS = { timeoutMs: 2_000, maxReadBufferBytes: 1_024 };
const LAN_ADDRESS = '/ip4/192.168.1.20/tcp/4001';
const CIRCUIT_ADDRESS = `/ip4/203.0.113.7/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/${PEER}`;

class FakeStream extends EventTarget {
  status = 'open';
  writeStatus = 'writable';
  maxReadBufferLength = 4_096;
  maxWriteBufferLength = 4_096;
  send() { return true; }
  async close() {
    this.status = 'closed';
    this.writeStatus = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  abort = vi.fn(() => { this.status = 'aborted'; });
  async *[Symbol.asyncIterator]() { yield RESPONSE; }
}

function fixture() {
  // A circuit through a relay that grants 256 MiB and 30 minutes.
  const circuit = {
    status: 'open',
    limits: { bytes: 256n * 1024n * 1024n, seconds: 1_800_000 },
    timeline: { open: Date.now() },
    remoteAddr: { toString: () => CIRCUIT_ADDRESS },
    remotePeer: { toString: () => PEER, equals: (other: unknown) => String(other) === PEER },
    newStream: vi.fn(async () => new FakeStream() as unknown as Stream),
  };
  const dial = vi.fn(async (..._args: unknown[]) => new FakeStream() as unknown as Stream);
  const router = new ProtocolRouter({
    stopSignal: new AbortController().signal,
    libp2p: {
      getConnections: () => [circuit],
      peerStore: { get: vi.fn(async () => ({ addresses: [{ multiaddr: { toString: () => LAN_ADDRESS } }] })) },
      handle: vi.fn(),
    },
  } as unknown as DKGNode, {
    network: { dialProtocol: dial } as unknown as Network,
    peerResolver: { resolve: vi.fn(async () => [] as string[]) } as unknown as PeerResolver,
  });
  return { router, circuit, dial };
}

type TimedOptions = { timeoutMs?: number; signal?: AbortSignal };
const callers = [
  { name: 'send', invoke: (router: ProtocolRouter, options: TimedOptions = {}) =>
    router.send(PEER, PROTOCOL, REQUEST, { ...OPTIONS, ...options }) },
  { name: 'duplex', invoke: (router: ProtocolRouter, options: TimedOptions = {}) =>
    router.withDuplexStream(PEER, PROTOCOL, { ...OPTIONS, ...options }, async (stream) => { stream.send(REQUEST); return RESPONSE; }) },
];

/** A dial that hangs until its signal aborts. */
function hangingDial(...args: unknown[]): Promise<Stream> {
  const signal = (args[2] as { signal: AbortSignal }).signal;
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe.each(callers)('a dial cut short while the circuit stays open, through $name', ({ invoke }) => {
  it('is recorded when the request deadline ended it: the next operation takes the circuit', async () => {
    const f = fixture();
    f.dial.mockImplementationOnce(hangingDial);

    await expect(invoke(f.router, { timeoutMs: 150 })).rejects.toBeTruthy();
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledOnce();
    expect(f.circuit.newStream).toHaveBeenCalledOnce();
  });

  it('is not recorded when the caller cancelled it: the next operation dials again', async () => {
    const f = fixture();
    const caller = new AbortController();
    f.dial.mockImplementationOnce((...args: unknown[]) => {
      setTimeout(() => caller.abort(), 20);
      return hangingDial(...args);
    });

    await expect(invoke(f.router, { signal: caller.signal })).rejects.toBeTruthy();
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);

    expect(f.dial).toHaveBeenCalledTimes(2);
    expect(f.circuit.newStream).not.toHaveBeenCalled();
  });
});
