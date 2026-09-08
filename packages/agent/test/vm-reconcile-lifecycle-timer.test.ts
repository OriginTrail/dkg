import { expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import type { VmReconcileDispatcher } from '../src/chain-reconciler.js';
import type { ContextGraphReconcileResult } from '../src/vm-reconcile-service.js';

interface TimerInternals {
  subscribedContextGraphs: Map<string, { subscribed: boolean; onChainId?: string }>;
  vmReconcileStartupTimer: ReturnType<typeof setTimeout> | null;
  vmReconcileTimer: ReturnType<typeof setInterval> | null;
  scheduleVmReconcileSweep(): void;
  log: { warn(ctx: OperationContext, message: string): void };
}

it.each([false, true])('runs lifecycle startup and later interval admissions with an active worker (throw=%s)', async failTick => {
  const startup = Object.getOwnPropertyDescriptor(DKGAgentBase, 'VM_RECONCILE_STARTUP_MAX_DELAY_MS')!;
  const interval = Object.getOwnPropertyDescriptor(DKGAgentBase, 'VM_RECONCILE_SWEEP_INTERVAL_MS')!;
  Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_STARTUP_MAX_DELAY_MS', { ...startup, value: 50 });
  Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SWEEP_INTERVAL_MS', { ...interval, value: 100 });
  const agent = await DKGAgent.create({
    name: 'VmTimerWiring', listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(), syncReconcilerEnabled: true,
    rfc64CatalogActivation: { enabled: false },
  });
  const internals = agent as unknown as TimerInternals;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const execute = vi.spyOn(agent, 'executeVmReconcileForCg').mockImplementation(async (contextGraphId, source) => {
    await blocked;
    return {
      contextGraphId, onChainId: '1', source, status: 'current', attempted: true,
      headOrdinal: 0, watermarkBefore: 0, watermarkAfter: 0, reconciledOrdinals: 0, unresolvedOrdinals: 0,
    };
  });
  const originalEnsure = agent.ensureVmReconcileDispatcher.bind(agent);
  let dispatcher: VmReconcileDispatcher<ContextGraphReconcileResult> | undefined;
  let fakeTimers = false;
  vi.spyOn(agent, 'ensureVmReconcileDispatcher').mockImplementation(() => {
    dispatcher = originalEnsure();
    // Keep network startup on real timers. The final lifecycle boundary below
    // is the actual production owner that arms the startup/interval callbacks.
    if (!fakeTimers) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      fakeTimers = true;
    }
    return dispatcher;
  });
  const schedule = vi.spyOn(internals, 'scheduleVmReconcileSweep');
  const warn = vi.spyOn(internals.log, 'warn');
  try {
    expect(agent.vmReconcileEnabled()).toBe(true);
    await agent.start();
    internals.subscribedContextGraphs.clear();
    internals.subscribedContextGraphs.set('bound', { subscribed: true, onChainId: '1' });
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dispatcher!.snapshot()).toMatchObject({ active: 1, queued: 0 });
    if (failTick) schedule.mockImplementationOnce(() => { throw new Error('scheduler unavailable'); });
    await vi.advanceTimersByTimeAsync(100);
    if (failTick) {
      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('VM reconcile sweep failed: scheduler unavailable'));
      expect(dispatcher!.snapshot()).toMatchObject({ active: 1, queued: 0 });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(schedule).toHaveBeenCalledTimes(failTick ? 3 : 2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dispatcher!.snapshot()).toMatchObject({ active: 1, queued: 1 });
  } finally {
    release();
    if (internals.vmReconcileStartupTimer) clearTimeout(internals.vmReconcileStartupTimer);
    if (internals.vmReconcileTimer) clearInterval(internals.vmReconcileTimer);
    internals.vmReconcileStartupTimer = null;
    internals.vmReconcileTimer = null;
    await dispatcher?.close();
    vi.useRealTimers();
    await agent.stop();
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_STARTUP_MAX_DELAY_MS', startup);
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_SWEEP_INTERVAL_MS', interval);
    vi.restoreAllMocks();
  }
});
