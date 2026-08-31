import { createServer, get, type Server, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import { raceShutdownWithTimeout } from '../src/daemon/shutdown.js';
import {
  buildProducerQuiescentTeardownSteps,
  runProducerQuiescentTeardown,
} from '../src/daemon/teardown.js';
import {
  openEventStream,
  startLiveDaemon,
  stopLiveDaemon,
  type LiveDaemon,
} from './helpers/live-daemon.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return address.port;
}

function requestBody(port: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const request = get({
      host: '127.0.0.1',
      port,
      path: '/slow',
      agent: false,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', () => resolve('connection-cut-off'));
  });
}

function shutdownCleanup(
  server: Server,
  stopDependencies: () => void,
  longLivedResponses?: Set<ServerResponse>,
): Promise<void> {
  const noop = async () => undefined;
  return runProducerQuiescentTeardown(buildProducerQuiescentTeardownSteps({
    server,
    longLivedResponses,
    closeLocalLlm: noop,
    drainCatchupJobs: async () => undefined,
    flushTelemetry: noop,
    stopPublisherRuntime: noop,
    stopPromoteWorker: noop,
    closeCatchupRunner: noop,
    stopAgent: async () => { stopDependencies(); },
    stopTelemetry: noop,
    log: () => undefined,
  })).then(() => undefined);
}

describe('HTTP callback draining during bounded shutdown', () => {
  it('ends the real daemon SSE stream and exits cleanly before its hard timeout', async () => {
    let daemon: LiveDaemon | undefined;
    let stream: Awaited<ReturnType<typeof openEventStream>> | undefined;
    try {
      daemon = await startLiveDaemon({
        authEnabled: false,
        extraConfig: { chain: { type: 'mock' } },
        env: { DKG_SHUTDOWN_HARD_TIMEOUT_MS: '5000' },
      });
      stream = await openEventStream(daemon);
      const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('daemon did not exit before deadline')), 6_000);
        daemon!.child.once('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      const shutdownStartedAt = Date.now();

      expect(daemon.child.kill('SIGTERM')).toBe(true);
      await expect(stream.closed).resolves.toBeUndefined();
      await expect(exited).resolves.toBe(0);
      expect(Date.now() - shutdownStartedAt).toBeLessThan(5_000);
    } finally {
      stream?.close();
      await stopLiveDaemon(daemon);
    }
  }, 90_000);

  it('ends tracked SSE streams before draining and reaches dependency cleanup', async () => {
    const sseClients = new Set<ServerResponse>();
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => { markConnected = resolve; });
    const downstreamSteps: string[] = [];
    const server = createServer((request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      sseClients.add(response);
      request.on('close', () => sseClients.delete(response));
      response.write('event: connected\ndata: {}\n\n');
      markConnected();
    });
    const port = await listen(server);
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const request = get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (response) => {
      response.resume();
      response.once('end', markClosed);
    });
    request.once('error', markClosed);
    await connected;
    expect(sseClients.size).toBe(1);

    const noop = async () => undefined;
    const cleanup = runProducerQuiescentTeardown(buildProducerQuiescentTeardownSteps({
      server,
      longLivedResponses: sseClients,
      closeLocalLlm: noop,
      drainCatchupJobs: async () => undefined,
      flushTelemetry: noop,
      stopPublisherRuntime: noop,
      stopPromoteWorker: noop,
      closeCatchupRunner: noop,
      stopAgent: async () => { downstreamSteps.push('agent'); },
      stopTelemetry: async () => { downstreamSteps.push('telemetry'); },
      log: () => undefined,
    })).then(() => undefined);

    await expect(raceShutdownWithTimeout(cleanup, 250, () => undefined))
      .resolves.toEqual({ forced: false });
    await closed;
    expect(sseClients.size).toBe(0);
    expect(downstreamSteps).toEqual(['agent', 'telemetry']);
  });

  it('lets an in-flight callback complete within a longer budget before dependencies stop', async () => {
    let dependenciesStopped = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const server = createServer((_request, response) => {
      markStarted();
      response.setHeader('Connection', 'close');
      setTimeout(() => response.end(dependenciesStopped ? 'dependencies-stopped' : 'completed'), 30);
    });
    const port = await listen(server);
    const body = requestBody(port);
    await started;

    const cleanup = shutdownCleanup(server, () => { dependenciesStopped = true; });
    await expect(raceShutdownWithTimeout(cleanup, 250, () => undefined))
      .resolves.toEqual({ forced: false });
    await expect(body).resolves.toBe('completed');
    expect(dependenciesStopped).toBe(true);
  });

  it('returns the forced outcome while an over-budget callback is still pending', async () => {
    let callbackCompleted = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const server = createServer((_request, response) => {
      markStarted();
      response.setHeader('Connection', 'close');
      setTimeout(() => {
        callbackCompleted = true;
        response.end('too-late');
      }, 150);
    });
    const port = await listen(server);
    const body = requestBody(port);
    await started;

    const cleanup = shutdownCleanup(server, () => undefined);
    await expect(raceShutdownWithTimeout(cleanup, 20, () => undefined))
      .resolves.toEqual({ forced: true });
    expect(callbackCompleted).toBe(false);

    server.closeAllConnections();
    await body;
    await cleanup;
  });
});
