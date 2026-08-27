import { describe, expect, it, vi } from 'vitest';
import { ProverLoopShutdownTimeoutError } from '@origintrail-official/dkg-random-sampling';
import { DKGAgent } from '../src/dkg-agent.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { VmReconcileDispatcher } from '../src/chain-reconciler.js';
import { FinalizationRuntime } from '../src/finalization-runtime.js';
import {
  ContextGraphMembershipPersistScheduler,
  ContextGraphMembershipPersistShutdownTimeoutError,
} from '../src/context-graph-membership-persist-scheduler.js';
import {
  VmReconcileQueueClosedError,
  VmReconcileShutdownTimeoutError,
} from '../src/vm-reconcile-service.js';
import {
  createSelectedSwmMetaFetcher,
} from '../src/sync/selected-swm-meta-fetcher.js';
import { SelectedSwmMetaTransferCoordinator } from '../src/sync/selected-swm-meta-transfer-coordinator.js';
import { createSelectedSwmMetaRetentionBudget } from '../src/sync/selected-swm-meta-budget.js';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';

function syntheticShutdownAgent(): any {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.selectedSwmBootstrapAdmission = new SelectedSwmBootstrapAdmission();
  return agent;
}

describe('DKGAgent outbox shutdown lifecycle', () => {
  it('retains a timed-out Random Sampling prover and blocks dependency teardown until retry', async () => {
    const timeout = new ProverLoopShutdownTimeoutError(5_000);
    const stopProver = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(undefined);
    const handle = {
      enabled: true,
      start: vi.fn(),
      stop: stopProver,
      getStatus: vi.fn(),
    };
    const stopNode = vi.fn(async () => {});
    const closeStore = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain: vi.fn(async () => {}) },
      clearRandomSamplingBindRetry: vi.fn(),
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      randomSamplingHandle: handle,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { stop: stopNode },
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    await expect(agent.stop()).rejects.toBe(timeout);
    expect(agent.randomSamplingHandle).toBe(handle);
    expect(stopNode).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    await expect(agent.stop()).resolves.toBeUndefined();
    expect(stopProver).toHaveBeenCalledTimes(2);
    expect(agent.randomSamplingHandle).toBeNull();
    expect(stopNode).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('drains an in-flight selected-SWM owner after network stop and before store close', async () => {
    const events: string[] = [];
    const transfers = new SelectedSwmMetaTransferCoordinator();
    const deleteCheckpoint = vi.fn(() => events.push('prefix-cleaned'));
    const peerId = 'peer-stop-order';
    let releaseTransfer!: () => void;
    const transferGate = new Promise<void>((resolve) => { releaseTransfer = resolve; });
    let signalTransferStarted!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      signalTransferStarted = resolve;
    });
    const transfer = transfers.run(
      peerId,
      () => createSelectedSwmMetaFetcher({
        remotePeerId: peerId,
        requesterScope: 'selected-swm-meta:retained:1',
        retentionBudget: createSelectedSwmMetaRetentionBudget({
          maxRows: 10,
          maxBytesEstimate: 1024,
          maxPrefixRows: 10,
          maxPrefixBytesEstimate: 1024,
        }),
        deleteCheckpoint,
        fetchPage: async () => {
          signalTransferStarted();
          await transferGate;
          return {
            quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:g' }],
            bytesReceived: 1,
            resumedFromOffset: 0,
            nextOffset: 1,
            checkpointKey: 'retained-stop-checkpoint',
            completed: false,
            timedOut: true,
          };
        },
      }),
      (fetcher) => fetcher.strategy.fetch({
        ctx: { operationId: 'stop-order', operationName: 'sync' } as never,
        remotePeerId: peerId,
        contextGraphId: 'cg-stop-order',
        graphUri: 'urn:g',
        deadline: Date.now() + 1_000,
      }),
    );
    await transferStarted;
    // Initial ownership deliberately clears any orphaned cursor for this fresh
    // scope; observe only the later shutdown release.
    deleteCheckpoint.mockClear();
    events.length = 0;

    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      selectedSwmMetaTransfers: transfers,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain: vi.fn(async () => {}) },
      clearRandomSamplingBindRetry: vi.fn(),
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      randomSamplingHandle: null,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { stop: vi.fn(async () => { events.push('node-stop'); }) },
      finalizationRuntime: new FinalizationRuntime(),
      store: {
        close: vi.fn(async () => {
          expect(deleteCheckpoint).toHaveBeenCalledWith('retained-stop-checkpoint');
          expect(agent.selectedSwmMetaTransfers).toBeUndefined();
          events.push('store-close');
        }),
      },
      log: { warn: vi.fn() },
    });

    const stopping = agent.stop();
    await vi.waitFor(() => expect(agent.node.stop).toHaveBeenCalledOnce());
    expect(agent.store.close).not.toHaveBeenCalled();
    expect(deleteCheckpoint).not.toHaveBeenCalled();
    expect(agent.selectedSwmMetaTransfers).toBe(transfers);

    releaseTransfer();
    await Promise.all([transfer, stopping]);
    expect(events).toEqual(['node-stop', 'prefix-cleaned', 'store-close']);
  });

  it('closes and drains membership persistence before network and store teardown', async () => {
    const membershipPersistence = new ContextGraphMembershipPersistScheduler();
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const write = membershipPersistence.enqueue('cg\0node\0peer', async () => {
      markWriteStarted();
      await writeGate;
    });
    await writeStarted;
    const closeStore = vi.fn(async () => {});
    const stopNode = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      contextGraphMembershipPersistence: membershipPersistence,
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
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    const stopping = agent.stop();
    await Promise.resolve();
    expect(stopNode).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    releaseWrite();
    await Promise.all([write, stopping]);
    expect(stopNode).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });

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
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: {
        stop: vi.fn(async () => {
          expect(agent.vmReconcileRotationClosed).toBe(true);
        }),
      },
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
      finalizationRuntime: new FinalizationRuntime(),
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

  it('quarantines the instance after the bounded reconcile drain timeout', async () => {
    const originalTimeout = DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
      configurable: true,
      value: 1,
    });
    try {
      let release!: () => void;
      const activeGate = new Promise<void>((resolve) => { release = resolve; });
      const dispatcher = new VmReconcileDispatcher(
        async () => activeGate,
        () => undefined,
      );
      void dispatcher.triggerManual('stuck');
      await new Promise((resolve) => setTimeout(resolve, 0));

      const closeStore = vi.fn(async () => {});
      const stopNode = vi.fn(async () => {});
      const warn = vi.fn();
      const agent = syntheticShutdownAgent();
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
        chain: { chainId: 'none' },
        finalizationRuntime: new FinalizationRuntime(),
        store: { close: closeStore },
        log: { warn },
      });

      await expect(agent.stop()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);

      expect(stopNode).not.toHaveBeenCalled();
      expect(closeStore).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('store/network teardown is blocked until stop() is retried'),
      );

      // Even after physical retirement, start remains blocked until a second
      // stop finishes the deliberately incomplete teardown.
      await expect(agent.start()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);

      release();
      await agent.vmReconcileRetirement;
      await expect(agent.start()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
      await expect(agent.stop()).resolves.toBeUndefined();
      expect(stopNode).toHaveBeenCalledOnce();
      expect(closeStore).toHaveBeenCalledOnce();
      expect(agent.started).toBe(false);
    } finally {
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('quarantines start and backing-store teardown after membership persistence times out', async () => {
    const originalTimeout = DKGAgentBase.CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_MS;
    Object.defineProperty(DKGAgentBase, 'CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_MS', {
      configurable: true,
      value: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const membershipPersistence = new ContextGraphMembershipPersistScheduler();
    void membershipPersistence.enqueue('stuck', async () => gate);
    await Promise.resolve();
    const closeStore = vi.fn(async () => {});
    const stopNode = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      contextGraphMembershipPersistence: membershipPersistence,
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
      chain: { chainId: 'none' },
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    try {
      await expect(agent.stop()).rejects.toBeInstanceOf(
        ContextGraphMembershipPersistShutdownTimeoutError,
      );
      expect(stopNode).not.toHaveBeenCalled();
      expect(closeStore).not.toHaveBeenCalled();
      await expect(agent.start()).rejects.toBeInstanceOf(
        ContextGraphMembershipPersistShutdownTimeoutError,
      );

      release();
      await membershipPersistence.closeAndDrain();
      await expect(agent.start()).rejects.toBeInstanceOf(
        ContextGraphMembershipPersistShutdownTimeoutError,
      );
      await expect(agent.stop()).resolves.toBeUndefined();
      expect(stopNode).toHaveBeenCalledOnce();
      expect(closeStore).toHaveBeenCalledOnce();
      expect(agent.started).toBe(false);
    } finally {
      release();
      Object.defineProperty(DKGAgentBase, 'CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_MS', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('drains physically active VM reconciliation before closing the store', async () => {
    const originalTimeout = DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
      configurable: true,
      value: 1,
    });
    let release!: () => void;
    const physical = new Promise<void>((resolve) => { release = resolve; });
    const closeStore = vi.fn(async () => {});
    const stopNode = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      vmReconcilePhysicalRuns: new Set([physical]),
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
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    try {
      await expect(agent.stop()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
      expect(stopNode).not.toHaveBeenCalled();
      expect(closeStore).not.toHaveBeenCalled();

      release();
      await agent.vmReconcileRetirement;
      await agent.stop();
      expect(stopNode).toHaveBeenCalledOnce();
      expect(closeStore).toHaveBeenCalledOnce();
    } finally {
      release();
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('drains an entered ordinary graph-scoped commit before closing the store', async () => {
    let release!: () => void;
    const physicalCommit = new Promise<void>((resolve) => { release = resolve; });
    const closeStore = vi.fn(async () => {});
    const stopNode = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller: null,
      graphScopedStorePhysicalRuns: new Set([physicalCommit]),
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
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    const stopping = agent.stop();
    await Promise.resolve();
    expect(stopNode).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(stopNode).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('bounds chain-poller retirement before network and store teardown', async () => {
    const originalTimeout = DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
      configurable: true,
      value: 1,
    });
    let release!: () => void;
    const pollerDrain = new Promise<void>((resolve) => { release = resolve; });
    const chainPoller = { stop: vi.fn(() => pollerDrain) };
    const closeStore = vi.fn(async () => {});
    const stopNode = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
    Object.assign(agent, {
      started: true,
      chainPoller,
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
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn() },
    });

    try {
      await expect(agent.stop()).rejects.toBeInstanceOf(VmReconcileShutdownTimeoutError);
      expect(chainPoller.stop).toHaveBeenCalledOnce();
      expect(agent.chainPoller).toBe(chainPoller);
      expect(stopNode).not.toHaveBeenCalled();
      expect(closeStore).not.toHaveBeenCalled();

      release();
      await agent.vmReconcileRetirement;
      expect(agent.chainPoller).toBeNull();
      await agent.stop();
      expect(stopNode).toHaveBeenCalledOnce();
      expect(closeStore).toHaveBeenCalledOnce();
    } finally {
      release();
      Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SHUTDOWN_TIMEOUT_MS', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('cancels and awaits the active outbox drain before network teardown', async () => {
    let release!: () => void;
    const activeDrain = new Promise<void>((resolve) => { release = resolve; });
    const stopOutboxDrain = vi.fn(() => activeDrain);
    const stopNode = vi.fn(async () => {});
    const agent = syntheticShutdownAgent();
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
      finalizationRuntime: new FinalizationRuntime(),
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
    const agent = syntheticShutdownAgent();
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
      finalizationRuntime: new FinalizationRuntime(),
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
