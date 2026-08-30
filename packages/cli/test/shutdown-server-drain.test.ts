import { createServer, get, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { raceShutdownWithTimeout } from '../src/daemon/shutdown.js';
import {
  buildProducerQuiescentTeardownSteps,
  runProducerQuiescentTeardown,
} from '../src/daemon/teardown.js';

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

function shutdownCleanup(server: Server, stopDependencies: () => void): Promise<void> {
  const noop = async () => undefined;
  return runProducerQuiescentTeardown(buildProducerQuiescentTeardownSteps({
    server,
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
