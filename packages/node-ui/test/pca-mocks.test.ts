// E3 — shared PCA fixtures: integrity guard (each fixture maps to its intended
// health; the B8 sample yields the right discount). Keeps the fixtures honest so
// component tests that build on them can't silently drift.

import { describe, expect, it } from 'vitest';
import { PCA_FIXTURES, MOCK_COST_COVERED } from '../src/ui/mocks/pca.js';
import { healthForSnapshot, convictionDiscountBps } from '../src/ui/components/Pca/index.js';

describe('PCA fixtures', () => {
  it('each fixture derives its intended HealthChip state', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(healthForSnapshot(PCA_FIXTURES.healthy, now)).toBe('healthy');
    expect(healthForSnapshot(PCA_FIXTURES.expiring, now)).toBe('expiring');
    expect(healthForSnapshot(PCA_FIXTURES.expired, now)).toBe('expired');
    expect(healthForSnapshot(PCA_FIXTURES.swept, now)).toBe('swept');
    expect(healthForSnapshot(PCA_FIXTURES.capNear, now)).toBe('cap-near');
    // P0 does NOT derive insolvent (deferred to P2) — a 0-budget account still
    // reads healthy here; this guards that deferral.
    expect(healthForSnapshot(PCA_FIXTURES.insolvent, now)).toBe('healthy');
  });

  it('the B8 CostCovered sample yields 30%', () => {
    expect(convictionDiscountBps(MOCK_COST_COVERED)).toBe(3000);
  });
});
