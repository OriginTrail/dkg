import { describe, expect, it } from 'vitest';

import {
  RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1,
  Rfc64SwmInventoryShadowRuntimeV1,
} from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';

describe('RFC-64 SWM inventory shadow runtime', () => {
  it('admits at most 16 detached observers and releases every admitted slot on drain', async () => {
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observerCalls = 0;

    for (let index = 0; index < RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1; index += 1) {
      expect(runtime.schedule(() => {
        observerCalls += 1;
        return blocked;
      })).toBe(true);
    }
    expect(runtime.schedule(() => {
      observerCalls += 1;
      return blocked;
    })).toBe(false);
    expect(observerCalls).toBe(RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1);
    expect(runtime.inFlightCount).toBe(RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1);

    const drain = runtime.drain();
    release();
    await drain;
    expect(runtime.inFlightCount).toBe(0);
  });
});
