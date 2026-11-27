import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DkgConfig } from '../src/config.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { createFakeDaemonAgent, createFakeDaemonHttpServer } from './_helpers/daemon-boot-doubles.js';

const checkpoint = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/daemon/public-checkpoint-agent.js', () => ({ openDaemonCheckpointAgent: checkpoint.open }));
vi.mock('../src/vector-store.js', async original => ({
  ...await original<typeof import('../src/vector-store.js')>(), VectorStore: class {},
}));
import { daemonWiringMocks as mocks, installDaemonLifecycleWiringFixture,
  closeDashboardDbFromAgentCreateArg, runDaemonInner } from './helpers/daemon-lifecycle-wiring.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

installDaemonLifecycleWiringFixture();
let agent: ReturnType<typeof createFakeDaemonAgent>;
let session: { agent: typeof agent; complete: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let completion: ReturnType<typeof deferred<{ current: true; assets: number; committed: number }>>;
let graph: ReturnType<typeof deferred<void>>;
let originalSignals: Map<string, Function[]>;
let bootError: unknown;
let boot: Promise<void> | undefined;
let bootSettled: Promise<unknown> | undefined;
let api: ReturnType<typeof createFakeDaemonHttpServer>;
const coverage = { current: true as const, assets: 3, committed: 3 };
const installed = (signal = 'SIGTERM') => process.listeners(signal).filter(fn => !originalSignals.get(signal)!.includes(fn));

beforeEach(async () => {
  originalSignals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, process.listeners(signal)]));
  agent = createFakeDaemonAgent(); completion = deferred(); graph = deferred();
  api = createFakeDaemonHttpServer();
  const http = await vi.importActual<typeof import('node:http')>('node:http');
  mocks.createServer.mockImplementation(() => api).mockImplementationOnce(http.createServer);
  mocks.agentCreate.mockResolvedValue(agent);
  mocks.loadNetworkConfig.mockResolvedValue({ networkName: 'Checkpoint startup test', genesisId: 'gnosis-mainnet',
    genesisVersion: 1, relays: [], defaultNodeRole: 'edge' });
  session = { agent, complete: vi.fn(() => completion.promise), dispose: vi.fn(),
    close: vi.fn(async () => { try { await agent.stop(); } finally { await agent.store.close(); } }) };
  checkpoint.open.mockResolvedValue(session);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  boot = undefined; bootSettled = undefined; bootError = undefined;
});

afterEach(async () => {
  completion.resolve(coverage); graph.resolve();
  await bootSettled;
  const stop = installed().at(-1) as (() => Promise<void>) | undefined;
  await stop?.();
  closeDashboardDbFromAgentCreateArg(checkpoint.open.mock.calls[0]?.[0]);
});

function start() {
  boot = runDaemonInner(true, {
    name: 'checkpoint-startup-test', networkConfig: 'mainnet-gnosis', nodeRole: 'edge', listenPort: 0, apiPort: 0,
    contextGraphs: ['native-graph'], localBootstrapContextGraphs: ['native-graph'],
    auth: { enabled: false }, promoteQueue: { enabled: false }, publisher: { enabled: false },
    telemetry: { enabled: false, metrics: { collectionEnabled: false } }, autoUpdate: { enabled: false, source: 'monorepo' },
    chain: { type: 'evm', rpcUrl: 'http://127.0.0.1:1', chainId: 'evm:100', hubAddress: '0x1111111111111111111111111111111111111111' },
    publicSnapshotBootstrap: { version: 1, runtime: { java: process.execPath, jar: '/tmp/checkpoint-fixture.jar', jarSha256: 'a'.repeat(64) },
      source: { contextGraphId: 'native-graph', onChainId: '14', mode: 'core-cache', sourcePolicy: 'DKG_Core_chain_cache', trustedCorePeerIds: [] } },
  } as DkgConfig, Date.now(), resolveShutdownPolicy(undefined));
  bootSettled = boot.catch(error => { bootError = error; });
  return boot;
}

it('keeps the real daemon at HTTP 503 until coverage, then hands the same port to its API', async () => {
  start();
  await expect.poll(() => { if (bootError) throw bootError; return session.complete.mock.calls.length; }).toBe(1);
  const port = Number(await readFile(join(process.env.DKG_HOME!, 'api.port'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}/api/status`);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ready: false, state: 'public-bootstrap-starting' });
  expect(api.listen).not.toHaveBeenCalled();
  completion.resolve(coverage); await boot;
  expect(api.listen).toHaveBeenCalledWith(port, '127.0.0.1', expect.any(Function));
  expect(installed('SIGINT')).toHaveLength(1); expect(installed()).toHaveLength(1);
  expect(session.close).not.toHaveBeenCalled();
});

it('rejects failed coverage and closes the startup listener and owned agent before returning', async () => {
  start(); await expect.poll(() => { if (bootError) throw bootError; return session.complete.mock.calls.length; }).toBe(1);
  const port = Number(await readFile(join(process.env.DKG_HOME!, 'api.port'), 'utf8'));
  completion.reject(new Error('coverage failed'));
  await expect(boot).rejects.toThrow('coverage failed');
  expect(agent.store.close).toHaveBeenCalled(); expect(session.dispose).toHaveBeenCalled();
  await expect(fetch(`http://127.0.0.1:${port}/api/status`)).rejects.toThrow();
  expect(api.listen).not.toHaveBeenCalled(); expect(installed()).toHaveLength(0);
});

it('closes the owned checkpoint session when daemon network startup fails', async () => {
  agent.start.mockRejectedValueOnce(new Error('network startup failed'));
  await expect(start()).rejects.toThrow('network startup failed');
  expect(session.close).toHaveBeenCalledTimes(1);
  expect(api.listen).not.toHaveBeenCalled(); expect(installed()).toHaveLength(0);
});

it('waits for a session acquired during interruption and closes it exactly once', async () => {
  const acquired = deferred<typeof session>();
  checkpoint.open.mockReturnValueOnce(acquired.promise);
  start();
  await expect.poll(() => checkpoint.open.mock.calls.length).toBe(1);
  const handler = installed()[0] as () => Promise<void>;
  const interrupt = handler();
  expect(handler()).toBe(interrupt);
  expect(process.exit).not.toHaveBeenCalled();
  acquired.resolve(session);
  await interrupt; await expect(boot).rejects.toThrow('Checkpoint startup interrupted');
  expect(session.close).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(api.listen).not.toHaveBeenCalled();
});

it.each(['SIGTERM', 'SIGINT'])('owns %s after checkpoint completion while later daemon startup is blocked', async signal => {
  agent.ensureContextGraphLocal.mockImplementation(() => graph.promise);
  completion.resolve(coverage); start();
  await expect.poll(() => { if (bootError) throw bootError; return agent.ensureContextGraphLocal.mock.calls.length; }).toBe(1);
  const handlers = installed(signal);
  expect(handlers).toHaveLength(1);
  await (handlers[0] as () => Promise<void>)();
  expect(agent.store.close).toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(1);
  graph.resolve(); await expect(boot).rejects.toThrow('Checkpoint startup interrupted');
  expect(api.listen).not.toHaveBeenCalled();
});
