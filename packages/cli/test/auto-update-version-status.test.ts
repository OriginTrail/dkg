import { describe, expect, it } from 'vitest';
import { deriveAutoUpdateVersionStatus } from '../src/daemon/auto-update.js';

describe('deriveAutoUpdateVersionStatus (LogPushWorker projection)', () => {
  const status = (
    overrides: Partial<Parameters<typeof deriveAutoUpdateVersionStatus>[0]>,
  ) => deriveAutoUpdateVersionStatus({
    autoUpdateEnabled: true,
    isUpdating: false,
    checkedAt: 1,
    channelTargetMissing: false,
    upToDate: true,
    ...overrides,
  });

  it('reports a checked missing channel instead of falsely reporting latest', () => {
    expect(status({ channelTargetMissing: true })).toBe('channel-missing');
  });

  it('preserves the remaining status precedence', () => {
    expect(status({ autoUpdateEnabled: false, isUpdating: true })).toBe('disabled');
    expect(status({ isUpdating: true })).toBe('updating');
    expect(status({ checkedAt: 0 })).toBe('unknown');
    expect(status({ upToDate: true })).toBe('latest');
    expect(status({ upToDate: false })).toBe('behind');
  });
});
