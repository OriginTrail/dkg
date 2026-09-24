import { afterEach, describe, expect, it } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { ping, PING_PROTOCOL } from '@libp2p/ping';
import { coordinatedPing } from '../src/coordinated-ping.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('shared connection ping', () => {
  const nodes: Libp2p[] = [];
  const releases: Array<() => void> = [];

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    await Promise.all(nodes.splice(0).map((node) => node.stop()));
  });

  async function pair(timeoutMs = 1_000) {
    const remote = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
      services: { ping: ping() }, connectionMonitor: { enabled: false },
    });
    nodes.push(remote);
    const local = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
      services: { ping: coordinatedPing({ intervalMs: 25, minTimeoutMs: timeoutMs, maxTimeoutMs: timeoutMs }) },
      connectionMonitor: { enabled: false },
    });
    nodes.push(local);
    const gate = deferred();
    const entered = deferred();
    releases.push(gate.resolve);
    let receivedStreams = 0;
    await remote.unhandle(PING_PROTOCOL);
    await remote.handle(PING_PROTOCOL, async (stream) => {
      receivedStreams++;
      for await (const data of stream) {
        entered.resolve();
        await gate.promise;
        if (stream.status !== 'open') return;
        stream.send(data);
      }
      await stream.close();
    }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
    const connection = await local.dial(remote.getMultiaddrs());
    return { local, remote, connection, gate, entered, receivedStreams: () => receivedStreams };
  }

  it('shares a slow health probe with other callers and multiple monitor ticks under the one-stream limit', async () => {
    const { local, remote, connection, gate, entered, receivedStreams } = await pair();
    const first = local.services.ping.ping(remote.peerId);
    await entered.promise;
    const second = local.services.ping.ping(remote.peerId);
    await pause(100); // Four monitor ticks must join the same unfinished probe.
    expect(connection.status).toBe('open');
    expect(receivedStreams()).toBe(1);
    expect(connection.streams.filter((stream) => stream.protocol === PING_PROTOCOL && stream.direction === 'outbound')).toHaveLength(1);
    gate.resolve();
    const times = await Promise.all([first, second]);
    expect(times[0]).toBe(times[1]);
    expect(times[0]).toBeGreaterThanOrEqual(0);
    // Completion releases the protocol slot, including the remote close handshake.
    await local.services.ping.ping(remote.peerId);
    expect(connection.status).toBe('open');
  });

  it('does not overlap monitor probes when no health caller is present', async () => {
    const { connection, gate, entered, receivedStreams } = await pair();
    await entered.promise;
    await pause(100);
    expect(receivedStreams()).toBe(1);
    expect(connection.status).toBe('open');
    gate.resolve();
  });

  it('keeps the shared probe until the remote closes its half of the stream', async () => {
    const { local, remote, connection } = await pair();
    const fin = deferred();
    const localClosed = deferred();
    releases.push(fin.resolve);
    let streams = 0;
    await remote.unhandle(PING_PROTOCOL);
    await remote.handle(PING_PROTOCOL, async (stream) => {
      streams++;
      for await (const data of stream) stream.send(data);
      localClosed.resolve();
      await fin.promise;
      await stream.close();
    }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
    const first = local.services.ping.ping(remote.peerId);
    await localClosed.promise;
    const second = local.services.ping.ping(remote.peerId);
    await pause(100);
    expect(streams).toBe(1);
    expect(connection.status).toBe('open');
    fin.resolve();
    expect((await Promise.all([first, second]))[0]).toBeGreaterThanOrEqual(0);
    await local.services.ping.ping(remote.peerId);
    expect(connection.status).toBe('open');
  });

  it('retains the standard inbound echo while probing the other direction', async () => {
    const { local, remote, gate } = await pair();
    gate.resolve();
    const times = await Promise.all([
      remote.services.ping.ping(local.getMultiaddrs()),
      local.services.ping.ping(remote.peerId),
    ]);
    expect(times.every((time) => time >= 0)).toBe(true);
  });

  it('aborts a genuinely silent connection within the shared probe deadline', async () => {
    const { local, remote, connection } = await pair(150);
    const started = Date.now();
    const result = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    const outcome = await result;
    expect(outcome).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connection.status).not.toBe('open');
  });

  it('cancels one health observer without cancelling another observer or the monitor', async () => {
    const { local, remote, connection, entered, gate, receivedStreams } = await pair();
    const controller = new AbortController();
    const cancelled = local.services.ping.ping(remote.peerId, { signal: controller.signal })
      .catch((error: Error) => error);
    await entered.promise;
    const remaining = local.services.ping.ping(remote.peerId);
    controller.abort(new Error('observer cancelled'));
    expect(await cancelled).toMatchObject({ message: 'observer cancelled' });
    expect(connection.status).toBe('open');
    expect(receivedStreams()).toBe(1);
    gate.resolve();
    expect(await remaining).toBeGreaterThanOrEqual(0);
    expect(connection.status).toBe('open');
  });

  it('stops and drains an unfinished probe without waiting for its deadline', async () => {
    const { local, remote, entered } = await pair(60_000);
    const pending = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    await entered.promise;
    const started = Date.now();
    await local.stop();
    expect(await pending).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not reuse a failed probe when the peer reconnects', async () => {
    const { local, remote, connection, entered, gate } = await pair();
    const pending = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    await entered.promise;
    connection.abort(new Error('connection replaced'));
    expect(await pending).toBeInstanceOf(Error);
    gate.resolve();
    const replacement = await local.dial(remote.getMultiaddrs());
    expect(replacement.id).not.toBe(connection.id);
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(replacement.status).toBe('open');
  });

  it('treats an unsupported ping protocol as evidence that the connection responds', async () => {
    const { local, remote, connection } = await pair();
    await remote.unhandle(PING_PROTOCOL);
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(connection.status).toBe('open');
  });

  it('rejects an incorrect echo and closes the failed connection', async () => {
    const { local, remote, connection } = await pair();
    await remote.unhandle(PING_PROTOCOL);
    await remote.handle(PING_PROTOCOL, async (stream) => {
      for await (const data of stream) {
        const wrong = Uint8Array.from(data.subarray());
        wrong[0] ^= 0xff;
        stream.send(wrong);
      }
      await stream.close();
    }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
    await expect(local.services.ping.ping(remote.peerId)).rejects.toMatchObject({ name: 'ProtocolError' });
    expect(connection.status).not.toBe('open');
  });
});
