import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  VmReconcileDispatcher,
  VmReconcileQueueClosedError,
} from '../src/chain-reconciler.js';

describe('DKGAgent outbox shutdown lifecycle', () => {
  it('closes reconcile admission and cancels queued jobs before store teardown', async () => {
    let releaseActive!: () => void;
    let queuedStarted = false;
    const dispatcher = new VmReconcileDispatcher(async (key) => {
      if (key === 'active') {
        await new Promise<void>((resolve) => { releaseActive = resolve; });
      } else if (key === 'queued') {
        queuedStarted = true;
      }
    }, () => undefined);
    const active = dispatcher.triggerManual('active');
    const queuedOutcome = dispatcher.triggerManual('queued').catch((error) => error);
    const closeStore = vi.fn(async () => {});
    const stopNode = vi.fn(async () => {});
    const agent = Object.create(DKGAgent.prototype) as any;
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      vmReconcileDispatcher: dispatcher,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain: vi.fn(async () => {}) },
      clearRandomSamplingBindRetry: vi.fn(),
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      randomSamplingHandle: null,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { stop: stopNode },
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    const stopping = agent.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await queuedOutcome).toBeInstanceOf(VmReconcileQueueClosedError);
    expect(queuedStarted).toBe(false);
    expect(stopNode).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    releaseActive();
    await Promise.all([active, stopping]);
    expect(queuedStarted).toBe(false);
    expect(stopNode).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('cancels and awaits the active outbox drain before network teardown', async () => {
    let release!: () => void;
    const activeDrain = new Promise<void>((resolve) => { release = resolve; });
    const stopOutboxDrain = vi.fn(() => activeDrain);
    const stopNode = vi.fn(async () => {});
    const agent = Object.create(DKGAgent.prototype) as any;
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain },
      clearRandomSamplingBindRetry: vi.fn(),
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      randomSamplingHandle: null,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { stop: stopNode },
      store: { close: vi.fn(async () => {}) },
      log: { warn: vi.fn() },
    });

    const stopping = agent.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopOutboxDrain).toHaveBeenCalledOnce();
    expect(stopNode).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(stopNode).toHaveBeenCalledOnce();
  });

  it('logs a failed outbox drain and continues network teardown', async () => {
    const stopOutboxDrain = vi.fn(async () => { throw new Error('drain failed'); });
    const stopNode = vi.fn(async () => {});
    const closeStore = vi.fn(async () => {});
    const warn = vi.fn();
    const agent = Object.create(DKGAgent.prototype) as any;
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain },
      clearRandomSamplingBindRetry: vi.fn(),
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      randomSamplingHandle: null,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { stop: stopNode },
      store: { close: closeStore },
      log: { warn },
    });

    await expect(agent.stop()).resolves.toBeUndefined();

    expect(stopOutboxDrain).toHaveBeenCalledOnce();
    expect(stopNode).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('outbox retry drain failed during shutdown: drain failed'),
    );
  });
});
