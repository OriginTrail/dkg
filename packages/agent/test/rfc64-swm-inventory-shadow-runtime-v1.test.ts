import { describe, expect, it } from 'vitest';

import {
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
      if (!runtime.isVmConfirmed(assetKey, '1')) durableRows.add('ka-v1');
    })).toBe(true);
    await started;
    runtime.markVmConfirmed(assetKey, '1');
    const removal = runtime.runExclusive(assetKey, async () => {
      durableRows.delete('ka-v1');
    });
    release();
    await removal;
    await runtime.drain();

    expect(durableRows).toEqual(new Set());
    expect(runtime.inFlightCount).toBe(0);
    expect(runtime.isVmConfirmed(assetKey, '1')).toBe(false);
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

});
