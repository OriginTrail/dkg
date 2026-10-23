import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, UnsupportedProtocolError } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import { LibP2PNetwork } from '../src/network/libp2p-network.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import { exchangeBulkGraph, registerBulkGraphResponder, bulkGraphTransportOptions } from '../src/bulk-graph-transport.js';
import { BULK_GRAPH_KIND as K } from '../src/bulk-graph-wire.js';
import {
  CONNECTION_MONITOR_MAX_PING_TIMEOUT_MS,
  CONNECTION_MONITOR_MIN_PING_TIMEOUT_MS,
  CONNECTION_MONITOR_PING_INTERVAL_MS,
  connectionMonitorOptions,
} from '../src/connection-monitor-policy.js';

const nodes: DKGNode[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const node of nodes) await node.stop();
  nodes.length = 0;
});

/** Capture each node's connection monitor tick; the real timers keep running. */
function captureMonitorTicks(): (() => void)[] {
  const ticks: (() => void)[] = [];
  const originalInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === CONNECTION_MONITOR_PING_INTERVAL_MS) ticks.push(callback);
    return originalInterval(callback, delay, ...args);
  }) as typeof setInterval);
  return ticks;
}

async function startPair(): Promise<{ source: DKGNode; client: DKGNode; ticks: (() => void)[] }> {
  const ticks = captureMonitorTicks();
  const source = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  const client = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  nodes.push(source, client);
  await source.start();
  await client.start();
  // One monitor per node, at our interval: the options reached libp2p.
  expect(ticks).toHaveLength(2);
  return { source, client, ticks };
}

describe('connection monitor policy', () => {
  it('never lets one connection have two monitor pings open', () => {
    expect(connectionMonitorOptions()).toEqual({
      pingInterval: CONNECTION_MONITOR_PING_INTERVAL_MS,
      pingTimeout: { minTimeout: CONNECTION_MONITOR_MIN_PING_TIMEOUT_MS, maxTimeout: CONNECTION_MONITOR_MAX_PING_TIMEOUT_MS },
      abortConnectionOnPingFailure: true,
    });
    expect(CONNECTION_MONITOR_MAX_PING_TIMEOUT_MS).toBeLessThan(CONNECTION_MONITOR_PING_INTERVAL_MS);
    // Event-loop stalls of 13 to 15 s were measured on relays.
    expect(CONNECTION_MONITOR_MIN_PING_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  it("keeps the connection and its active bulk stream when a ping answers after libp2p's default timeout", async () => {
    const { source, client, ticks } = await startPair();
    // The client answers 6 s late, as a peer in an event-loop stall does:
    // past libp2p's default 5 s minimum, inside ours.
    const pingService = client.libp2p.services.ping as unknown as {
      handlePing: Parameters<typeof client.libp2p.handle>[1];
    };
    await client.libp2p.unhandle('/ipfs/ping/1.0.0');
    await client.libp2p.handle('/ipfs/ping/1.0.0', async (stream, connection) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await pingService.handlePing(stream, connection);
    }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
    const releaseExport = Promise.withResolvers<void>();
    const bulkEntered = Promise.withResolvers<void>();
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
      bulkGraphTransportOptions(15_000), session => session.next());
    const observedBulk = bulk.then(value => ({ value }), error => ({ error }));
    try {
      await bulkEntered.promise;
      const connection = source.libp2p.getConnections()[0]!;
      const abort = vi.spyOn(connection, 'abort');

      ticks[0]!();
      // Under libp2p's default the monitor aborts the connection at 5 s.
      await vi.waitFor(() => expect(connection.rtt !== undefined || connection.status !== 'open').toBe(true), { timeout: 10_000, interval: 100 });
      expect(abort).not.toHaveBeenCalled();
      expect(connection.status).toBe('open');
      expect(connection.rtt).toBeGreaterThanOrEqual(5_500);

      releaseExport.resolve();
      expect(await observedBulk).toEqual({ value: { kind: K.DATA, index: 0, sequence: 0, payload: new Uint8Array([42]) } });
    } finally {
      releaseExport.resolve();
      await observedBulk;
    }
  }, 20_000);

  it.each([
    { error: new UnsupportedProtocolError('peer has no ping handler'), closes: false },
    { error: new TimeoutError('real failed health probe'), closes: true },
  ])('still aborts a connection whose ping really fails ($error.name closes: $closes)', async ({ error, closes }) => {
    const { source, client, ticks } = await startPair();
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
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(abort).not.toHaveBeenCalled();
      expect(connection.status).toBe('open');
    }
  }, 10_000);
});
