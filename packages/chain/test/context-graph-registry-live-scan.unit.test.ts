// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { CG_REGISTRY_REORG_BUFFER_BLOCKS } from '../src/evm-adapter-base.js';
import {
  MemoryRegistryScanCursorStore,
  REGISTRY,
  collectRegistryScan,
  makeAdapter,
  makeRegistry,
  seam,
} from './context-graph-registry-scan-fixture.js';

describe('ContextGraph registry live cursor scans', () => {
  it('seeds a missing live watermark at the current tail while repair owns historical backfill', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('live-tail bootstrap must not probe the deploy block');
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'seedLiveTail', pageBudget: 30 });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_100 + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
    ]);
    expect(store.saves.map((save) => save.nextBlock)).toEqual([2_101]);

    const restartedRegistry = makeRegistry();
    const { adapter: restarted, provider: restartedProvider } = makeAdapter(restartedRegistry, 2_200, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedProvider.getCode = seam(async () => {
      throw new Error('incremental restart must not probe the deploy block');
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, { mode: 'incremental', pageBudget: 30 });

    expect(restartedProvider.getCode.calls).toEqual([]);
    expect(restartedRegistry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_101 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_200],
    ]);
  });

  it('replaces a corrupt live watermark with a bounded current-tail seed', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    store.values.set((store as any).key(key), 0);
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('corrupt-watermark recovery must not probe deploy history');
    });
    registry.queryFilter.setImpl(async () => []);

    await expect(adapter.hasContextGraphRegistryScanWatermark()).resolves.toBe(false);
    await collectRegistryScan(adapter, { mode: 'seedLiveTail', pageBudget: 30 });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(([, lo, hi]: [unknown, number, number]) => [lo, hi])).toEqual([
      [2_100 + 1 - CG_REGISTRY_REORG_BUFFER_BLOCKS, 2_100],
    ]);
    expect(store.values.get((store as any).key(key))).toBe(2_101);
  });

  it('replaces a live watermark beyond the bounded rollback window and resumes after restart', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const key = {
      chainId: 'evm:31337',
      deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
      registryAddress: REGISTRY,
    };
    await store.save(key, 9_000);
    const registry = makeRegistry();
    const { adapter, provider } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    provider.getCode = seam(async () => {
      throw new Error('rollback recovery must not probe deployment history');
    });
    registry.queryFilter.setImpl(async () => []);

    await collectRegistryScan(adapter, { mode: 'incremental', pageBudget: 1 });

    expect(provider.getCode.calls).toEqual([]);
    expect(registry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[2_051, 2_100]]);
    expect(store.values.get((store as any).key(key))).toBe(2_101);

    const restartedRegistry = makeRegistry();
    const { adapter: restarted } = makeAdapter(restartedRegistry, 2_200, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    restartedRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(restarted, { mode: 'incremental', pageBudget: 1 });
    expect(restartedRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[2_051, 2_200]]);
    expect(store.values.get((store as any).key(key))).toBe(2_201);
  });

  it.each([
    { mode: 'seedLiveTail' as const, watermark: undefined },
    { mode: 'incremental' as const, watermark: 2_051 },
  ])(
    'fails $mode before log RPC when its live budget cannot traverse the reorg prefix',
    async ({ mode, watermark }) => {
      const store = new MemoryRegistryScanCursorStore();
      const key = {
        chainId: 'evm:31337',
        deploymentId: 'evm:31337:hub=0x0000000000000000000000000000000000000001',
        registryAddress: REGISTRY,
      };
      if (watermark !== undefined) await store.save(key, watermark);
      const registry = makeRegistry();
      const { adapter } = makeAdapter(registry, 2_100, {
        cgRegistryScanPageSize: 1,
        contextGraphRegistryScanCursorStore: store,
      });
      registry.queryFilter.setImpl(async () => []);
      const iterator = adapter.scanContextGraphRegistryPages({
        mode,
        pageBudget: 30,
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toThrow(
        'live page budget 30 at 1 block(s)/page cannot cover the reorg overlap/current-head progression',
      );
      expect(registry.queryFilter.calls).toEqual([]);
      expect(store.values.get((store as any).key(key))).toBe(watermark);
    },
  );

  it('owns live scans exclusively and rejects skipped, duplicate, concurrent, and late acknowledgements', async () => {
    const store = new MemoryRegistryScanCursorStore();
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const durableSave = store.save.bind(store);
    let blockSave = true;
    store.save = async (key, nextBlock) => {
      if (blockSave) await saveGate;
      await durableSave(key, nextBlock);
    };
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);

    const owner = adapter.scanContextGraphRegistryPages({
      mode: 'seedFromCursor',
      pageBudget: 2,
    })[Symbol.asyncIterator]();
    const first = await owner.next();
    expect(first.done).toBe(false);
    const overlap = adapter.scanContextGraphRegistryPages({
      mode: 'incremental',
      pageBudget: 1,
    })[Symbol.asyncIterator]();
    await expect(overlap.next()).rejects.toThrow('already has an active cursor owner');

    const saving = first.value.ack();
    await Promise.resolve();
    await expect(first.value.ack()).rejects.toThrow('exactly once');
    releaseSave?.();
    await saving;
    await expect(first.value.ack()).rejects.toThrow('exactly once');
    const second = await owner.next();
    expect(second.done).toBe(false);
    await owner.return?.();
    await expect(second.value.ack()).rejects.toThrow('stale or no longer owned');

    blockSave = false;
    const skipped = adapter.scanContextGraphRegistryPages({
      mode: 'incremental',
      pageBudget: 2,
    })[Symbol.asyncIterator]();
    const skippedPage = await skipped.next();
    expect(skippedPage.done).toBe(false);
    await expect(skipped.next()).rejects.toThrow('must be acknowledged before scanning continues');
  });

  it('leaves an aborted live page unacknowledged for restart replay', async () => {
    const store = new MemoryRegistryScanCursorStore();
    const registry = makeRegistry();
    const { adapter } = makeAdapter(registry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    registry.queryFilter.setImpl(async () => []);
    const controller = new AbortController();
    const iterator = adapter.scanContextGraphRegistryPages({
      mode: 'seedFromCursor',
      pageBudget: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const page = await iterator.next();
    expect(page.done).toBe(false);

    controller.abort(new Error('daemon closing'));
    await expect(page.value.ack()).rejects.toThrow('daemon closing');
    await iterator.return?.();
    expect(store.saves).toEqual([]);

    const replayRegistry = makeRegistry();
    const { adapter: replay } = makeAdapter(replayRegistry, 2_100, {
      cgRegistryScanPageSize: 1_000,
      contextGraphRegistryScanCursorStore: store,
    });
    replayRegistry.queryFilter.setImpl(async () => []);
    await collectRegistryScan(replay, { mode: 'seedFromCursor', pageBudget: 1 });
    expect(replayRegistry.queryFilter.calls.map(
      ([, lo, hi]: [unknown, number, number]) => [lo, hi],
    )).toEqual([[0, 999]]);
  });

});
