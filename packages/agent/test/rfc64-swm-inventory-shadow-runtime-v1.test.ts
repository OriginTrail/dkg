import { describe, expect, it } from 'vitest';

import {
  RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1,
  RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1,
  Rfc64SwmInventoryShadowRuntimeV1,
} from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';

describe('RFC-64 SWM inventory shadow runtime', () => {
  it('executes every queued observer while running at most 16 concurrently', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observerCalls = 0;
    let active = 0;
    let maximumActive = 0;

    for (let index = 0; index < RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1; index += 1) {
      expect(runtime.schedule(`asset-${index}`, async () => {
        observerCalls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await blocked;
        active -= 1;
      })).toBe(true);
    }
    expect(runtime.schedule('overflow', async () => {
      observerCalls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await blocked;
      active -= 1;
    })).toBe(true);
    expect(observerCalls).toBe(RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1);
    expect(runtime.inFlightCount).toBe(RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1 + 1);

    const drain = runtime.drain();
    release();
    await drain;
    expect(observerCalls).toBe(RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1 + 1);
    expect(maximumActive).toBe(RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1);
    expect(runtime.inFlightCount).toBe(0);
  });

  it('serializes one asset and lets a VM tombstone suppress a delayed SWM upsert', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    const assetKey = 'public-cg\0author\0assertion';
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const durableRows = new Set<string>();

    expect(runtime.schedule(assetKey, async () => {
      entered();
      await gate;
      if (!runtime.isVmConfirmed(assetKey, '1', 'share-1')) durableRows.add('ka-v1');
    })).toBe(true);
    await started;
    runtime.markVmConfirmed(assetKey, '1', 'share-1');
    const removal = runtime.runExclusive(assetKey, async () => {
      durableRows.delete('ka-v1');
    });
    release();
    await removal;
    await runtime.drain();

    expect(durableRows).toEqual(new Set());
    expect(runtime.inFlightCount).toBe(0);
    expect(runtime.isVmConfirmed(assetKey, '1', 'share-1')).toBe(true);
    expect(runtime.schedule(assetKey, async () => {
      if (!runtime.isVmConfirmed(assetKey, '1', 'share-1')) durableRows.add('late-ka-v1');
    })).toBe(true);
    await runtime.drain();
    expect(durableRows).toEqual(new Set());
    expect(runtime.isVmConfirmed(assetKey, '1', 'share-2')).toBe(false);
    expect(runtime.isVmConfirmed(assetKey, '2', 'share-1')).toBe(false);
  });

  it('bounds retained VM tombstones while keeping the newest replay fence', () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    for (
      let index = 0;
      index <= RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1;
      index += 1
    ) runtime.markVmConfirmed(`asset-${index}`, '1', `share-${index}`);

    expect(runtime.isVmConfirmed('asset-0', '1', 'share-0')).toBe(false);
    expect(runtime.isVmConfirmed(
      `asset-${RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1}`,
      '1',
      `share-${RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1}`,
    )).toBe(true);
  });

  it('serializes one author scope while leaving unrelated scopes concurrent', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });

    const first = runtime.runScopeExclusive('scope-a', async () => {
      events.push('first-enter');
      markFirstEntered();
      await firstGate;
      events.push('first-exit');
      return 1;
    });
    await firstEntered;
    const second = runtime.runScopeExclusive('scope-a', async () => {
      events.push('second');
      return 2;
    });
    const unrelated = runtime.runScopeExclusive('scope-b', async () => {
      events.push('unrelated');
      return 3;
    });
    await expect(unrelated).resolves.toBe(3);
    expect(events).toEqual(['first-enter', 'unrelated']);

    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first-enter', 'unrelated', 'first-exit', 'second']);
  });

  it('fences new observers and drains admitted work before close completes', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    let release!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    expect(runtime.schedule('asset', async () => {
      markEntered();
      await gate;
    })).toBe(true);
    await entered;

    let closed = false;
    const close = runtime.closeAndDrain().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(runtime.schedule('late', async () => undefined)).toBe(false);
    await expect(runtime.runExclusive('late', async () => undefined))
      .rejects.toThrow('observer runtime is closed');

    release();
    await close;
    expect(closed).toBe(true);
    expect(runtime.inFlightCount).toBe(0);
  });

  it('reopens asset and scope admission after a complete restart drain', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    const firstShutdownSignal = runtime.shutdownSignal;
    await runtime.closeAndDrain();
    expect(firstShutdownSignal.aborted).toBe(true);
    expect(runtime.schedule('closed', async () => undefined)).toBe(false);
    await expect(runtime.runScopeExclusive('closed', async () => undefined))
      .rejects.toThrow('runtime is closed');

    runtime.reopen();
    expect(runtime.shutdownSignal).not.toBe(firstShutdownSignal);
    expect(runtime.shutdownSignal.aborted).toBe(false);
    expect(runtime.schedule('asset', async () => undefined)).toBe(true);
    await runtime.drain();
    await expect(runtime.runScopeExclusive('scope', async () => 'ok')).resolves.toBe('ok');
  });

  it('aborts admitted lifecycle waits so shutdown can drain promptly', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });

    expect(runtime.schedule('settling-asset', async () => {
      const signal = runtime.shutdownSignal;
      markEntered();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })).toBe(true);
    await entered;

    await runtime.closeAndDrain();
    expect(runtime.inFlightCount).toBe(0);
  });
});
