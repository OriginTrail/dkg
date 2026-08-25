import { describe, expect, it } from 'vitest';
import { projectRfc64SelectedSwmGraphSyncStatus } from '../src/sync/selected-swm-graph-sync-status.js';

describe('selected RFC-64 graph sync status', () => {
  function status(overrides: Partial<Parameters<
    typeof projectRfc64SelectedSwmGraphSyncStatus
  >[0]> = {}) {
    return projectRfc64SelectedSwmGraphSyncStatus({
      selected: true,
      configuredProviderCount: 1,
      retryRequiredProviderCount: 0,
      terminalProviderCount: 0,
      sharedMemorySynced: false,
      ...overrides,
    });
  }

  it('distinguishes inactive, waiting, continuing, and converged states', () => {
    expect(status({ selected: false }).state).toBe('inactive');
    expect(status({ configuredProviderCount: 0 }).state).toBe('inactive');
    expect(status()).toMatchObject({
      state: 'waiting',
      configuredProviderCount: 1,
      retryRequiredProviderCount: 0,
      terminalProviderCount: 0,
    });
    expect(status({ retryRequiredProviderCount: 1 })).toMatchObject({
      state: 'continuing',
      retryRequiredProviderCount: 1,
    });
    expect(status({ terminalProviderCount: 1 })).toMatchObject({
      state: 'converged',
      terminalProviderCount: 1,
    });
    expect(status({ sharedMemorySynced: true }).state).toBe('converged');
  });

  it('returns an immutable identity-free projection', () => {
    const projected = status({ retryRequiredProviderCount: 1 });
    expect(Object.isFrozen(projected)).toBe(true);
    expect(projected).not.toHaveProperty('providerPeerIds');
  });
});
