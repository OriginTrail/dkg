import { describe, expect, it, vi } from 'vitest';
import { AsyncLiftRunner, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { kaVmPublishRequest, stageKnowledgeAssetShareSnapshot } from '../../../scripts/testing/ka-vm-publish.js';
import { createAsyncLiftClaimControl } from '../src/async-lift-claim-gate.js';
import { createRunnerPublisher as createPublisher } from './_helpers/async-lift-runner-fixture.js';

describe('AsyncLiftRunner claim control', () => {
  it('observes the publisher gate for startup maintenance and later live pause/resume', async () => {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store);
    const processNext = vi.spyOn(publisher.claimScheduling, 'prepare');
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['wallet-1'],
      startPaused: true, pollIntervalMs: 60_000 });
    try {
      await runner.start();
      expect(runner.claimControl.state).toBe('held');
      expect(processNext).not.toHaveBeenCalled();
      await runner.claimControl.release();
      await vi.waitFor(() => expect(processNext).toHaveBeenCalledTimes(1));
      expect(runner.claimControl.state).toBe('running');
      await publisher.pause();
      expect(runner.claimControl.state).toBe('held');
      await runner.claimControl.release();
      await vi.waitFor(() => expect(processNext).toHaveBeenCalledTimes(2));
    } finally { await runner.stop(); await store.close(); }
  });

  it('preserves legacy paused maintenance before startup recovery without live claim control', async () => {
    const order: string[] = [];
    let paused = false;
    const publisher = createPublisher({ claimControl: undefined,
      pause: async () => { paused = true; order.push('pause'); },
      recover: async () => { expect(paused).toBe(true); order.push('recover'); return 0; },
      processNext: async () => { expect(paused).toBe(true); return null; },
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['wallet-1'],
      startPaused: true, pollIntervalMs: 60_000 });
    try {
      await runner.start();
      expect(order).toEqual(['pause', 'recover']);
      expect(() => runner.claimControl.hold()).toThrow('does not support live claim control');
    } finally { await runner.stop(); }
  });

  it('announces live resume through the publisher scheduler even when another owner is attached', async () => {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store);
    const onWorkAvailable = vi.fn();
    const detach = publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand() {}, onWalletRelease() {}, onWorkAvailable,
    });
    const runner = new AsyncLiftRunner({ publisher, walletIds: ['wallet-1'] });
    try {
      await publisher.pause();
      await runner.claimControl.release();
      expect(publisher.claimControl.state).toBe('running');
      expect(onWorkAvailable).toHaveBeenCalledOnce();
    } finally { detach(); await runner.stop(); await store.close(); }
  });

  it('publishes the complete release notification through its public control capability', async () => {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store);
    const onWorkAvailable = vi.fn();
    const detach = publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand() {}, onWalletRelease() {}, onWorkAvailable,
    });
    try {
      await publisher.claimControl.hold();
      expect(publisher.claimControl.state).toBe('held');
      await publisher.claimControl.release();
      expect(onWorkAvailable).toHaveBeenCalledOnce();
      await publisher.claimControl.close();
      await expect(publisher.claimControl.release()).rejects.toThrow('closed');
      expect(onWorkAvailable).toHaveBeenCalledOnce();
    } finally { detach(); await store.close(); }
  });

  it('closes admission synchronously before the publisher claim drain settles', async () => {
    let releaseDrain!: () => void;
    const drainHeld = new Promise<void>(resolve => { releaseDrain = resolve; });
    const claimControl = createAsyncLiftClaimControl(async commit => { await drainHeld; commit?.(); }, () => {});
    const runner = new AsyncLiftRunner({ publisher: createPublisher({ claimControl }), walletIds: ['wallet-1'] });
    const closing = runner.claimControl.close();
    try {
      expect(runner.claimControl.state).toBe('closed');
      expect(claimControl.state).toBe('closed');
      await expect(runner.claimControl.release()).rejects.toThrow('closed');
    } finally { releaseDrain(); await closing; await runner.stop(); }
  });

  it('never reopens the publisher gate when terminal closure races an awaited resume', async () => {
    let enterResume!: () => void; const entered = new Promise<void>(resolve => { enterResume = resolve; });
    let releaseResume!: () => void; const held = new Promise<void>(resolve => { releaseResume = resolve; });
    const notifyWorkAvailable = vi.fn();
    const claimControl = createAsyncLiftClaimControl(async commit => {
      if (commit) { enterResume(); await held; commit(); }
    }, notifyWorkAvailable);
    const processNext = vi.fn(async () => null);
    const runner = new AsyncLiftRunner({ publisher: createPublisher({ claimControl, processNext }),
      walletIds: ['wallet-1'], pollIntervalMs: 60_000 });
    await runner.claimControl.hold(); await runner.start();
    const resuming = runner.claimControl.release();
    const rejected = expect(resuming).rejects.toThrow('closed');
    try {
      await entered; await runner.claimControl.close();
      releaseResume(); await rejected;
      expect(runner.claimControl.state).toBe('closed');
      expect(claimControl.state).toBe('closed');
      expect(processNext).not.toHaveBeenCalled();
      expect(notifyWorkAvailable).not.toHaveBeenCalled();
      await expect(runner.claimControl.release()).rejects.toThrow('closed');
    } finally { releaseResume(); await resuming.catch(() => {}); await runner.stop(); }
  });

  it('allows legacy polling but refuses live control without a publisher-owned gate', async () => {
    const processNext = vi.fn(async () => null);
    const runner = new AsyncLiftRunner({ publisher: createPublisher({ claimControl: undefined, processNext }),
      walletIds: ['wallet-1'], pollIntervalMs: 60_000 });
    try {
      await runner.start();
      expect(processNext).toHaveBeenCalled();
      expect(() => runner.claimControl.hold()).toThrow('does not support live claim control');
    } finally { await runner.stop(); }
  });

  it('allows a successor runner to execute accepted work on the same publisher after ordinary stop', async () => {
    const store = new OxigraphStore();
    const execute = vi.fn(async () => { throw new Error('test execution boundary reached'); });
    const publisher = new TripleStoreAsyncLiftPublisher(store, { knowledgeAssetVmPublishHandler: { execute } });
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });
    const first = new AsyncLiftRunner({ publisher, walletIds: ['wallet-1'], pollIntervalMs: 60_000 });
    const second = new AsyncLiftRunner({ publisher, walletIds: ['wallet-1'], pollIntervalMs: 60_000 });
    try {
      const retiringControl = first.claimControl;
      await first.start(); await first.stop();
      await expect(retiringControl.release()).rejects.toThrow('stopped');
      expect(publisher.claimControl.state).toBe('running');
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await second.start();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(second.claimControl.state).toBe('running');
    } finally { await first.stop(); await second.stop(); await store.close(); }
  });

});
