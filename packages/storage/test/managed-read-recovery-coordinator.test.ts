import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedReadRecoveryCoordinatorV1 } from
  '../src/managed-read-recovery-coordinator.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ManagedReadRecoveryCoordinatorV1', () => {
  it('does not let a stale token replace the current store generation timer', async () => {
    const state = { recovering: false, generation: 0 };
    const recover = vi.fn();
    const coordinator = new ManagedReadRecoveryCoordinatorV1({
      now: () => 0,
      capability: {
        readState: () => ({ ...state }),
        recover,
      },
    });

    const staleToken = coordinator.begin({ ...state });
    state.generation = 1;
    const currentToken = coordinator.begin({ ...state });

    coordinator.retain('construct', 1_000, currentToken);
    coordinator.retain('query', 500, staleToken);

    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledExactlyOnceWith('construct');
  });
});
