import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import type { DKGNode } from '../src/node.js';
import type { Network } from '../src/network/network.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';
import { ProtocolRouter } from '../src/protocol-router.js';

const PEER = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const PROTOCOL = '/test/scoped-duplex/1.0.0';
const REQUEST = new Uint8Array([1]);
const RESPONSE = new Uint8Array([2]);
const OPTIONS = { timeoutMs: 2_000, maxReadBufferBytes: 1_024 };

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

function fixture() {
  const stream = new FakeStream();
  const connection = (limited = false) => ({
    status: 'open',
    remotePeer: { toString: () => PEER, equals: (other: unknown) => String(other) === PEER },
    ...(limited ? { limits: {} } : {}),
    newStream: vi.fn(async (_protocol: string, _options: { signal?: AbortSignal; runOnLimitedConnection?: boolean }) => stream as unknown as Stream),
  });
  const connections: ReturnType<typeof connection>[] = [];
  const events = new EventTarget();
  const stop = new AbortController();
  const resolve = vi.fn(async (_peer: string, _options?: { signal?: AbortSignal; perStepTimeoutMs?: number }) => [] as string[]);
  const dial = vi.fn(async () => stream as unknown as Stream);
  const admission = vi.fn(async (..._args: unknown[]) => true);
  const addresses: { multiaddr: { toString(): string } }[] = [];
  const getConnections = vi.fn(() => connections);
  const peerStoreGet = vi.fn(async () => ({ addresses }));
  const handle = vi.fn();
  const router = new ProtocolRouter({
    stopSignal: stop.signal,
    libp2p: { getConnections, peerStore: { get: peerStoreGet }, handle,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events) },
  } as unknown as DKGNode, {
    network: { dialProtocol: dial } as unknown as Network,
    peerResolver: { resolve } as unknown as PeerResolver,
    isPeerAccepted: admission,
  });
  return { router, connections, events, stop, stream, resolve, dial, admission, addresses,
    getConnections, peerStoreGet, handle, connection };
}

const callers = [
  { name: 'send', invoke: (router: ProtocolRouter) => router.send(PEER, PROTOCOL, REQUEST, OPTIONS) },
  { name: 'duplex', invoke: (router: ProtocolRouter) => router.withDuplexStream(PEER, PROTOCOL, OPTIONS,
    async (stream, signal) => { expect(signal.aborted).toBe(false); stream.send(REQUEST); return RESPONSE; }) },
];

describe.each(callers)('shared connection policy through $name', ({ invoke }) => {
  it('requires admission before inspecting connections or resolving/dialing', async () => {
    const f = fixture(), connection = f.connection();
    f.connections.push(connection);
    f.admission.mockResolvedValue(false);
    await expect(invoke(f.router)).rejects.toThrow('not admitted');
    expect(f.admission).toHaveBeenCalledOnce();
    expect(f.getConnections).not.toHaveBeenCalled();
    expect(connection.newStream).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.dial).not.toHaveBeenCalled();
    expect(getEventListeners(f.stop.signal, 'abort')).toHaveLength(0);
  });

  it('prefers an admitted direct connection without consulting the resolver or peerStore', async () => {
    const f = fixture(), relay = f.connection(true), direct = f.connection();
    f.connections.push(relay, direct);
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.admission).toHaveBeenCalledOnce();
    expect(direct.newStream).toHaveBeenCalledOnce();
    expect(relay.newStream).not.toHaveBeenCalled();
    expect(f.peerStoreGet).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.dial).not.toHaveBeenCalled();
  });

  it('ends resolution when the target connects, while preserving the operation signal', async () => {
    const f = fixture(), direct = f.connection();
    let entered!: () => void;
    const resolving = new Promise<void>(done => { entered = done; });
    let resolverSignal!: AbortSignal;
    f.resolve.mockImplementation(async (_peer, options) => {
      resolverSignal = options!.signal!;
      entered();
      await new Promise<void>(done => resolverSignal.addEventListener('abort', () => done(), { once: true }));
      return [];
    });
    const operation = invoke(f.router);
    await resolving;
    f.connections.push(direct);
    f.events.dispatchEvent(new CustomEvent('connection:open', { detail: direct }));
    await expect(operation).resolves.toEqual(RESPONSE);
    expect(resolverSignal.aborted).toBe(true);
    expect(direct.newStream).toHaveBeenCalledWith(PROTOCOL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const streamSignal = direct.newStream.mock.calls[0]![1].signal as AbortSignal;
    expect(streamSignal.aborted).toBe(false);
    expect(streamSignal).not.toBe(resolverSignal);
    expect(f.dial).not.toHaveBeenCalled();
    expect(getEventListeners(f.events, 'connection:open')).toHaveLength(0);
    expect(getEventListeners(f.stop.signal, 'abort')).toHaveLength(0);
  });

  it('can use a live relay only after a normal dial fails against cached direct addresses', async () => {
    const f = fixture(), relay = f.connection(true);
    f.connections.push(relay);
    f.addresses.push({ multiaddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' } });
    f.dial.mockRejectedValue(new Error('no valid addresses for peer'));
    await expect(invoke(f.router)).resolves.toEqual(RESPONSE);
    expect(f.admission).toHaveBeenCalledOnce();
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.dial).toHaveBeenCalledOnce();
    expect(relay.newStream).toHaveBeenCalledOnce();
    expect(f.dial).toHaveBeenCalledBefore(relay.newStream);
    expect(f.stream.sent).toEqual([REQUEST]);
  });
});

