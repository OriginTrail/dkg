import { describe, expect, it, vi } from 'vitest';
import { executeCoreRollbackActivation } from '../src/commands/maintenance.js';

describe('maintenance command shutdown gate', () => {
  it('aborts Core rollback before swapping slots when daemon shutdown times out', async () => {
    const swapSlot = vi.fn(async () => {});
    const errors: string[] = [];

    await expect(executeCoreRollbackActivation('b', {
      stopDaemon: async () => false,
      swapSlot,
      error: (message) => errors.push(message),
    })).resolves.toBe(false);

    expect(swapSlot).not.toHaveBeenCalled();
    expect(errors).toEqual([
      'Rollback aborted because the daemon did not stop before its configured shutdown deadline.',
    ]);
  });
});
