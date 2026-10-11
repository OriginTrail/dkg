import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import type { DkgConfig } from '../src/config.js';
import type { PublisherRuntime, PublisherStartupOutcome, PublisherState } from '../src/publisher-runner.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import {
  createFakeDaemonAgent,
  createFakeDaemonHttpServer,
  type FakeDaemonAgent,
} from './_helpers/daemon-boot-doubles.js';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  backfillOnBoot: vi.fn(),
  beginGracefulShutdown: vi.fn(),
  chainResetWipe: vi.fn(),
  createAdmissionRecoveryCapabilityProbe: vi.fn(),
  createPublisherControlFromStore: vi.fn(),
  createServer: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadOpWallets: vi.fn(),
  publisherStopEntered: vi.fn(),
  publisherStopFinished: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
}));

vi.mock('node:http', () => ({ createServer: mocks.createServer }));
vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual,
    DKGAgent: { create: mocks.agentCreate },
    loadOpWallets: mocks.loadOpWallets,
    KaNumberAllocator: class KaNumberAllocator {},
  };
});
vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, loadNetworkConfig: mocks.loadNetworkConfig };
});
vi.mock('../src/daemon/chain-reset-wipe.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/chain-reset-wipe.js')>();
  return { ...actual, chainResetWipe: mocks.chainResetWipe };
});
vi.mock('../src/daemon/vm-publish-intent-backfill.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/vm-publish-intent-backfill.js')>();
  return { ...actual, backfillVmPublishIntentIndexOnBoot: mocks.backfillOnBoot };
});
vi.mock('../src/vector-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/vector-store.js')>();
  // No vector routes are exercised. Avoid an unrelated SQLite handle normally
  // released by process.exit, which this in-process harness intercepts.
  return { ...actual, VectorStore: class VectorStore {} };
});
vi.mock('../src/publisher-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/publisher-runner.js')>();
  mocks.createAdmissionRecoveryCapabilityProbe.mockImplementation(actual.createAdmissionRecoveryCapabilityProbe);
  return {
    ...actual,
    createAdmissionRecoveryCapabilityProbe: mocks.createAdmissionRecoveryCapabilityProbe,
    createPublisherControlFromStore: mocks.createPublisherControlFromStore,
    startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome,
  };
});
vi.mock('../src/daemon/teardown.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/teardown.js')>();
  mocks.beginGracefulShutdown.mockImplementation(actual.beginGracefulShutdown);
  return {
    ...actual,
    beginGracefulShutdown: mocks.beginGracefulShutdown,
    buildProducerQuiescentTeardownSteps: (...args: Parameters<typeof actual.buildProducerQuiescentTeardownSteps>) => {
      const steps = actual.buildProducerQuiescentTeardownSteps(...args);
      return {
        ...steps,
        stopPublisherRuntime: () => {
          // Observe entry, but retain the real daemon callback and teardown order.
          mocks.publisherStopEntered();
          return steps.stopPublisherRuntime().then(() => { mocks.publisherStopFinished(); });
        },
      };
    },
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('runDaemonInner publisher startup cancellation', () => {
  const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
  const processEvents: NodeJS.EventEmitter = process;
  const originalListeners = new Map<string, ReturnType<typeof processEvents.listeners>>();
  const releasePending: (() => void)[] = [];
  let tempHome: string;
  let agent: FakeDaemonAgent;
  let shutdownHandler: (() => Promise<void>) | undefined;
  let shutdown: Promise<void> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-daemon-publisher-cancellation-'));
    vi.stubEnv('DKG_HOME', tempHome);
    for (const event of events) originalListeners.set(event, processEvents.listeners(event));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    agent = createFakeDaemonAgent();
    mocks.agentCreate.mockResolvedValue(agent);
    mocks.createServer.mockImplementation(() => createFakeDaemonHttpServer());
    mocks.backfillOnBoot.mockResolvedValue(undefined);
    mocks.createPublisherControlFromStore.mockReturnValue({});
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'Publisher cancellation test',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: [],
      defaultNodeRole: 'edge',
    });
    mocks.chainResetWipe.mockResolvedValue({
      wiped: false, skipped: false, prevMarker: null,
      removedFiles: [], backedUpFiles: [], failedFiles: [],
    });
    mocks.startPublisherRuntimeWithOutcome.mockResolvedValue({
      runtime: null,
      availability: { available: false, reason: 'no_publisher_wallets', retryable: false, operatorActionRequired: true },
    });
    mocks.publisherStopEntered.mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    // Unblock both startup and runtime.stop even if an assertion fails.
    for (const release of releasePending.splice(0)) release();
    if (shutdownHandler) await (shutdown ?? shutdownHandler());
    shutdown = undefined;
    shutdownHandler = undefined;
    for (const event of events) {
      for (const listener of processEvents.listeners(event)) {
        if (!originalListeners.get(event)?.includes(listener)) processEvents.removeListener(event, listener as () => void);
      }
    }
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(tempHome, { recursive: true, force: true });
  });

  async function boot(signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM') {
    await runDaemonInner(true, {
      name: 'publisher-cancellation-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      apiPort: 0,
      nodeRole: 'edge',
      auth: { enabled: false },
      promoteQueue: { enabled: false },
      telemetry: { enabled: false, metrics: { collectionEnabled: false } },
      autoUpdate: { enabled: false, source: 'monorepo' },
      publisher: { enabled: true },
      chain: {
        type: 'evm',
        rpcUrl: 'http://127.0.0.1:1',
        hubAddress: '0x1111111111111111111111111111111111111111',
        chainId: 'evm:31337',
      },
    } satisfies DkgConfig, Date.now(), resolveShutdownPolicy(undefined));
    const installed = processEvents.listeners(signal).filter(listener => !originalListeners.get(signal)?.includes(listener));
    expect(installed).toHaveLength(1);
    // Invoke the installed handler directly so its promise can be awaited;
    // process.emit would also notify unrelated Vitest/process listeners.
    shutdownHandler = installed[0] as unknown as () => Promise<void>;
    const readState = mocks.createAdmissionRecoveryCapabilityProbe.mock.calls[0][0] as () => PublisherState;
    return { readState };
  }

  function beginShutdown() {
    shutdown = shutdownHandler!();
    return shutdown;
  }

  function lateRuntime() {
    const stopEntered = deferred<void>();
    const stopRelease = deferred<void>();
    const runtime = {
      stop: vi.fn(() => { stopEntered.resolve(); return stopRelease.promise; }),
      canSettleHeldJob: vi.fn(() => true),
    };
    releasePending.push(() => stopRelease.resolve());
    const outcome: PublisherStartupOutcome = {
      runtime: runtime as unknown as PublisherRuntime,
      availability: { available: true },
    };
    return { runtime, outcome, stopEntered, stopRelease };
  }

  it('aborts before teardown, drains startup and late runtime stop, and never publishes the late state', async () => {
    const startup = deferred<PublisherStartupOutcome>();
    const late = lateRuntime();
    releasePending.push(() => startup.resolve(late.outcome));
    mocks.startPublisherRuntimeWithOutcome.mockReturnValue(startup.promise);
    const publisherStopEntered = deferred<void>();
    mocks.publisherStopEntered.mockImplementation(() => publisherStopEntered.resolve());
    const closeDashboard = vi.spyOn(DashboardDB.prototype, 'close');
    const { readState } = await boot();
    const initialState = readState();
    expect(initialState.availability).toMatchObject({ available: false, reason: 'publisher_starting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.startPublisherRuntimeWithOutcome).toHaveBeenCalledTimes(1);
    const args = mocks.startPublisherRuntimeWithOutcome.mock.calls[0][0];
    expect(args.store).toBe(agent.store);
    expect(args.keypair).toBe(agent.wallet.keypair);
    expect(args.startupSignal).toBeInstanceOf(AbortSignal);
    const startupSignal: AbortSignal = args.startupSignal;
    expect(startupSignal.aborted).toBe(false);
    const aborted = vi.fn();
    startupSignal.addEventListener('abort', aborted, { once: true });

    void beginShutdown();
    // Synchronous assertions pin cancellation ahead of the first teardown await.
    expect(startupSignal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(mocks.beginGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(aborted.mock.invocationCallOrder[0]).toBeLessThan(mocks.beginGracefulShutdown.mock.invocationCallOrder[0]);
    await publisherStopEntered.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.publisherStopFinished).not.toHaveBeenCalled();
    expect(agent.stop).not.toHaveBeenCalled();
    expect(agent.store.close).not.toHaveBeenCalled();
    expect(closeDashboard).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();

    startup.resolve(late.outcome);
    await late.stopEntered.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(late.runtime.stop).toHaveBeenCalledTimes(1);
    expect(readState()).toBe(initialState);
    expect(mocks.publisherStopFinished).not.toHaveBeenCalled();
    expect(agent.stop).not.toHaveBeenCalled();
    expect(agent.store.close).not.toHaveBeenCalled();
    expect(closeDashboard).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();

    late.stopRelease.resolve();
    await shutdown;
    expect(readState()).toBe(initialState);
    expect(late.runtime.stop).toHaveBeenCalledTimes(1);
    expect(mocks.publisherStopFinished).toHaveBeenCalledTimes(1);
    expect(agent.stop).toHaveBeenCalledTimes(1);
    expect(agent.store.close).toHaveBeenCalledTimes(1);
    expect(closeDashboard).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('prevents deferred publisher startup after shutdown, even if the cleared callback was already queued', async () => {
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    const { readState } = await boot('SIGINT');
    const initialState = readState();
    const deferredCallbacks = schedule.mock.calls.filter(([, delay]) => delay === 0);
    expect(deferredCallbacks.length).toBeGreaterThan(0);
    expect(mocks.startPublisherRuntimeWithOutcome).not.toHaveBeenCalled();

    await beginShutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.startPublisherRuntimeWithOutcome).not.toHaveBeenCalled();
    // Replay the boot callbacks without depending on timer ordering or source
    // text: cancellation must also fence a callback dequeued before clearTimeout.
    for (const [callback, , ...args] of deferredCallbacks) callback(...args);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.startPublisherRuntimeWithOutcome).not.toHaveBeenCalled();
    expect(readState()).toBe(initialState);
    expect(agent.stop).toHaveBeenCalledTimes(1);
    expect(agent.store.close).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('publishes a runtime completed before shutdown and stops it once', async () => {
    const late = lateRuntime();
    late.stopRelease.resolve();
    mocks.startPublisherRuntimeWithOutcome.mockResolvedValue(late.outcome);
    const { readState } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    // Positive control: the same live-state observer sees normal publication.
    expect(readState()).toBe(late.outcome);
    expect(late.runtime.stop).not.toHaveBeenCalled();

    await beginShutdown();
    expect(late.runtime.stop).toHaveBeenCalledTimes(1);
    expect(late.runtime.stop.mock.invocationCallOrder[0]).toBeLessThan(agent.stop.mock.invocationCallOrder[0]);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