describe('scoped duplex ownership', () => {
  it('reports the inbound failure stage without exposing request or error text', async () => {
    const f = fixture();
    const onInboundOpen = vi.fn();
    const onInboundFailure = vi.fn();
    f.router.registerDuplexStream(PROTOCOL,
      async () => ({ requestData: REQUEST, continuation: undefined }),
      async () => { throw Object.assign(new Error('secret request body'), { code: 'PRIVATE:secret' }); },
      { ...OPTIONS, maxRequestBytes: 10, onInboundOpen, onInboundFailure });
    const inbound = f.handle.mock.calls[0]![1] as (stream: Stream, connection: ReturnType<typeof f.connection>) => Promise<void>;
    await inbound(f.stream as unknown as Stream, f.connection());
    expect(onInboundOpen).toHaveBeenCalledWith(PEER.slice(-8));
    expect(onInboundFailure).toHaveBeenCalledWith({
      peerIdSuffix: PEER.slice(-8), stage: 'handler', errorName: 'Error',
      errorCode: undefined, signalAborted: false,
    });
    expect(JSON.stringify(onInboundFailure.mock.calls)).not.toContain('secret');
    expect(f.stream.abort).toHaveBeenCalled();
  });

  it('reports pre-handler admission failure even when the diagnostic callback throws', async () => {
    const f = fixture();
    f.admission.mockResolvedValue(false);
    const handler = vi.fn();
    const onInboundFailure = vi.fn(() => { throw new Error('observer failed'); });
    f.router.registerDuplexStream(PROTOCOL,
      async () => ({ requestData: REQUEST, continuation: undefined }), handler,
      { ...OPTIONS, maxRequestBytes: 10, onInboundFailure });
    const inbound = f.handle.mock.calls[0]![1] as (stream: Stream, connection: ReturnType<typeof f.connection>) => Promise<void>;
    await expect(inbound(f.stream as unknown as Stream, f.connection())).resolves.toBeUndefined();
    expect(onInboundFailure).toHaveBeenCalledWith(expect.objectContaining({ stage: 'peer-admission' }));
    expect(handler).not.toHaveBeenCalled();
    expect(f.stream.abort).toHaveBeenCalled();
  });

  it('stops before dialing when cancellation ends a pending resolver', async () => {
    const f = fixture();
    let entered!: () => void;
    const resolving = new Promise<void>(done => { entered = done; });
    f.resolve.mockImplementation(async (_peer, options) => {
      entered();
      await new Promise<void>(done => options!.signal!.addEventListener('abort', () => done(), { once: true }));
      return [];
    });
    const callback = vi.fn(async () => undefined);
    const operation = f.router.withDuplexStream(PEER, PROTOCOL, OPTIONS, callback);
    await resolving;
    f.stop.abort(new Error('node stopping'));
    await expect(operation).rejects.toThrow('node stopping');
    expect(f.dial).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(getEventListeners(f.events, 'connection:open')).toHaveLength(0);
    expect(getEventListeners(f.stop.signal, 'abort')).toHaveLength(0);
  });

  it('registers a caller-owned protocol and caps buffers without an experimental identity check', async () => {
    const f = fixture();
    f.router.registerDuplexStream(PROTOCOL, async () => ({ requestData: REQUEST, continuation: undefined }),
      async () => {}, { ...OPTIONS, maxRequestBytes: 10 });
    expect(f.handle).toHaveBeenCalledWith(PROTOCOL, expect.any(Function), { runOnLimitedConnection: true });
    await f.router.withDuplexStream(PEER, PROTOCOL, OPTIONS, async stream => {
      expect(stream.maxReadBufferLength).toBe(OPTIONS.maxReadBufferBytes);
      expect(stream.maxWriteBufferLength).toBe(OPTIONS.maxReadBufferBytes);
    });
  });

  it('never opens another route after callback entry, even for a recoverable error', async () => {
    const f = fixture(), relay = f.connection(true);
    f.connections.push(relay);
    f.addresses.push({ multiaddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' } });
    let callbacks = 0;
    await expect(f.router.withDuplexStream(PEER, PROTOCOL, OPTIONS, async stream => {
      callbacks++;
      stream.send(REQUEST);
      throw new Error('stream reset after write');
    })).rejects.toThrow('stream reset after write');
    expect(callbacks).toBe(1);
    expect(f.dial).toHaveBeenCalledOnce();
    expect(relay.newStream).not.toHaveBeenCalled();
    expect(f.stream.sent).toEqual([REQUEST]);
    expect(f.stream.abort).toHaveBeenCalledOnce();
  });
});
