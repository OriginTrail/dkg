import { describe, expect, it, vi } from 'vitest';
import { DKGAgent, type FinalizationRecoveryStoreFactory } from '../src/index.js';

describe('finalization recovery store factory configuration', () => {
  it('fails before invoking a recovery-store factory when dataDir is absent', async () => {
    const factory = vi.fn<FinalizationRecoveryStoreFactory>();

    await expect(DKGAgent.create({
      name: 'invalid-pathless-recovery-store',
      finalizationRecoveryStoreFactory: factory,
    })).rejects.toThrow('finalizationRecoveryStoreFactory requires dataDir');

    expect(factory).not.toHaveBeenCalled();
  });
});
