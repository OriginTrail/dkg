import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { probeWorkerLiveness, type LivenessProbeResult } from '../src/daemon/liveness-probe.js';
import { startLivenessWatcher, type LivenessObservation, type LivenessRestartSummary } from '../src/daemon/supervisor-liveness.js';

async function withServer(handle: (socket: Socket) => void, run: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    handle(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run((server.address() as { port: number }).port);
    // The peer must observe retirement, rather than cleanup hiding a leaked request.
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 2000 });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const failure = (outcome: LivenessProbeResult['outcome'] = 'deadline'): LivenessProbeResult => ({
  outcome, elapsedMs: 5000, connected: true, headersReceived: false,
});
const healthy = (): LivenessProbeResult => ({
  outcome: 'http_response', elapsedMs: 1, connected: true, headersReceived: true, statusCode: 503,
});

describe('bounded HTTP probe diagnostics', () => {
  it.each([200, 401, 404, 503])('accepts parsed HTTP %i without recording private response data', async (status) => {
    await withServer((socket) => socket.once('data', () => socket.end(
      `HTTP/1.1 ${status} PrivateReason\r\nX-Private: secret-credential\r\nContent-Length: 0\r\n\r\n`,
    )), async (port) => {
      const result = await probeWorkerLiveness(port);
      expect(result).toEqual({ outcome: 'http_response', statusCode: status, connected: true,
        headersReceived: true, elapsedMs: expect.any(Number) });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(result)).not.toMatch(/Private|secret|127\.0\.0\.1/);
    });
  });

  it('distinguishes a refused connection from a connected deadline', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeWorkerLiveness(port)).toMatchObject({ outcome: 'connect_error',
      errorCode: 'ECONNREFUSED', connected: false, headersReceived: false });
    await withServer((socket) => socket.resume(), async (openPort) => {
      const result = await probeWorkerLiveness(openPort, '127.0.0.1', 30);
      expect(result).toMatchObject({ outcome: 'deadline', connected: true, headersReceived: false });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(20);
      expect(result.elapsedMs).toBeLessThan(2000);
    });
  });

  it.each([
    ['premature_close', 'HTTP/1.1 200 OK\r\nX-Incomplete: value'],
    ['malformed_response', 'PRIVATE-invalid-response\r\n\r\n'],
    ['malformed_response', 'HTTP/1.1 200 OK\r\nX-Test: private\rX\r\n\r\n'],
  ] as const)('classifies %s without retaining parser input', async (outcome, response) => {
    await withServer((socket) => socket.once('data', () => socket.end(response)), async (port) => {
      const result = await probeWorkerLiveness(port);
      expect(result).toMatchObject({ outcome, connected: true, headersReceived: false });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|Incomplete|value/);
      if (response.includes('X-Test:')) expect(result.errorCode).toBe('UNKNOWN');
    });
  });

  it('classifies synchronous setup failure and bounds its error code', async () => {
    expect(await probeWorkerLiveness(-1)).toMatchObject({ outcome: 'setup_error',
      errorCode: 'ERR_SOCKET_BAD_PORT', connected: false, headersReceived: false });
    const result = await probeWorkerLiveness(80, 'private\ncredential');
    expect(JSON.stringify(result)).not.toMatch(/private|credential/);
    expect(result.errorCode).toBe('UNKNOWN');
    expect(result.outcome).toBe('setup_error');
  });

  it('cancels connected and not-yet-started probes without leaking sockets', async () => {
    const controller = new AbortController();
    await withServer((socket) => socket.once('data', () => controller.abort('private reason')), async (port) => {
      expect(await probeWorkerLiveness(port, '127.0.0.1', 5000, controller.signal))
        .toMatchObject({ outcome: 'cancelled', connected: true, headersReceived: false });
    });
    expect(await probeWorkerLiveness(-1, 'private-host', 5000, controller.signal))
      .toMatchObject({ outcome: 'cancelled', connected: false });
  });

  it('keeps the absolute deadline when incomplete headers trickle in', async () => {
    await withServer((socket) => {
      socket.on('data', () => {});
      socket.write('HTTP/1.1 200 OK\r\n');
      const timer = setInterval(() => socket.write('X-Progress: value\r\n'), 5);
      socket.once('close', () => clearInterval(timer));
    }, async (port) => {
      expect(await probeWorkerLiveness(port, '127.0.0.1', 35))
        .toMatchObject({ outcome: 'deadline', connected: true, headersReceived: false });
    });
  });
});

