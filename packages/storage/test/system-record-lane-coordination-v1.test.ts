import { describe, expect, it } from 'vitest';

import { SystemRecordTransitionCoordinatorV1 } from '../src/system-record-lane-coordination-v1-internal.js';

describe('system-record transition settlement ownership', () => {
  it('rejects accidental ownership registration after another transition is published', () => {
    const coordinator = new SystemRecordTransitionCoordinatorV1<object>();
    const superseded = Object.freeze({ transition: 'superseded' });
    const current = Object.freeze({ transition: 'current' });
    coordinator.publish(superseded);
    coordinator.publish(current);

    expect(() => coordinator.ownSettlement(superseded, Promise.resolve()))
      .toThrow(/not the active transition/);
  });

  it('drains an explicitly owned superseded settlement and its current successor', async () => {
    const coordinator = new SystemRecordTransitionCoordinatorV1<object>();
    const first = Object.freeze({ transition: 'first' });
    const second = Object.freeze({ transition: 'second' });
    let releaseFirst!: () => void;
    const firstSettlement = new Promise<void>((resolve) => { releaseFirst = resolve; });
    coordinator.publish(first);
    coordinator.ownSettlement(first, firstSettlement);
    coordinator.publish(second);
    coordinator.ownSettlement(second, Promise.resolve());

    let drained = false;
    const drain = coordinator.drainSettlements().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    releaseFirst();
    await drain;
    expect(drained).toBe(true);
  });
});
