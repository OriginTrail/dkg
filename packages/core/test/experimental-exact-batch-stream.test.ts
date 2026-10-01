import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import type { DKGNode } from '../src/node.js';
import type { Network } from '../src/network/network.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import {
  exchangeExperimentalExactBatch, registerExperimentalExactBatchResponder,
  ExperimentalExactBatchUnsupportedError, ExactBatchTransportSession, type ExactBatchTransportOptions,
  EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL, type ExactBatchTransportEvent,
} from '../src/experimental-exact-batch-stream.js';
import {
  EXACT_BATCH_FRAME_KIND as K, ExactBatchReceiveWindow, ExactBatchSendWindow,
  decodeExactBatchAsset, decodeExactBatchFrames, encodeExactBatchFrame, type ExactBatchFrame,
} from '../../agent/src/sync/exact-batch-stream-contract.js';
import { encodeNegotiatedExactSyncResponse, EXACT_SYNC_GZIP_ENCODING } from '../../agent/src/sync/wire-compression.js';

const PEER = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';
const UALS = Array.from({ length: 10 }, (_, i) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i + 1}`).sort();
const text = new TextEncoder();
const codec = { encode: encodeExactBatchFrame, decode: decodeExactBatchFrames };
const options: ExactBatchTransportOptions = { timeoutMs: 2000, windowSize: 2,
  maxReadBufferBytes: 65552, maxRequestBytes: 8192, maxFrameBytes: 65552, maxResponseBytes: 64 * 1024 * 1024 };
const frame = (kind: number, assetIndex = 255, sequence = 0, payload: Uint8Array = new Uint8Array()): ExactBatchFrame => ({ kind, assetIndex, sequence, payload });
const start = () => frame(K.REQUEST, 255, 0, text.encode('existing signed START fixture'));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** In-memory duplex only; no real node, socket, Noise handshake or backend. */
class MemoryStream extends EventTarget {
  peer!: MemoryStream;
  status = 'open'; writeStatus = 'writable'; writableNeedsDrain = false;
  maxReadBufferLength = 1024 * 1024; maxWriteBufferLength = 1024 * 1024;
  chunks: Uint8Array[] = []; pending?: { resolve: (item: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void };
  ended = false; failure?: Error; iteratorCount = 0; sentKinds: number[] = []; closes = 0;
  aborts = 0; forceDrain = false; drainGate = gate(); drainEntered = gate();
  push(bytes: Uint8Array) {
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending.resolve({ done: false, value: bytes }); }
    else this.chunks.push(bytes);
  }
  send(bytes: Uint8Array) {
    if (this.writeStatus !== 'writable') throw new Error('write side closed');
    this.sentKinds.push(bytes[4]!);
    // Split both START and controls: parser must survive arbitrary boundaries.
    for (let n = 0; n < bytes.length; n += 7) this.peer.push(bytes.slice(n, n + 7));
    this.writableNeedsDrain = this.forceDrain;
    return !this.forceDrain;
  }
  async onDrain({ signal }: { signal?: AbortSignal } = {}) {
    this.drainEntered.resolve();
    await Promise.race([this.drainGate.promise, new Promise<void>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
    this.writableNeedsDrain = false;
  }
  async close() {
    this.closes++; this.writeStatus = 'closed'; this.peer.ended = true;
    this.peer.pending?.resolve({ done: true, value: undefined }); this.peer.pending = undefined;
    if (this.ended) {
      this.status = this.peer.status = 'closed';
      this.dispatchEvent(new Event('close')); this.peer.dispatchEvent(new Event('close'));
    }
  }
  abort(error: Error) {
    if (this.status === 'aborted' || this.status === 'closed') return;
    this.aborts++; this.status = 'aborted'; this.writeStatus = 'closed'; this.failure = error;
    this.pending?.reject(error); this.pending = undefined;
    this.peer.status = 'aborted'; this.peer.writeStatus = 'closed'; this.peer.failure = error;
    this.peer.pending?.reject(error); this.peer.pending = undefined;
    this.dispatchEvent(new Event('close')); this.peer.dispatchEvent(new Event('close'));
  }
  [Symbol.asyncIterator]() {
    this.iteratorCount++;
    return { next: async (): Promise<IteratorResult<Uint8Array>> => {
      if (this.failure) throw this.failure;
      const chunk = this.chunks.shift();
      if (chunk) return { done: false, value: chunk };
      if (this.ended) return { done: true, value: undefined };
      return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    }, return: async () => ({ done: true as const, value: undefined }) };
  }
}

function fixture() {
  const client = new MemoryStream(), server = new MemoryStream(); client.peer = server; server.peer = client;
  const clientStop = new AbortController(), serverStop = new AbortController();
  const connectionEvents = new EventTarget();
  let inbound!: (stream: Stream, connection: { remotePeer: { toString(): string } }) => Promise<void>;
  let inboundDone: Promise<void> = Promise.resolve();
  const admission = vi.fn(async (..._args: unknown[]) => true), rejected = vi.fn(() => false);
  const resolved = vi.fn(async (_peer: string, _options?: { signal?: AbortSignal; perStepTimeoutMs?: number }) => [] as string[]);
  const connections: unknown[] = [], addresses: { multiaddr: { toString(): string } }[] = [];
  const node = (stop: AbortController, handle: (...args: unknown[]) => void) => ({ stopSignal: stop.signal,
    libp2p: { getConnections: () => connections, peerStore: { get: async () => ({ addresses }) }, handle,
      addEventListener: connectionEvents.addEventListener.bind(connectionEvents),
      removeEventListener: connectionEvents.removeEventListener.bind(connectionEvents) } }) as unknown as DKGNode;
  const open = async () => {
    inboundDone = inbound(server as unknown as Stream, { remotePeer: { toString: () => PEER } });
    return client as unknown as Stream;
  };
  const dial = vi.fn(open);
  const routerClient = new ProtocolRouter(node(clientStop, () => {}), { network: { dialProtocol: dial } as unknown as Network,
    peerResolver: { resolve: resolved } as unknown as PeerResolver, isPeerAccepted: admission, isPeerKnownRejected: rejected });
  const routerServer = new ProtocolRouter(node(serverStop, (_protocol, handler) => { inbound = handler as typeof inbound; }),
    { isPeerAccepted: admission, isPeerKnownRejected: rejected });
  return { client, server, clientStop, serverStop, connectionEvents, admission, rejected, resolved, dial, open, connections, addresses, routerClient, routerServer,
    settled: () => inboundDone };
}

describe('experimental exact-batch dedicated duplex transport', () => {
  it('streams ten gzip KAs on one duplex stream, downloads next while committing previous, ACKs only after commit', async () => {
    const f = fixture(), releaseFirst = gate(), secondReceived = gate();
    const written = new Map<string, Uint8Array>(), exported = new Map<string, number>();
    const bodies = UALS.map((_, i) => text.encode(`<urn:${i}> <urn:p> "${'same body '.repeat(3000)}" .\n`));
    const zipped: Uint8Array[] = [];
    for (let i = 0; i < bodies.length; i++) zipped.push(await encodeNegotiatedExactSyncResponse(bodies[i]!,
      { request: { responseEncoding: EXACT_SYNC_GZIP_ENCODING, phase: 'data', assetUals: [UALS[i]!] } }));
    expect(zipped.every((bytes, i) => bytes.length < bodies[i]!.length)).toBe(true);
    registerExperimentalExactBatchResponder(f.routerServer, codec, options,
      async (request) => { expect(request).toEqual(start().payload); return UALS; },
      async (_request, session) => {
        expect(session.windowSize).toBe(2);
        const window = new ExactBatchSendWindow({ assetCount: session.assetUals.length, windowSize: 2 });
        const ack = async () => window.acceptAck((await session.next())!);
        for (let index = 0; index < UALS.length; index++) {
          while (!window.canStartAsset) await ack();
          exported.set(UALS[index]!, (exported.get(UALS[index]!) ?? 0) + 1);
          const proof = text.encode(JSON.stringify({ assetUal: UALS[index], root: createHash('sha256').update(bodies[index]!).digest('hex') }));
          for (const item of [frame(K.META, index, 0, proof), frame(K.DATA, index, 0, zipped[index]), frame(K.ASSET_END, index, 1)]) {
            window.acceptSent(item); await session.send(item);
          }
        }
        while (window.acknowledgedCount < UALS.length) await ack();
        const end = frame(K.BATCH_END, 255, UALS.length); window.acceptSent(end); await session.send(end);
        expect(window.complete).toBe(true);
      });
    const operation = exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS },
      async (session) => {
        const window = new ExactBatchReceiveWindow({ assetUals: session.assetUals, windowSize: 2 });
        let committing: Promise<void> | undefined;
        const kick = () => {
          if (committing) return;
          const asset = window.takeReady(); if (!asset) return;
          committing = window.commitAsset(asset, async (owned) => {
            if (owned.assetIndex === 0) await releaseFirst.promise;
            const decoded = await decodeExactBatchAsset(owned, { signal: session.signal });
            const proof = JSON.parse(new TextDecoder().decode(owned.metadataBytes));
            expect(proof.assetUal).toBe(owned.assetUal);
            expect(proof.root).toBe(createHash('sha256').update(decoded.bytes).digest('hex'));
            written.set(owned.assetUal, decoded.bytes);
          }, { signal: session.signal }).then(ack => session.send(ack)).finally(() => { committing = undefined; kick(); });
        };
        while (true) {
          const item = await session.next(); expect(item).toBeDefined(); window.accept(item!);
          if (item!.kind === K.META && item!.assetIndex === 1) {
            expect(written.size).toBe(0); expect(f.client.sentKinds).toEqual([K.REQUEST]);
            secondReceived.resolve(); releaseFirst.resolve();
          }
          kick();
          if (item!.kind === K.BATCH_END) break;
        }
        await committing; expect(window.complete).toBe(true); await window.close();
        return window.committedCount;
      });
    await secondReceived.promise;
    expect(await operation).toBe(10); await f.settled();
    expect(written.size).toBe(10); expect([...exported.values()]).toEqual(Array(10).fill(1));
    expect(f.dial).toHaveBeenCalledOnce(); expect(f.client.iteratorCount).toBe(1); expect(f.server.iteratorCount).toBe(1);
    expect(f.client.sentKinds).toEqual([K.REQUEST, ...Array(10).fill(K.ACK)]);
    expect(getEventListeners(f.clientStop.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(f.serverStop.signal, 'abort')).toHaveLength(0);
    expect(f.resolved).toHaveBeenCalledBefore(f.dial);
  });

  it('rejects known peers before reading START and rejected full admission before authorization/export', async () => {
    const f = fixture(), auth = vi.fn(async () => UALS), exportAsset = vi.fn(async () => {});
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, auth, exportAsset);
    f.rejected.mockReturnValue(true);
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next()))
      .rejects.toThrow(); await f.settled();
    expect(f.server.iteratorCount).toBe(0); expect(auth).not.toHaveBeenCalled(); expect(exportAsset).not.toHaveBeenCalled();
    const g = fixture(); g.admission.mockImplementation(async (_peer, _protocol, direction) => direction !== 'inbound');
    registerExperimentalExactBatchResponder(g.routerServer, codec, options, auth, exportAsset);
    await expect(exchangeExperimentalExactBatch(g.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next()))
      .rejects.toThrow(); await g.settled();
    expect(g.server.iteratorCount).toBe(1); expect(auth).not.toHaveBeenCalled(); expect(exportAsset).not.toHaveBeenCalled();
  });

  it('authorization failure produces no export and no diagnostic payload', async () => {
    const f = fixture(), exportAsset = vi.fn(async () => {});
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => { throw new Error('denied'); }, exportAsset);
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next()))
      .rejects.toThrow(); await f.settled();
    expect(exportAsset).not.toHaveBeenCalled(); expect(f.server.sentKinds).toEqual([]);
  });

  it('outbound rejection performs no address resolution, stream reuse or physical dial', async () => {
    const f = fixture(), reuse = vi.fn(f.open);
    f.admission.mockResolvedValue(false);
    f.connections.push({ status: 'open', remotePeer: { equals: () => true }, newStream: reuse });
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next()))
      .rejects.toThrow('not admitted');
    expect(f.resolved).not.toHaveBeenCalled(); expect(reuse).not.toHaveBeenCalled(); expect(f.dial).not.toHaveBeenCalled();
  });

  it('reuses the admitted direct connection first and only uses a limited route after a real direct dial failure', async () => {
    const reply = (f: ReturnType<typeof fixture>) => registerExperimentalExactBatchResponder(f.routerServer, codec, options,
      async () => UALS, async (_request, session) => { await session.send(frame(K.BATCH_END, 255, 10)); });
    const direct = fixture(), directStream = vi.fn(direct.open), relayStream = vi.fn(direct.open); reply(direct);
    direct.connections.push(
      { status: 'open', remotePeer: { equals: () => true }, limits: {}, newStream: relayStream },
      { status: 'open', remotePeer: { equals: () => true }, newStream: directStream });
    await exchangeExperimentalExactBatch(direct.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next());
    await direct.settled(); expect(directStream).toHaveBeenCalledOnce(); expect(relayStream).not.toHaveBeenCalled();
    expect(direct.resolved).not.toHaveBeenCalled(); expect(direct.dial).not.toHaveBeenCalled();

    const limited = fixture(), limitedStream = vi.fn(limited.open); reply(limited);
    limited.addresses.push({ multiaddr: { toString: () => '/ip4/127.0.0.1/tcp/1234' } });
    limited.connections.push({ status: 'open', remotePeer: { equals: () => true }, limits: {}, newStream: limitedStream });
    limited.dial.mockRejectedValue(new Error('direct route failed'));
    await exchangeExperimentalExactBatch(limited.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next());
    await limited.settled(); expect(limited.dial).toHaveBeenCalledOnce(); expect(limitedStream).toHaveBeenCalledOnce();
    expect(limited.dial).toHaveBeenCalledBefore(limitedStream); expect(limited.client.sentKinds).toEqual([K.REQUEST]);
  });

  it('interrupts stalled resolution on connection:open, sends START once and keeps the original deadline through duplex work', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), resolving = gate(), callbackEntered = gate(), caller = new AbortController();
      let resolverSignal!: AbortSignal, exchangeSignal!: AbortSignal, callbacks = 0;
      f.resolved.mockImplementation(async (_peer, options) => {
        resolverSignal = options!.signal!;
        resolving.resolve();
        await new Promise<void>(done => resolverSignal.addEventListener('abort', () => done(), { once: true }));
        return [];
      });
      registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => UALS,
        async (_request, session) => { await session.next(); });
      const reuse = vi.fn(async (_protocol: string, _options: { signal: AbortSignal }) => f.open());
      const connection = { status: 'open', remotePeer: { equals: (other: unknown) => String(other) === PEER }, newStream: reuse };
      const outcome = exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
        { ...options, timeoutMs: 1_000, signal: caller.signal, assetUals: UALS }, async session => {
          callbacks++;
          exchangeSignal = session.signal;
          callbackEntered.resolve();
          return session.next();
        }).catch(error => error);
      await resolving.promise;
      const admission = f.admission.mock.calls.find(call => call[2] === 'outbound')!;
      const originalSignal = (admission[3] as { signal: AbortSignal }).signal;
      expect(f.client.sentKinds).toEqual([]);
      await vi.advanceTimersByTimeAsync(600);
      f.connections.push(connection);
      f.connectionEvents.dispatchEvent(new CustomEvent('connection:open', { detail: connection }));
      await callbackEntered.promise;

      expect(resolverSignal.aborted).toBe(true);
      expect(reuse).toHaveBeenCalledExactlyOnceWith(EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL,
        { runOnLimitedConnection: true, signal: originalSignal });
      expect(exchangeSignal).toBe(originalSignal);
      expect(exchangeSignal).not.toBe(resolverSignal);
      expect(exchangeSignal.aborted).toBe(false);
      expect(callbacks).toBe(1);
      expect(f.client.sentKinds).toEqual([K.REQUEST]);
      expect(f.resolved).toHaveBeenCalledOnce();
      expect(f.dial).not.toHaveBeenCalled();
      expect(getEventListeners(f.connectionEvents, 'connection:open')).toHaveLength(0);

      // Resolution consumed 600 ms; stream entry must not reset the deadline.
      await vi.advanceTimersByTimeAsync(399);
      expect(exchangeSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBeInstanceOf(Error);
      expect(exchangeSignal.reason).toMatchObject({ name: 'TimeoutError' });
      await f.settled();
      expect(callbacks).toBe(1);
      expect(reuse).toHaveBeenCalledOnce();
      expect(f.client.sentKinds).toEqual([K.REQUEST]);
      expect(f.dial).not.toHaveBeenCalled();
      for (const signal of [caller.signal, f.clientStop.signal, f.serverStop.signal, originalSignal, resolverSignal]) {
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      }
      expect(getEventListeners(f.client, 'close')).toHaveLength(0);
      expect(getEventListeners(f.server, 'close')).toHaveLength(0);
      expect(getEventListeners(f.connectionEvents, 'connection:open')).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('node stop aborts a stalled duplex read and removes linked listeners', async () => {
    const f = fixture(), entered = gate();
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => UALS,
      async (_request, session) => { entered.resolve(); await session.next(); });
    const operation = exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next());
    await entered.promise; f.clientStop.abort(new Error('node stopping'));
    await expect(operation).rejects.toThrow('node stopping'); await f.settled();
    expect(f.client.aborts).toBeGreaterThan(0); expect(getEventListeners(f.clientStop.signal, 'abort')).toHaveLength(0);
  });

  it('callback verification failure aborts a physical pending read before parser disposal settles', async () => {
    const f = fixture(), entered = gate();
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => UALS,
      async (_request, session) => { entered.resolve(); await session.next(); });
    let pending: Promise<unknown> | undefined;
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS },
      async session => {
        pending = session.next().catch(error => error);
        await entered.promise;
        throw new Error('verified atomic commit refused');
      })).rejects.toThrow('verified atomic commit refused');
    expect(await pending).toBeInstanceOf(Error); await f.settled();
    expect(f.client.status).toBe('aborted'); expect(f.client.sentKinds).toEqual([K.REQUEST]);
    expect(getEventListeners(f.clientStop.signal, 'abort')).toHaveLength(0);
  });

  it('one deadline covers admission and pending duplex work without a payload retry', async () => {
    const f = fixture();
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => UALS,
      async (_request, session) => { await session.next(); });
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
      { ...options, timeoutMs: 25, assetUals: UALS }, s => s.next())).rejects.toThrow('timeout');
    await f.settled(); expect(f.dial).toHaveBeenCalledOnce(); expect(f.client.sentKinds).toEqual([K.REQUEST]);
    expect(f.client.status).toBe('aborted'); expect(getEventListeners(f.clientStop.signal, 'abort')).toHaveLength(0);
  });

  it('waits for native write drain before advancing a frame', async () => {
    const f = fixture(); f.client.forceDrain = true;
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => UALS,
      async (_request, session) => { await session.send(frame(K.BATCH_END, 255, 10)); });
    let consumed = false;
    const operation = exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS },
      async session => { consumed = true; return session.next(); });
    await f.client.drainEntered.promise; expect(consumed).toBe(false);
    f.client.drainGate.resolve(); await operation; await f.settled();
  });

  it('only labels unsupported negotiation before START as legacy fallback; never replays ambiguous delivery', async () => {
    const f = fixture(); f.dial.mockRejectedValue(new Error('unsupported protocol'));
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next()))
      .rejects.toBeInstanceOf(ExperimentalExactBatchUnsupportedError);
    expect(f.client.sentKinds).toEqual([]); expect(f.dial).toHaveBeenCalledOnce();
    const g = fixture(); registerExperimentalExactBatchResponder(g.routerServer, codec, options, async () => UALS,
      async () => { throw new Error('unsupported protocol after request'); });
    let failure: unknown;
    try { await exchangeExperimentalExactBatch(g.routerClient, PEER, start(), codec, { ...options, assetUals: UALS }, s => s.next()); }
    catch (error) { failure = error; }
    expect(failure).not.toBeInstanceOf(ExperimentalExactBatchUnsupportedError);
    expect(g.client.sentKinds).toEqual([K.REQUEST]); expect(g.dial).toHaveBeenCalledOnce(); await g.settled();
  });

  it('requires fixed window2 and caps the actual incoming wire before buffering/decoding', async () => {
    const f = fixture();
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
      { ...options, windowSize: 1 as 2, assetUals: UALS }, s => s.next())).rejects.toThrow('window2');
    expect(f.dial).not.toHaveBeenCalled();
    registerExperimentalExactBatchResponder(f.routerServer, codec, options, async () => UALS,
      async (_request, session) => { await session.send(frame(K.META, 0, 0, new Uint8Array(100))); });
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
      { ...options, maxResponseBytes: 20, assetUals: UALS }, s => s.next())).rejects.toThrow('wire byte limit');
    await f.settled(); expect(f.client.status).toBe('aborted');
  });

  it('observes exact accepted frame bytes, raw received bytes, closed frame kinds and successful START once', async () => {
    const f = fixture(), clientEvents: ExactBatchTransportEvent[] = [], serverEvents: ExactBatchTransportEvent[] = [];
    const response = [frame(K.META, 0, 0, text.encode('proof')), frame(K.DATA, 0, 0, text.encode('bodybytes')),
      frame(K.ASSET_END, 0, 1), frame(K.BATCH_END, 255, 1)];
    const ack = frame(K.ACK, 0, 1);
    registerExperimentalExactBatchResponder(f.routerServer, codec, { ...options, onTransportEvent: e => { serverEvents.push(e); } },
      async () => [UALS[0]!], async (_request, session) => {
        for (const item of response.slice(0, 3)) await session.send(item);
        expect(await session.next()).toEqual(ack); await session.send(response[3]!);
      });
    await exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
      { ...options, assetUals: [UALS[0]!], onTransportEvent: e => { clientEvents.push(e); } }, async session => {
        for (const item of response.slice(0, 3)) expect(await session.next()).toEqual(item);
        await session.send(ack); expect(await session.next()).toEqual(response[3]);
      });
    await f.settled();
    const total = (events: ExactBatchTransportEvent[], direction: 'sent' | 'received') => events.reduce((n, e) =>
      n + (e.event === 'bytes' && e.direction === direction ? e.byteLength : 0), 0);
    const kinds = (events: ExactBatchTransportEvent[], direction: 'sent' | 'received') => events.flatMap(e =>
      e.event === 'frame' && e.direction === direction ? [e.frameKind] : []);
    const responseBytes = response.reduce((n, item) => n + codec.encode(item).byteLength, 0);
    const requestBytes = codec.encode(start()).byteLength + codec.encode(ack).byteLength;
    expect(total(clientEvents, 'sent')).toBe(requestBytes); expect(total(serverEvents, 'received')).toBe(requestBytes);
    expect(total(serverEvents, 'sent')).toBe(responseBytes); expect(total(clientEvents, 'received')).toBe(responseBytes);
    expect(kinds(clientEvents, 'sent')).toEqual([K.REQUEST, K.ACK]);
    expect(kinds(serverEvents, 'received')).toEqual([K.REQUEST, K.ACK]);
    expect(kinds(clientEvents, 'received')).toEqual([K.META, K.DATA, K.ASSET_END, K.BATCH_END]);
    expect(clientEvents.filter(e => e.event === 'streamReady')).toEqual([{ event: 'streamReady', elapsedMs: expect.any(Number) }]);
    for (const e of [...clientEvents, ...serverEvents]) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.keys(e).every(key => ['event', 'direction', 'byteLength', 'frameKind', 'elapsedMs'].includes(key))).toBe(true);
    }
  });

  it('emits no transport success observations when protocol negotiation fails before START', async () => {
    const f = fixture(), events: ExactBatchTransportEvent[] = [];
    f.dial.mockRejectedValue(new Error('unsupported protocol'));
    await expect(exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
      { ...options, assetUals: UALS, onTransportEvent: e => { events.push(e); } }, s => s.next()))
      .rejects.toBeInstanceOf(ExperimentalExactBatchUnsupportedError);
    expect(events).toEqual([]);
  });

  it('counts accepted bytes but no successful START when native drain fails', async () => {
    const f = fixture(), events: ExactBatchTransportEvent[] = [], controller = new AbortController();
    f.client.forceDrain = true;
    const session = new ExactBatchTransportSession(f.client as unknown as Stream, controller.signal, codec,
      { ...options, onTransportEvent: e => { events.push(e); } });
    const outcome = expect(session.send(start())).rejects.toThrow('drain cancelled');
    await f.client.drainEntered.promise;
    expect(events).toEqual([{ event: 'bytes', direction: 'sent', byteLength: codec.encode(start()).byteLength }]);
    controller.abort(new Error('drain cancelled')); await outcome;
    expect(events.some(e => e.event === 'frame')).toBe(false); await session.dispose();
  });

  it('counts partial EOF and oversized rejected raw chunks without inventing a decoded frame or relaxing the cap', async () => {
    for (const oversize of [false, true]) {
      const f = fixture(), events: ExactBatchTransportEvent[] = [];
      const bytes = codec.encode(frame(K.META, 0, 0, new Uint8Array(100))).subarray(0, oversize ? 116 : 19);
      f.client.push(bytes); f.client.ended = true;
      const session = new ExactBatchTransportSession(f.client as unknown as Stream, new AbortController().signal, codec,
        { ...options, ...(oversize ? { maxResponseBytes: 20 } : {}), onTransportEvent: e => { events.push(e); } });
      await expect(session.next()).rejects.toThrow(oversize ? 'wire byte limit' : 'Truncated');
      expect(events).toEqual([{ event: 'bytes', direction: 'received', byteLength: bytes.byteLength }]);
      await session.dispose();
    }
  });

  it('synchronous and asynchronous observer errors cannot fail or delay sync', async () => {
    for (const asynchronous of [false, true]) {
      const f = fixture();
      const onTransportEvent = () => {
        if (asynchronous) return Promise.reject(new Error('observer rejected'));
        throw new Error('observer threw');
      };
      registerExperimentalExactBatchResponder(f.routerServer, codec, { ...options, onTransportEvent }, async () => UALS,
        async (_request, session) => { await session.send(frame(K.BATCH_END, 255, 10)); });
      expect(await exchangeExperimentalExactBatch(f.routerClient, PEER, start(), codec,
        { ...options, assetUals: UALS, onTransportEvent }, s => s.next())).toEqual(frame(K.BATCH_END, 255, 10));
      await f.settled(); expect(f.client.status).toBe('closed');
    }
  });
});
