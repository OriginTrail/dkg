import { describe, expect, it } from 'vitest';

import { resolveUpdateTelemetryVersionStatus } from '../src/daemon/update-telemetry-status.js';
import type { LastUpdateCheck } from '../src/daemon/state.js';

function lastCheck(overrides: Partial<LastUpdateCheck> = {}): LastUpdateCheck {
  return {
    upToDate: true,
    checkedAt: 1,
    latestCommit: '',
    latestVersion: '',
    channelTargetMissing: false,
    ...overrides,
  };
}

describe('update telemetry version status', () => {
  it.each([
    {
      expected: 'disabled',
      autoUpdateEnabled: false,
      isUpdating: true,
      check: lastCheck({ checkedAt: 0, channelTargetMissing: true }),
    },
    {
      expected: 'updating',
      autoUpdateEnabled: true,
      isUpdating: true,
      check: lastCheck({ checkedAt: 0, channelTargetMissing: true }),
    },
    {
      expected: 'unknown',
      autoUpdateEnabled: true,
      isUpdating: false,
      check: lastCheck({ checkedAt: 0, channelTargetMissing: true }),
    },
    {
      expected: 'channel-missing',
      autoUpdateEnabled: true,
      isUpdating: false,
      check: lastCheck({ channelTargetMissing: true }),
    },
    {
      expected: 'latest',
      autoUpdateEnabled: true,
      isUpdating: false,
      check: lastCheck({ upToDate: true }),
    },
    {
      expected: 'behind',
      autoUpdateEnabled: true,
      isUpdating: false,
      check: lastCheck({ upToDate: false }),
    },
  ])('returns $expected with the documented precedence', ({
    expected,
    autoUpdateEnabled,
    isUpdating,
    check,
  }) => {
    expect(resolveUpdateTelemetryVersionStatus({
      autoUpdateEnabled,
      isUpdating,
      lastUpdateCheck: check,
    })).toBe(expected);
  });
});
