import { describe, expect, it, vi } from 'vitest';
import { resolveFinalizedPlacementDecisionV1 } from '../src/internal/finalized-placement-decision.js';
import { privateRepair } from './support/catalog-repair-backoff-fixture.js';
describe('canonical placement decision', () => {
  it('retains unavailable evidence and pinned V1 capacity directly from the canonical lane decision', () => {
    const repair = privateRepair();
    const failure = new Error('accepted policy temporarily unavailable');
    const readLane = vi.fn(() => ({ status: 'unavailable' as const, error: failure }));
    const decision = resolveFinalizedPlacementDecisionV1(repair, readLane);
    expect(readLane).toHaveBeenCalledOnce();
    expect(decision.status).toBe('unavailable');
    if (decision.status !== 'unavailable') throw new Error('expected unavailable placement');
    expect(decision.error).toBe(failure);
    expect(decision.capacityScope).toEqual({ ...repair.inventoryScope, bucketCount: '1' });
  });

  it.each([new Error('unexpected lane read failure'), 'unexpected non-Error lane read failure'])
    ('contains unexpected lane exceptions at the placement boundary: %s', failure => {
      const repair = privateRepair();
      const readLane = vi.fn(() => { throw failure; });
      const decision = resolveFinalizedPlacementDecisionV1(repair, readLane);
      expect(readLane).toHaveBeenCalledOnce();
      expect(decision.status).toBe('unavailable');
      if (decision.status !== 'unavailable') throw new Error('expected unavailable placement');
      if (failure instanceof Error) expect(decision.error).toBe(failure);
      else expect(decision.error.message).toBe(failure);
      expect(decision.capacityScope).toEqual({ ...repair.inventoryScope, bucketCount: '1' });
    });
});
