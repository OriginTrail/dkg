import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { ping, PING_PROTOCOL } from '@libp2p/ping';
import { coordinatedPing } from '../src/coordinated-ping.js';
import { pingConnection } from '../src/ping-transport.js';

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

  async function pair(timeoutMs = 1_000, intervalMs = 25, stockResponder = false, options: Parameters<typeof coordinatedPing>[0] = {}) {
    const remote = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
      services: { ping: ping() }, connectionMonitor: { enabled: false },
    });
    nodes.push(remote);
    const local = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
      services: { ping: coordinatedPing({ intervalMs, minTimeoutMs: timeoutMs, maxTimeoutMs: timeoutMs, ...options }) },
      connectionMonitor: { enabled: false },
    });
    nodes.push(local);
    const gate = deferred();
    const entered = deferred();
    releases.push(gate.resolve);
    let receivedStreams = 0;
    if (!stockResponder) {
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
    }
    const connection = await local.dial(remote.getMultiaddrs());
    return { local, remote, connection, gate, entered, receivedStreams: () => receivedStreams };
  }

  async function holdFirstFin(remote: Libp2p) {
    const fin = deferred();
    const localClosed = deferred();
    releases.push(fin.resolve);
    let streams = 0;
    await remote.unhandle(PING_PROTOCOL);
    await remote.handle(PING_PROTOCOL, async (stream) => {
      const first = ++streams === 1;
      for await (const data of stream) stream.send(data);
      if (first) {
        localClosed.resolve();
        await fin.promise;
      }
      if (stream.status === 'open') await stream.close();
    }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
    return { fin, localClosed, streams: () => streams };
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

  it.each([true, false])('holds the stream until remote FIN with runOnLimitedConnection=%s on the next caller', async (runOnLimitedConnection) => {
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
    const second = local.services.ping.ping(remote.peerId, { runOnLimitedConnection });
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

  it('uses a fresh cleanup deadline after a valid pong and keeps the slot until FIN', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection } = await pair(300, 25, false, { cleanupTimeoutMs: 1_500, onDiagnostic: diagnostic });
    const { fin, localClosed, streams } = await holdFirstFin(remote);
    const first = local.services.ping.ping(remote.peerId);
    await localClosed.promise;
    const second = local.services.ping.ping(remote.peerId, { runOnLimitedConnection: false });
    // The liveness deadline has expired, but a pong was already validated.
    // Repeated monitor ticks must still share the flight awaiting FIN.
    await pause(350);
    expect(connection.status).toBe('open');
    expect(streams()).toBe(1);
    expect(connection.streams.filter((stream) => stream.protocol === PING_PROTOCOL && stream.direction === 'outbound')).toHaveLength(1);
    expect(diagnostic).not.toHaveBeenCalled();
    fin.resolve();
    expect((await Promise.all([first, second])).every((rtt) => rtt >= 0)).toBe(true);
    expect(connection.status).toBe('open');
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('resets only a ping stream with a missing FIN, then admits the next queued probe', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection } = await pair(1_000, 60_000, false, { cleanupTimeoutMs: 150, onDiagnostic: diagnostic });
    const { localClosed, streams } = await holdFirstFin(remote);
    const first = local.services.ping.ping(remote.peerId);
    await localClosed.promise;
    const shared = local.services.ping.ping(remote.peerId);
    const queued = local.services.ping.ping(remote.peerId, { runOnLimitedConnection: false });
    const [rtt, sharedRtt, queuedRtt] = await Promise.all([first, shared, queued]);
    expect(rtt).toBe(sharedRtt);
    expect(queuedRtt).toBeGreaterThanOrEqual(0);
    expect(streams()).toBe(2);
    expect(connection.status).toBe('open');
    expect(connection.streams.filter((stream) => stream.protocol === PING_PROTOCOL && stream.direction === 'outbound')).toHaveLength(0);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      connectionId: connection.id, phase: 'cleanup', action: 'reset-stream',
      pongReceived: true, timeoutMs: 150, error: 'TimeoutError',
    }));
    // Subsequent probes and both directions remain usable on this connection.
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(await remote.services.ping.ping(local.peerId)).toBeGreaterThanOrEqual(0);
    expect(local.getConnections(remote.peerId)[0].id).toBe(connection.id);
  });

  it('does not let a failing diagnostics sink tear down a live connection after cleanup timeout', async () => {
    const { local, remote, connection } = await pair(1_000, 60_000, false, {
      cleanupTimeoutMs: 50, onDiagnostic: () => { throw new Error('diagnostics failed'); },
    });
    await holdFirstFin(remote);
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(connection.status).toBe('open');
  });

  it('conforms to the stock responder and releases its physical stream before returning', async () => {
    const { local, remote, connection } = await pair(1_000, 60_000, true);
    const elapsed = await pingConnection(connection, { signal: AbortSignal.timeout(1_000), runOnLimitedConnection: true });
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(connection.streams.filter((stream) => stream.protocol === PING_PROTOCOL && stream.direction === 'outbound')).toHaveLength(0);
    // The next coordinated ping immediately reuses the one-stream slot, while
    // canonical outbound ping exercises the unchanged inbound responder.
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(await remote.services.ping.ping(local.peerId)).toBeGreaterThanOrEqual(0);
    expect(connection.status).toBe('open');
  });

  it('passes stream options and delivers opening progress to every coalesced caller', async () => {
    const { local, remote, connection, entered, gate, receivedStreams } = await pair(1_000, 60_000);
    const newStream = vi.spyOn(connection, 'newStream');
    const early: string[] = [];
    const late: string[] = [];
    const policy = { runOnLimitedConnection: false, negotiateFully: false, maxOutboundStreams: 1 };
    const first = local.services.ping.ping(remote.peerId, { ...policy, onProgress: (event) => early.push(event.type) });
    await entered.promise;
    const second = local.services.ping.ping(remote.peerId, { ...policy, onProgress: (event) => late.push(event.type) });
    await vi.waitFor(() => expect(late).toContain('connection:opened-stream'));
    gate.resolve();
    expect((await Promise.all([first, second]))[0]).toBeGreaterThanOrEqual(0);
    expect(newStream).toHaveBeenCalledWith(PING_PROTOCOL, expect.objectContaining({ ...policy, onProgress: expect.any(Function) }));
    expect(early.filter((type) => type.startsWith('connection:'))).toEqual(['connection:open', 'connection:opened', 'connection:open-stream', 'connection:opened-stream']);
    expect(late.filter((type) => type.startsWith('connection:'))).toEqual(['connection:open', 'connection:opened', 'connection:open-stream', 'connection:opened-stream']);
    expect(receivedStreams()).toBe(1);
  });

  it('rejects caller-excluded limited connections without sending ping traffic or killing liveness', async () => {
    const { local, remote, connection, gate, receivedStreams } = await pair(1_000, 60_000);
    connection.limits = { seconds: 60 };
    await expect(local.services.ping.ping(remote.peerId, { runOnLimitedConnection: false }))
      .rejects.toMatchObject({ name: 'LimitedConnectionError' });
    expect(receivedStreams()).toBe(0);
    expect(connection.status).toBe('open');
    gate.resolve();
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(receivedStreams()).toBe(1);
    expect(connection.status).toBe('open');
  });

  it('aborts a genuinely silent connection within the shared probe deadline', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection } = await pair(150, 25, false, { onDiagnostic: diagnostic });
    const started = Date.now();
    const result = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    const outcome = await result;
    expect(outcome).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connection.status).not.toBe('open');
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      phase: 'echo', action: 'abort-connection', pongReceived: false, error: 'TimeoutError',
    }));
  });

  it('adapts beyond the minimum deadline while bounding silent-peer failure at the maximum', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection, gate } = await pair(200, 60_000, false, {
      minTimeoutMs: 200, maxTimeoutMs: 350, onDiagnostic: diagnostic,
    });
    // A real timeout trains the shared adaptive estimator. On the replacement
    // connection, a healthy echo slower than the minimum must still succeed.
    await expect(local.services.ping.ping(remote.peerId)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(connection.status).not.toBe('open');
    gate.resolve();
    await remote.unhandle(PING_PROTOCOL);
    await remote.handle(PING_PROTOCOL, async (stream) => {
      for await (const data of stream) {
        await pause(260);
        if (stream.status !== 'open') return;
        stream.send(data);
      }
      await stream.close();
    }, { maxInboundStreams: 2, maxOutboundStreams: 1 });
    const replacement = await local.dial(remote.getMultiaddrs());
    const newStream = vi.spyOn(replacement, 'newStream');
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(200);
    expect(newStream).toHaveBeenCalledWith(PING_PROTOCOL, expect.objectContaining({ signal: expect.objectContaining({ timeout: 350 }) }));
    expect(replacement.status).toBe('open');

    const silent = deferred();
    releases.push(silent.resolve);
    await remote.unhandle(PING_PROTOCOL);
    await remote.handle(PING_PROTOCOL, async () => { await silent.promise; });
    const startedAt = performance.now();
    await expect(local.services.ping.ping(remote.peerId)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(replacement.status).not.toBe('open');
    expect(diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'abort-connection', pongReceived: false, timeoutMs: 350,
    }));
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

  it('resets a sole cancelled ping without closing the connection at its former deadline', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection, entered, gate } = await pair(150, 60_000, false, { onDiagnostic: diagnostic });
    const controller = new AbortController();
    const cancelled = local.services.ping.ping(remote.peerId, { signal: controller.signal }).catch((error) => error);
    await entered.promise;
    const abort = vi.spyOn(connection, 'abort');
    const reason = new Error('explicit ping cancelled');
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    await vi.waitFor(() => expect(connection.streams.filter((stream) => stream.protocol === PING_PROTOCOL && stream.direction === 'outbound')).toHaveLength(0));
    await pause(200);
    expect(abort).not.toHaveBeenCalled();
    expect(connection.status).toBe('open');
    expect(diagnostic).not.toHaveBeenCalled();
    gate.resolve();
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(local.getConnections(remote.peerId)[0].id).toBe(connection.id);
  });

  it('cancels a sole observer during post-pong cleanup and frees the slot for the next ping', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection } = await pair(1_000, 60_000, false, { cleanupTimeoutMs: 60_000, onDiagnostic: diagnostic });
    const { localClosed } = await holdFirstFin(remote);
    const controller = new AbortController();
    const cancelled = local.services.ping.ping(remote.peerId, { signal: controller.signal }).catch((error) => error);
    await localClosed.promise;
    const reason = new Error('caller no longer needs cleanup');
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(await local.services.ping.ping(remote.peerId)).toBeGreaterThanOrEqual(0);
    expect(connection.status).toBe('open');
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('stops and drains an unfinished probe without waiting for its deadline', async () => {
    const { local, remote, connection, entered } = await pair(60_000);
    const newStream = vi.spyOn(connection, 'newStream');
    const pending = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    await entered.promise;
    const queued = local.services.ping.ping(remote.peerId, { runOnLimitedConnection: false }).catch((error: Error) => error);
    await pause(10);
    const started = Date.now();
    await local.stop();
    expect(await pending).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(newStream).toHaveBeenCalledTimes(1);
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

  it('cancels and drains a post-pong cleanup promptly when the service stops', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection } = await pair(1_000, 60_000, false, { cleanupTimeoutMs: 60_000, onDiagnostic: diagnostic });
    const { localClosed } = await holdFirstFin(remote);
    const pending = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    await localClosed.promise;
    const queued = local.services.ping.ping(remote.peerId, { runOnLimitedConnection: false }).catch((error: Error) => error);
    const abort = vi.spyOn(connection, 'abort');
    const started = Date.now();
    await local.services.ping.stop();
    expect(await pending).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(abort).not.toHaveBeenCalled();
    expect(connection.status).toBe('open');
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('rejects a connection closed during post-pong cleanup without returning stale success', async () => {
    const diagnostic = vi.fn();
    const { local, remote, connection } = await pair(1_000, 60_000, false, { cleanupTimeoutMs: 60_000, onDiagnostic: diagnostic });
    const { localClosed } = await holdFirstFin(remote);
    const pending = local.services.ping.ping(remote.peerId).catch((error: Error) => error);
    await localClosed.promise;
    connection.abort(new Error('connection replaced during cleanup'));
    expect(await pending).toMatchObject({ name: 'ConnectionClosedError' });
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('rejects unsupported explicit pings without fabricating an RTT or closing a responsive connection', async () => {
    const { local, remote, connection } = await pair();
    await remote.unhandle(PING_PROTOCOL);
    const previousRtt = connection.rtt;
    await expect(local.services.ping.ping(remote.peerId)).rejects.toMatchObject({ name: 'UnsupportedProtocolError' });
    await pause(100); // The monitor must also accept negotiation as liveness.
    expect(connection.rtt).toBe(previousRtt);
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
