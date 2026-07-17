import { afterEach, describe, expect, it, vi } from 'vitest';

import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

describe('durable sync deadline budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a caller-supplied bounded total budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createContextGraphSyncDeadline.call(
        {} as any,
        1,
        299_000,
      ),
    ).toBe(1_299_000);
  });

  it('clamps untrusted oversized budgets to five minutes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createContextGraphSyncDeadline.call(
        {} as any,
        1,
        900_000,
      ),
    ).toBe(1_300_000);
  });

  it('preserves the two-minute default for normal sync callers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createContextGraphSyncDeadline.call(
        {} as any,
        1,
      ),
    ).toBe(1_120_000);
  });
});