describe('generation-bound diagnostic history', () => {
  afterEach(() => vi.useRealTimers());

  it('retains five distinct failures in exactly one restart decision', async () => {
    vi.useFakeTimers();
    const outcomes = ['connect_error', 'premature_close', 'malformed_response', 'request_error', 'deadline'] as const;
    const summaries: LivenessRestartSummary[] = [];
    let count = 0;
    const watcher = startLivenessWatcher({ port: 1, intervalMs: 10,
      probe: async () => failure(outcomes[count++]), onUnresponsive: (summary) => summaries.push(summary) });
    await vi.advanceTimersByTimeAsync(150);
    expect(count).toBe(5);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].recent.map((item) => item.probe.outcome)).toEqual(outcomes);
    expect(summaries[0].recent.map((item) => item.consecutiveFailures)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(summaries[0].recent.map((item) => item.generation))).toEqual(new Set([summaries[0].generation]));
    watcher.stop();
  });

  it('bounds history, records resets and resists observer mutation and throws', async () => {
    vi.useFakeTimers();
    let count = 0;
    const summaries: LivenessRestartSummary[] = [];
    const watcher = startLivenessWatcher({ port: 1, intervalMs: 10,
      probe: async () => ++count <= 12 ? healthy() : failure(),
      onObservation: (item) => { item.generation = 'private'; item.probe.outcome = 'cancelled'; throw new Error('observer'); },
      onUnresponsive: (summary) => summaries.push(summary) });
    await vi.advanceTimersByTimeAsync(200);
    expect(summaries[0].recent).toHaveLength(8);
    expect(summaries[0].recent.slice(0, 3).map((item) => item.consecutiveFailures)).toEqual([0, 0, 0]);
    expect(summaries[0].recent[0].probe.statusCode).toBe(503);
    expect(JSON.stringify(summaries)).not.toMatch(/private|cancelled/);
    watcher.stop();
  });

  it('records grace-suppressed probes and expiry using monotonic time', async () => {
    vi.useFakeTimers();
    const observations: LivenessObservation[] = [];
    const summaries: LivenessRestartSummary[] = [];
    const watcher = startLivenessWatcher({ port: 1, intervalMs: 10, shutdownGraceMs: 30,
      isShuttingDown: () => true, probe: async () => failure(),
      onObservation: (item) => observations.push(item), onUnresponsive: (item) => summaries.push(item) });
    await vi.advanceTimersByTimeAsync(20);
    vi.setSystemTime(new Date('2000-01-01')); // Wall-clock correction must not extend grace.
    await vi.advanceTimersByTimeAsync(60);
    expect(observations.slice(0, 3).map((item) => item.shutdownGrace.state))
      .toEqual(['within_grace', 'within_grace', 'within_grace']);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].recent.at(-1)).toMatchObject({ consecutiveFailures: 5,
      shutdownGrace: { state: 'expired', elapsedMs: 70, budgetMs: 30 } });
    watcher.stop();
  });

  it('keeps grace active when diagnostic rounding reaches the budget before raw time does', async () => {
    vi.useFakeTimers();
    let now = 100;
    // This seam controls only the monotonic clock, not HTTP or a daemon service.
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const observations: LivenessObservation[] = [];
    const summaries: LivenessRestartSummary[] = [];
    const watcher = startLivenessWatcher({ port: 1, intervalMs: 10, shutdownGraceMs: 30,
      consecutiveFailuresToKill: 1, isShuttingDown: () => true, probe: async () => failure(),
      onObservation: (item) => observations.push(item), onUnresponsive: (item) => summaries.push(item) });
    try {
      await vi.advanceTimersByTimeAsync(10);
      now = 129.6;
      await vi.advanceTimersByTimeAsync(10);
      expect(observations.at(-1)).toMatchObject({ consecutiveFailures: 0,
        shutdownGrace: { state: 'within_grace', elapsedMs: 30, budgetMs: 30 } });
      expect(summaries).toHaveLength(0);
      now = 130;
      await vi.advanceTimersByTimeAsync(10);
      expect(observations.at(-1)).toMatchObject({ consecutiveFailures: 1,
        shutdownGrace: { state: 'expired', elapsedMs: 30 } });
      expect(summaries).toHaveLength(1);
    } finally {
      watcher.stop();
      clock.mockRestore();
    }
  });

  it('stopping during shutdown detection prevents stale failure or kill callbacks', async () => {
    vi.useFakeTimers();
    let release!: (value: boolean) => void;
    const observations: LivenessObservation[] = [];
    const summaries: LivenessRestartSummary[] = [];
    let signal: AbortSignal | undefined;
    const watcher = startLivenessWatcher({ port: 1, intervalMs: 10, consecutiveFailuresToKill: 1,
      probe: async (_port, _host, _timeout, currentSignal) => { signal = currentSignal; return failure(); },
      isShuttingDown: () => new Promise((resolve) => { release = resolve; }),
      onObservation: (item) => observations.push(item), onUnresponsive: (item) => summaries.push(item) });
    await vi.advanceTimersByTimeAsync(10);
    watcher.stop();
    expect(signal?.aborted).toBe(true);
    release(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(observations).toEqual([]);
    expect(summaries).toEqual([]);
  });

  it('assigns a new generation to a replacement and isolates detector errors', async () => {
    vi.useFakeTimers();
    const summaries: LivenessRestartSummary[] = [];
    for (let i = 0; i < 2; i++) {
      startLivenessWatcher({ port: 1, intervalMs: 10, consecutiveFailuresToKill: 1,
        probe: async () => failure(), isShuttingDown: () => { throw new Error('private detector'); },
        onUnresponsive: (item) => summaries.push(item) });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(summaries).toHaveLength(2);
    expect(summaries[0].generation).not.toBe(summaries[1].generation);
    expect(summaries[0].recent[0].shutdownGrace.state).toBe('detector_error');
    expect(JSON.stringify(summaries)).not.toContain('private');
  });
});
