import { afterEach, expect, it, vi } from 'vitest';
import { TooManyOutboundProtocolStreamsError, TimeoutError, UnsupportedProtocolError } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import { LibP2PNetwork } from '../src/network/libp2p-network.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import { exchangeBulkGraph, registerBulkGraphResponder, bulkGraphTransportOptions } from '../src/bulk-graph-transport.js';
import { BULK_GRAPH_KIND as K } from '../src/bulk-graph-wire.js';

const nodes: DKGNode[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const node of nodes) await node.stop();
  nodes.length = 0;
});

it('keeps an active bulk stream when the health monitor overlaps an existing ping', async () => {
  // Capture only the real monitor tick, leaving socket and stream deadlines real.
  const ticks: (() => void)[] = [];
  const originalInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 10_000) ticks.push(callback);
    return originalInterval(callback, delay, ...args);
  }) as typeof setInterval);
  const source = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  const client = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  nodes.push(source, client);
  await source.start(); await client.start();
  expect(ticks).toHaveLength(2);
  const pingEntered = Promise.withResolvers<void>();
  const releasePing = Promise.withResolvers<void>();
  const releaseExport = Promise.withResolvers<void>();
  const bulkEntered = Promise.withResolvers<void>();
  const pingService = client.libp2p.services.ping as unknown as {
    handlePing: Parameters<typeof client.libp2p.handle>[1];
  };
  await client.libp2p.unhandle('/ipfs/ping/1.0.0');
  await client.libp2p.handle('/ipfs/ping/1.0.0', async (stream, connection) => {
    pingEntered.resolve();
    await releasePing.promise;
    await pingService.handlePing(stream, connection);
  }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
  const network = new LibP2PNetwork(client);
  await network.addKnownAddresses(source.peerId, [source.multiaddrs[0]!]);
  const receiver = new ProtocolRouter(client, { network, isPeerAccepted: async () => true });
  const sender = new ProtocolRouter(source, { isPeerAccepted: async () => true });
  registerBulkGraphResponder(sender, async () => undefined, async (_request, session) => {
    bulkEntered.resolve();
    await releaseExport.promise;
    await session.send({ kind: K.DATA, index: 0, sequence: 0, payload: new Uint8Array([42]) });
  });
  const bulk = exchangeBulkGraph(receiver, source.peerId, new Uint8Array([1]),
    bulkGraphTransportOptions(5_000), session => session.next());
  const observedBulk = bulk.then(value => ({ value }), error => ({ error }));
  await bulkEntered.promise;
  const connection = source.libp2p.getConnections()[0]!;
  const abort = vi.spyOn(connection, 'abort');
  const ping = source.libp2p.services.ping.ping(connection.remotePeer, { signal: AbortSignal.timeout(3_000) });
  const observedPing = ping.catch(error => error);
  try {
    await pingEntered.promise;
    await vi.waitFor(() => expect(connection.streams.filter(stream =>
      stream.protocol === '/ipfs/ping/1.0.0' && stream.direction === 'outbound')).toHaveLength(1));
    const openStream = vi.spyOn(connection, 'newStream');
    ticks[0]!();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(openStream).not.toHaveBeenCalled();
    expect(abort.mock.calls.map(([error]) => error?.name)).toEqual([]);
    expect(connection.status).toBe('open');
    releasePing.resolve(); releaseExport.resolve();
    expect(await observedPing).toEqual(expect.any(Number));
    expect(await observedBulk).toEqual({ value: { kind: K.DATA, index: 0, sequence: 0, payload: new Uint8Array([42]) } });
  } finally {
    releasePing.resolve(); releaseExport.resolve();
    await observedPing; await observedBulk;
  }
}, 10_000);

it.each([
  { error: new TooManyOutboundProtocolStreamsError('local negotiation race'), closes: false },
  { error: new UnsupportedProtocolError('peer has no ping handler'), closes: false },
  { error: new TimeoutError('real failed health probe'), closes: true },
])('handles $error.name without weakening failed-ping teardown', async ({ error, closes }) => {
  const ticks: (() => void)[] = [];
  const originalInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 10_000) ticks.push(callback);
    return originalInterval(callback, delay, ...args);
  }) as typeof setInterval);
  const source = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  const client = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  nodes.push(source, client);
  await source.start(); await client.start();
  await client.libp2p.dial(multiaddr(source.multiaddrs[0]!));
  await vi.waitFor(() => expect(source.libp2p.getConnections()).toHaveLength(1));
  const connection = source.libp2p.getConnections()[0]!;
  const abort = vi.spyOn(connection, 'abort');
  const openStream = vi.spyOn(connection, 'newStream').mockRejectedValueOnce(error);
  ticks[0]!();
  await vi.waitFor(() => expect(openStream).toHaveBeenCalledOnce());
  if (closes) {
    await vi.waitFor(() => expect(abort).toHaveBeenCalledExactlyOnceWith(error));
    expect(connection.status).toBe('aborted');
  } else {
    expect(abort).not.toHaveBeenCalled();
    expect(connection.status).toBe('open');
    // The next normal monitor tick still performs a real wire ping.
    ticks[0]!();
    await vi.waitFor(() => expect(openStream).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(connection.streams.some(stream => stream.protocol === '/ipfs/ping/1.0.0')).toBe(false));
    expect(abort).not.toHaveBeenCalled();
    expect(connection.status).toBe('open');
  }
}, 10_000);
