import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import { DKGNode } from '../src/node.js';
import { LibP2PNetwork } from '../src/network/libp2p-network.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import {
  EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL as PROTOCOL,
  exchangeExperimentalExactBatch, registerExperimentalExactBatchResponder,
  type ExactBatchTransportOptions,
  type ExactBatchTransportSession,
} from '../src/experimental-exact-batch-stream.js';
import { EXACT_BATCH_FRAME_KIND as K, type ExactBatchFrame } from '../src/experimental-exact-batch-wire.js';

const enc = new TextEncoder();
const UALS = Array.from({ length: 10 }, (_, i) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i + 1}`).sort();
const options: ExactBatchTransportOptions = { timeoutMs: 5000, windowSize: 2,
  maxReadBufferBytes: 65552, maxRequestBytes: 8192, maxFrameBytes: 65552, maxResponseBytes: 42 * 1024 * 1024 };
const frame = (kind: number, assetIndex = 255, sequence = 0, payload = new Uint8Array()): ExactBatchFrame => ({ kind, assetIndex, sequence, payload });
const start = () => frame(K.REQUEST, 255, 0, enc.encode('opaque signed START fixture'));
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
// Observe a private owned resource in tests without adding a raw-stream API.
const physical = (session: ExactBatchTransportSession): Stream => (session as unknown as { stream: Stream }).stream;

/** Real encrypted sockets, fixture proofs/writes. No agent/store/chain runtime. */
describe('experimental exact-batch production router over libp2p Noise loopback', () => {
  const nodes: DKGNode[] = [];
  afterEach(async () => { for (const node of nodes) await node.stop(); nodes.length = 0; });

  async function pair() {
    const a = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    const b = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(a, b); await a.start(); await b.start();
    const network = new LibP2PNetwork(a);
    const resolve = vi.fn(async () => {
      await network.addKnownAddresses(b.peerId, [b.multiaddrs[0]!]); return [b.multiaddrs[0]!];
    });
    const accepted = vi.fn(async () => true);
    const routerA = new ProtocolRouter(a, { network, peerResolver: { resolve } as unknown as PeerResolver,
      isPeerAccepted: accepted, isPeerKnownRejected: () => false });
    const routerB = new ProtocolRouter(b, { isPeerAccepted: accepted, isPeerKnownRejected: () => false });
    return { a, b, routerA, routerB, resolve, accepted };
  }

  it('streams ten opaque payloads and caller ACKs over the fixed wire contract', async () => {
    const f = await pair();
    const bodies = UALS.map((_, index) => enc.encode(`opaque payload ${index} ${"bytes ".repeat(30)}`));
    const acknowledgments: number[] = [];
    const received: Uint8Array[] = [];
    registerExperimentalExactBatchResponder(f.routerB, options,
      async request => { expect(request).toEqual(start().payload); return UALS; },
      async (_request, session) => {
        const ack = async () => {
          const item = await session.next();
          expect(item).toEqual(frame(K.ACK, acknowledgments.length, 1));
          acknowledgments.push(item!.assetIndex);
        };
        for (let index = 0; index < UALS.length; index++) {
          while (index - acknowledgments.length >= session.windowSize) await ack();
          await session.send(frame(K.META, index, 0, new Uint8Array([index])));
          await session.send(frame(K.DATA, index, 0, bodies[index]));
          await session.send(frame(K.ASSET_END, index, 1));
        }
        while (acknowledgments.length < UALS.length) await ack();
        await session.send(frame(K.BATCH_END, 255, UALS.length));
      });
    const count = await exchangeExperimentalExactBatch(f.routerA, f.b.peerId, start(),
      { ...options, assetUals: UALS }, async session => {
        let index = 0;
        while (index < UALS.length) {
          expect(await session.next()).toEqual(frame(K.META, index, 0, new Uint8Array([index])));
          if (index === 1) {
            expect(acknowledgments).toEqual([]);
            await session.send(frame(K.ACK, 0, 1));
          }
          const body = await session.next();
          expect(body).toEqual(frame(K.DATA, index, 0, bodies[index]));
          received.push(body!.payload);
          expect(await session.next()).toEqual(frame(K.ASSET_END, index, 1));
          if (index > 0) await session.send(frame(K.ACK, index, 1));
          index++;
        }
        expect(await session.next()).toEqual(frame(K.BATCH_END, 255, UALS.length));
        return index;
      });
    expect(count).toBe(10); expect(received).toEqual(bodies);
    expect(acknowledgments).toEqual(Array.from({ length: 10 }, (_, index) => index));
    const connections = f.a.libp2p.getConnections().filter(c => c.remotePeer.toString() === f.b.peerId);
    expect(connections).toHaveLength(1); expect(connections[0]!.encryption).toBe('/noise');
    expect(connections[0]!.streams.filter(s => s.protocol === PROTOCOL)).toHaveLength(0);
    expect(getEventListeners(f.a.stopSignal!, 'abort')).toHaveLength(0);
  }, 15000);

  it('deadline aborts both native stream owners and retires the decoder before rejection', async () => {
    const f = await pair(), entered = gate(), responded = gate();
    let clientStream!: Stream, serverStream!: Stream;
    registerExperimentalExactBatchResponder(f.routerB, options, async () => UALS,
      async (_request, session) => { serverStream = physical(session); entered.resolve();
        try { await session.next(); } finally { responded.resolve(); } });
    const operation = exchangeExperimentalExactBatch(f.routerA, f.b.peerId, start(),
      { ...options, timeoutMs: 150, assetUals: UALS }, async session => { clientStream = physical(session); return session.next(); });
    const outcome = expect(operation).rejects.toThrow('timeout');
    await entered.promise; await outcome; await responded.promise;
    expect(clientStream.status).toBe('aborted');
    await vi.waitFor(() => expect(serverStream.status).not.toBe('open'));
    expect(getEventListeners(f.a.stopSignal!, 'abort')).toHaveLength(0);
  }, 15000);

  it('node stop cancels a pending duplex read without ACK or request replay', async () => {
    const f = await pair(), entered = gate(), responded = gate();
    const stopSignal = f.a.stopSignal!;
    let clientStream!: Stream, serverStream!: Stream;
    registerExperimentalExactBatchResponder(f.routerB, options, async () => UALS,
      async (_request, session) => { serverStream = physical(session); entered.resolve();
        try { await session.next(); } finally { responded.resolve(); } });
    const operation = exchangeExperimentalExactBatch(f.routerA, f.b.peerId, start(),
      { ...options, assetUals: UALS }, async session => { clientStream = physical(session); return session.next(); });
    const outcome = expect(operation).rejects.toThrow();
    await entered.promise; await f.a.stop(); await outcome; await responded.promise;
    expect(clientStream.status).not.toBe('open'); expect(serverStream.status).not.toBe('open');
    expect(f.a.isStarted).toBe(false);
    expect(getEventListeners(stopSignal, 'abort')).toHaveLength(0);
  }, 15000);
});
