import { afterEach, expect, it, vi } from 'vitest';
import { activeDefaultStoreWorkPriority, GraphManager, StorePriorityScheduler } from '@origintrail-official/dkg-storage';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';

afterEach(() => vi.restoreAllMocks());

it('keeps host discovery and reconciliation off the foreground store lane', async () => {
  const scheduler = new StorePriorityScheduler();
  const priorities: Array<string | undefined> = [];
  const record = async () => {
    priorities.push(activeDefaultStoreWorkPriority());
    await scheduler.run(activeDefaultStoreWorkPriority(), 'maintenance-fixture', async () => {
      expect(scheduler.snapshot.normalInflight).toBe(0);
      expect(scheduler.snapshot.backgroundInflight).toBe(1);
    });
  };
  vi.spyOn(GraphManager.prototype, 'listContextGraphs').mockImplementation(async () => {
    await record(); return ['alpha', 'beta'];
  });
  const agent = { store: {}, swmHostModeStore: {}, config: { swmHostMode: { reconcileBatchSize: 2 } },
    hostModeReconcileCursor: 0, hostModeReconcileInflight: undefined,
    reconcileSwmHostModeSubscription: record };
  await SwmHostModeMethods.prototype.reconcileHostModeSubscriptions.call(agent as never);
  expect(priorities).toEqual(['background', 'background', 'background']);
  expect(agent.hostModeReconcileInflight).toBeUndefined();
  expect(activeDefaultStoreWorkPriority()).toBeUndefined();
});
