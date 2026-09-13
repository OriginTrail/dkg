// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import { CG_REGISTRY_REORG_BUFFER_BLOCKS } from '../src/evm-adapter-base.js';
import {
  MemoryRegistryScanCursorStore,
  REGISTRY,
  collectRegistryScan,
  makeAdapter,
  makeRegistry,
} from './context-graph-registry-scan-fixture.js';

describe('ContextGraph registry historical repair audits', () => {
  it('fails repair closed before chain RPC when the durable repair capability is absent', async () => {
    const store = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow('durable repairAudit load/save capability');
    expect(provider.getBlockNumber.calls).toEqual([]);
    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls).toEqual([]);
  });

  it('bounds and resumes repair audit from an atomic cursor/target without touching the live cursor', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    await store.save(key, 3_400);
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 3_500, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 2,
      minimumIntervalMs: 86_400_000,
    });

    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 999],
      [1_000, 1_999],
    ]);
    expect(store.values.get((store as any).key(key))).toBe(3_400);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      version: 1,
      nextBlock: 2_000,
      targetBlock: 3_500 - CG_REGISTRY_REORG_BUFFER_BLOCKS,
    });

    const restartedRegistry = makeRegistry();
    const { adapter: restarted, provider: restartedProvider } = makeAdapter(restartedRegistry, 3_500, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, {
      mode: 'repair',
      pageBudget: 2,
      minimumIntervalMs: 86_400_000,
    });

    expect(restartedRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_000, 2_999],
      [3_000, 3_450],
    ]);
    expect(store.values.get((store as any).key(key))).toBe(3_400);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 3_451,
      targetBlock: 3_450,
      completedAt: expect.any(Number),
    });

    restartedRegistry.queryFilter.clear();
    restartedProvider.getBlockNumber.clear();
    restartedProvider.getCode.clear();
    await collectRegistryScan(restarted, {
      mode: 'repair',
      pageBudget: 2,
      minimumIntervalMs: 86_400_000,
    });
    expect(restartedRegistry.queryFilter.calls).toEqual([]);
    expect(restartedProvider.getBlockNumber.calls).toEqual([]);
    expect(restartedProvider.getCode.calls).toEqual([]);

    const completed = store.repairAudits.get((store as any).key(key)) as Record<string, unknown>;
    store.repairAudits.set((store as any).key(key), {
      ...completed,
      completedAt: Date.now() - 86_400_001,
    });
    const renewedRegistry = makeRegistry();
    const { adapter: renewed } = makeAdapter(renewedRegistry, 4_000, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    renewedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(renewed, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });
    expect(renewedRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 1_000,
      targetBlock: 3_950,
    });
    expect(store.repairAudits.get((store as any).key(key))).not.toHaveProperty('completedAt');
  });

  it('replaces an incomplete repair generation anchored beyond the current stable head', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    const oldStartedAt = Date.now() - 10_000;
    store.repairAudits.set((store as any).key(key), {
      version: 1,
      nextBlock: 2_000,
      targetBlock: 9_000,
      startedAt: oldStartedAt,
    });
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });

    expect(registry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      version: 1,
      nextBlock: 1_000,
      targetBlock: 2_050,
    });
    expect((store.repairAudits.get((store as any).key(key)) as any).startedAt)
      .toBeGreaterThan(oldStartedAt);
  });

  it('does not advance repair progress when atomic checkpoint persistence rejects', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    const durableSave = store.repairAudit.save;
    let saveCalls = 0;
    store.repairAudit.save = async (cursorKey, checkpoint) => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error('repair checkpoint unavailable');
      await durableSave(cursorKey, checkpoint);
    };
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);
    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    })[Symbol.asyncIterator]();
    const page = await iterator.next();
    expect(page.done).toBe(false);
    await expect(page.value.ack()).rejects.toThrow('repair checkpoint unavailable');
    await iterator.return?.();
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 0,
      targetBlock: 2_050,
    });
    expect(store.repairAudits.get((store as any).key(key))).not.toHaveProperty('completedAt');

    store.repairAudit.save = durableSave;
    registry.queryFilter.clear();
    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });
    expect(registry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
    expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
      nextBlock: 1_000,
      targetBlock: 2_050,
    });

    const restartedRegistry = makeRegistry();
    const { adapter: restarted } = makeAdapter(restartedRegistry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });
    expect(restartedRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[1_000, 1_999]]);
  });

  it('rejects inconsistent persisted repair checkpoints and cannot be suppressed by future time', async () => {
    const now = Date.now();
    const invalidCheckpoints = [
      { version: 1, nextBlock: 101, targetBlock: 100, startedAt: now },
      { version: 1, nextBlock: 100, targetBlock: 100, startedAt: now - 2, completedAt: now - 1 },
      { version: 1, nextBlock: 101, targetBlock: 100, startedAt: now, completedAt: now - 1 },
      {
        version: 1,
        nextBlock: 101,
        targetBlock: 100,
        startedAt: now,
        completedAt: now + 24 * 60 * 60 * 1_000,
      },
      {
        version: 1,
        nextBlock: 100,
        targetBlock: 100,
        startedAt: now + 24 * 60 * 60 * 1_000,
      },
    ];

    for (const invalid of invalidCheckpoints) {
      const store = new MemoryRegistryScanCursorStore();
      const key = {
        chainId: 'evm:31337',
        deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
        registryAddress: REGISTRY,
      };
      store.repairAudits.set((store as any).key(key), invalid);
      const registry = makeRegistry();
      const { adapter } = makeAdapter(registry, 2_100, {
        contextGraphRegistryScanCursorStore: store,
      });
      registry.queryFilter.setImpl(async () => []);

      await collectRegistryScan(adapter, {
        mode: 'repair',
        pageBudget: 1,
        minimumIntervalMs: 86_400_000,
      });

      expect(registry.queryFilter.calls).toHaveLength(1);
      expect(store.repairAudits.get((store as any).key(key))).toMatchObject({
        version: 1,
        nextBlock: 2_000,
        targetBlock: 2_100 - CG_REGISTRY_REORG_BUFFER_BLOCKS,
        startedAt: expect.any(Number),
      });
    }
  });

  it('keeps repair pages below the protected live reorg window and rejects overlap', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 2_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    const first = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    })[Symbol.asyncIterator]();
    const page = await first.next();
    expect(page.done).toBe(false);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [0, 1_999],
    ]);
    const overlap = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 1,
    })[Symbol.asyncIterator]();
    await expect(overlap.next()).resolves.toMatchObject({ done: true });
    await page.value.ack();
    await first.next();
    expect(store.repairAudits.values().next().value).toMatchObject({ targetBlock: 2_050 });
  });

  it('makes the 30-logical-page repair ceiling observable independently from provider retries', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 100_000, {
      cgRegistryScanPageSize: 100,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'repair',
      pageBudget: 30,
      minimumIntervalMs: 86_400_000,
    })[Symbol.asyncIterator]();
    const progress: NonNullable<Awaited<ReturnType<typeof iterator.next>>['value']['scanProgress']>[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.scanProgress) progress.push(next.value.scanProgress);
      await next.value.ack();
    }

    expect(registry.queryFilter.calls).toHaveLength(30);
    expect(registry.queryFilter.calls.at(0)?.slice(1)).toEqual([0, 99]);
    expect(registry.queryFilter.calls.at(-1)?.slice(1)).toEqual([2_900, 2_999]);
    expect(store.repairAudits.values().next().value).toMatchObject({
      nextBlock: 3_000,
      targetBlock: 100_000 - CG_REGISTRY_REORG_BUFFER_BLOCKS,
    });
    expect(progress).toHaveLength(30);
    expect(progress.at(-1)).toMatchObject({
      mode: 'repair',
      page: 30,
      pageBudget: 30,
      fromBlock: 2_900,
      toBlock: 2_999,
      targetBlock: 99_950,
      completesGeneration: false,
    });
  });

  it('attributes live and repair eth_getLogs pages to distinct bounded consumers', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 2_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);
    const queryPage = vi.spyOn(adapter as any, 'queryEventLogsPage');

    await collectRegistryScan(adapter, { mode: 'seedFromCursor', pageBudget: 1 });
    await collectRegistryScan(adapter, {
      mode: 'repair',
      pageBudget: 1,
      minimumIntervalMs: 86_400_000,
    });

    expect(queryPage.mock.calls.map((call) => call.at(-1))).toEqual([
      'listContextGraphsFromChain',
      'repairContextGraphRegistry',
    ]);
  });

});
