import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stream } from '@libp2p/interface';
import { DKGNode } from '@origintrail-official/dkg-core';
import { LibP2PNetwork } from '@origintrail-official/dkg-core';
import type { PeerResolver } from '@origintrail-official/dkg-core';
import { ProtocolRouter } from '@origintrail-official/dkg-core';
import {
  EXPERIMENTAL_EXACT_BATCH_STREAM_PROTOCOL as PROTOCOL,
  exchangeExperimentalExactBatch, registerExperimentalExactBatchResponder,
  ExperimentalExactBatchUnsupportedError, type ExactBatchTransportOptions,
  type ExactBatchTransportSession,
} from '@origintrail-official/dkg-core';
import {
  EXACT_BATCH_FRAME_KIND as K, ExactBatchReceiveWindow, ExactBatchSendWindow,
  decodeExactBatchAsset, type ExactBatchFrame,
} from '../src/sync/exact-batch-stream-contract.js';
import { encodeNegotiatedExactSyncResponse, EXACT_SYNC_GZIP_ENCODING } from '../src/sync/wire-compression.js';

const enc = new TextEncoder();
const UALS = Array.from({ length: 10 }, (_, i) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i + 1}`).sort();
const options: ExactBatchTransportOptions = { timeoutMs: 5000, windowSize: 2,
  maxReadBufferBytes: 65552, maxRequestBytes: 8192, maxFrameBytes: 65552, maxResponseBytes: 42 * 1024 * 1024 };
const frame = (kind: number, assetIndex = 255, sequence = 0, payload = new Uint8Array()): ExactBatchFrame => ({ kind, assetIndex, sequence, payload });
const start = () => frame(K.REQUEST, 255, 0, enc.encode('opaque signed START fixture'));
const root = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
// Observe a private owned resource in tests without adding a raw-stream API.
const physical = (session: ExactBatchTransportSession): Stream => (session as unknown as { stream: Stream }).stream;

/** Real encrypted sockets with Agent compression/windows and fixture proofs/writes. */
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

  it('registers only explicitly, then flushes all ten gzip assets, verified ACKs and BATCH_END on one Noise stream', async () => {
    const f = await pair();
    expect(f.a.libp2p.getProtocols()).not.toContain(PROTOCOL);
    expect(f.b.libp2p.getProtocols()).not.toContain(PROTOCOL);
    await expect(exchangeExperimentalExactBatch(f.routerA, f.b.peerId, start(),
      { ...options, assetUals: UALS }, s => s.next())).rejects.toBeInstanceOf(ExperimentalExactBatchUnsupportedError);
    expect(f.b.libp2p.getProtocols()).not.toContain(PROTOCOL);

    const bodies = UALS.map((_, i) => enc.encode(`<urn:asset:${i}> <urn:payload> "${'compressible unchanged N-Quads '.repeat(1000)}" .\n`));
    const written = new Map<string, Uint8Array>(), exports = Array(10).fill(0), acknowledgments: number[] = [];
    const releaseFirst = gate();
    let clientStream!: Stream, serverStream!: Stream;
    registerExperimentalExactBatchResponder(f.routerB, options,
      async bytes => { expect(bytes).toEqual(start().payload); return UALS; },
      async (_request, session) => {
        serverStream = physical(session);
        const window = new ExactBatchSendWindow({ assetCount: UALS.length, windowSize: 2 });
        const ack = async () => {
          const item = await session.next(); expect(item?.kind).toBe(K.ACK);
          window.acceptAck(item!); acknowledgments.push(item!.assetIndex);
          expect(written.has(UALS[item!.assetIndex]!)).toBe(true);
        };
        for (let index = 0; index < UALS.length; index++) {
          while (!window.canStartAsset) await ack();
          // One fixture export/compression per KA, never per frame.
          exports[index]++;
          const body = await encodeNegotiatedExactSyncResponse(bodies[index]!, { request: {
            responseEncoding: EXACT_SYNC_GZIP_ENCODING, phase: 'data', assetUals: [UALS[index]!] }, signal: session.signal });
          expect(body.byteLength).toBeLessThan(bodies[index]!.byteLength);
          let sequence = 0;
          const send = async (item: ExactBatchFrame) => { window.acceptSent(item); await session.send(item); };
          await send(frame(K.META, index, 0, enc.encode(JSON.stringify({ ual: UALS[index], root: root(bodies[index]!) }))));
          for (let offset = 0; offset < body.byteLength; offset += 23) await send(frame(K.DATA, index, sequence++, body.subarray(offset, offset + 23)));
          await send(frame(K.ASSET_END, index, sequence));
        }
        while (window.acknowledgedCount < UALS.length) await ack();
        const end = frame(K.BATCH_END, 255, UALS.length); window.acceptSent(end); await session.send(end);
        expect(window.complete).toBe(true);
      });
    expect(f.b.libp2p.getProtocols()).toContain(PROTOCOL);
    const committed = await exchangeExperimentalExactBatch(f.routerA, f.b.peerId, start(),
      { ...options, assetUals: UALS }, async session => {
        clientStream = physical(session);
        const window = new ExactBatchReceiveWindow({ assetUals: session.assetUals, windowSize: 2 });
        let committing: Promise<void> | undefined;
        const kick = () => {
          if (committing) return;
          const asset = window.takeReady(); if (!asset) return;
          committing = window.commitAsset(asset, async owned => {
            if (owned.assetIndex === 0) await releaseFirst.promise;
            const decoded = await decodeExactBatchAsset(owned, { signal: session.signal });
            const proof = JSON.parse(new TextDecoder().decode(owned.metadataBytes));
            expect(proof.ual).toBe(owned.assetUal); expect(proof.root).toBe(root(decoded.bytes));
            written.set(owned.assetUal, decoded.bytes);
          }, { signal: session.signal }).then(ack => session.send(ack)).finally(() => { committing = undefined; kick(); });
        };
        try {
          while (true) {
            const item = await session.next(); expect(item).toBeDefined(); window.accept(item!);
            if (item!.kind === K.META && item!.assetIndex === 1) {
              expect(written.size).toBe(0); expect(acknowledgments).toEqual([]); releaseFirst.resolve();
            }
            kick(); if (item!.kind === K.BATCH_END) break;
          }
          await committing; expect(window.complete).toBe(true); return window.committedCount;
        } finally { await window.close(); }
      });
    expect(committed).toBe(10); expect(exports).toEqual(Array(10).fill(1));
    expect(acknowledgments).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(clientStream.status).toBe('closed');
    await vi.waitFor(() => expect(serverStream.status).toBe('closed'));
    const connections = f.a.libp2p.getConnections().filter(c => c.remotePeer.toString() === f.b.peerId);
    expect(connections).toHaveLength(1); expect(connections[0]!.encryption).toBe('/noise');
    expect(connections[0]!.streams.filter(s => s.protocol === PROTOCOL)).toHaveLength(0);
    expect(getEventListeners(f.a.stopSignal!, 'abort')).toHaveLength(0);
  }, 15000);

});
