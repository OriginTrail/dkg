import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/dkg-agent.js';
import { createDurableRecoveryHost } from '../src/dkg-agent-recovery.js';
import type { VerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import * as cleanup from '../src/sync/requester/post-materialization.js';

afterEach(() => vi.restoreAllMocks());

it('binds lazy verification and one reconciliation adapter at the agent boundary', async () => {
  const parseAndFilter = vi.fn(async () => ({ quads: [] }));
  const worker = { parseAndFilter };
  const agent = {
    store: {}, writeLocks: new Map(), log: {},
    getOrCreateSyncVerifyWorker: vi.fn(() => worker),
    processDurableBatchInWorker: vi.fn(async function (this: unknown) {
      expect(this).toBe(agent); return { dataQuads: [] };
    }),
    invalidateListContextGraphsCache: vi.fn(),
    retireFinalizedSwmTwinCandidate: vi.fn(async () => {}),
    retireLegacySwmAfterVerifiedVmTwin: vi.fn(async () => {}),
  };
  const reconcile = vi.spyOn(cleanup, 'reconcileAfterMaterialization').mockResolvedValue();
  const host = createDurableRecoveryHost(agent as unknown as DKGAgent);
  const ctx = createOperationContext('sync');
  const asset = { ual: 'asset' } as VerifiedGraphScopedAsset;
  expect(agent.getOrCreateSyncVerifyWorker).not.toHaveBeenCalled();
  await host.verification.parseAndFilter('payload', 'graph', 'cg');
  expect(agent.getOrCreateSyncVerifyWorker).toHaveBeenCalledOnce();
  expect(parseAndFilter).toHaveBeenCalledWith('payload', 'graph', 'cg');
  await host.verification.processBatch([], [], ctx, false);
  expect(agent.processDurableBatchInWorker).toHaveBeenCalledWith([], [], ctx, false);
  await host.reconcile(asset, ctx); await host.reconcile(asset, ctx);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(reconcile.mock.calls[0]![0]).toBe(reconcile.mock.calls[1]![0]);
  const adapter = reconcile.mock.calls[0]![0];
  expect(adapter.store).toBe(agent.store);
  expect(adapter.writeLocks).toBe(agent.writeLocks);
  adapter.invalidateListContextGraphsCache();
  expect(agent.invalidateListContextGraphsCache).toHaveBeenCalledOnce();
  expect(reconcile.mock.calls[0]!.slice(1)).toEqual([asset, ctx]);
});
