import { describe, expect, it } from 'vitest';
import {
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_JITTER,
  SYNC_BACKOFF_MAX_MS,
  SYNC_RECONCILER_INTERVAL_MS,
  SYNC_STALENESS_THRESHOLD_MS,
} from '../src/dkg-agent-constants.js';
import { resolveSyncReconcilerTiming } from '../src/sync/reconciler-timing.js';

describe('resolveSyncReconcilerTiming', () => {
  it('uses the stable defaults when the operator omits timing', () => {
    expect(resolveSyncReconcilerTiming({})).toEqual({
      intervalMs: SYNC_RECONCILER_INTERVAL_MS,
      stalenessThresholdMs: SYNC_STALENESS_THRESHOLD_MS,
      backoffBaseMs: SYNC_BACKOFF_BASE_MS,
      backoffMaxMs: SYNC_BACKOFF_MAX_MS,
      backoffJitter: SYNC_BACKOFF_JITTER,
    });
  });

  it('accepts short bounded timing for a local validation node', () => {
    expect(resolveSyncReconcilerTiming({
      syncReconcilerIntervalMs: 10_000,
      syncStalenessThresholdMs: 20_000,
      syncBackoffBaseMs: 5_000,
      syncBackoffMaxMs: 30_000,
      syncBackoffJitter: 0.1,
    })).toEqual({
      intervalMs: 10_000,
      stalenessThresholdMs: 20_000,
      backoffBaseMs: 5_000,
      backoffMaxMs: 30_000,
      backoffJitter: 0.1,
    });
  });

  it('rejects invalid values and never sets the maximum below the base', () => {
    expect(resolveSyncReconcilerTiming({
      syncReconcilerIntervalMs: 0,
      syncStalenessThresholdMs: Number.NaN,
      syncBackoffBaseMs: 30_000,
      syncBackoffMaxMs: 5_000,
      syncBackoffJitter: 2,
    })).toEqual({
      intervalMs: SYNC_RECONCILER_INTERVAL_MS,
      stalenessThresholdMs: SYNC_STALENESS_THRESHOLD_MS,
      backoffBaseMs: 30_000,
      backoffMaxMs: 30_000,
      backoffJitter: SYNC_BACKOFF_JITTER,
    });
  });

  it('does not let an oversized Node.js timer become a one-millisecond loop', () => {
    expect(resolveSyncReconcilerTiming({
      syncReconcilerIntervalMs: 2_147_483_648,
      syncStalenessThresholdMs: 2_147_483_648,
      syncBackoffBaseMs: 2_147_483_648,
      syncBackoffMaxMs: 2_147_483_648,
    })).toMatchObject({
      intervalMs: SYNC_RECONCILER_INTERVAL_MS,
      stalenessThresholdMs: SYNC_STALENESS_THRESHOLD_MS,
      backoffBaseMs: SYNC_BACKOFF_BASE_MS,
      backoffMaxMs: SYNC_BACKOFF_MAX_MS,
    });
  });
});
