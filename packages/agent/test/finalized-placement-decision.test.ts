import { describe, expect, it, vi } from 'vitest';
import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { finalizedPlacementDecisionInputV1, resolveFinalizedPlacementDecisionV1, type PlacementLaneV1 } from '../src/internal/finalized-placement-decision.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { authorSealV1 } from './support/rfc64-local-catalog-repair-fixture.js';
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

  it('keeps a marker decision only on what the decision reads of the lane', async () => {
    const legacy = privateRepair();
    if (legacy.version !== 1) throw new Error('expected pinned legacy fixture');
    const seal = await authorSealV1(102n);
    const current: Rfc64FinalizedPrivatePlacementRepairV1 = {
      ...legacy, version: 2, inventoryScope: null, subGraphName: null,
      authorAddress: seal.authorAddress, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal,
    };
    const lanes = ([['private', true], ['private', false], ['public', false]] as const)
      .map(([kind, acceptsFinalizedVmRepair]) => ({ kind, acceptsFinalizedVmRepair, scopeBase: legacy.inventoryScope }));
    const read = new Set<string | symbol>();
    for (const lane of lanes) {
      const watched = new Proxy(lane, { get(target, field, receiver) { read.add(field); return Reflect.get(target, field, receiver); } });
      for (const repair of [legacy, current]) {
        resolveFinalizedPlacementDecisionV1(repair, () => ({ status: 'active', lane: watched as PlacementLaneV1 }));
      }
    }
    // A field added here belongs in finalizedPlacementDecisionInputV1 as well, or kept decisions go stale.
    expect([...read].sort()).toEqual(['acceptsFinalizedVmRepair', 'kind', 'scopeBase']);
    const inputs = lanes.map((lane) => finalizedPlacementDecisionInputV1({ status: 'active', lane: lane as PlacementLaneV1 }));
    expect(new Set(inputs).size).toBe(lanes.length);
    const nextEra = { ...lanes[0]!, scopeBase: { ...lanes[0]!.scopeBase, era: `${lanes[0]!.scopeBase.era}1` } };
    expect(finalizedPlacementDecisionInputV1({ status: 'active', lane: nextEra as PlacementLaneV1 })).not.toBe(inputs[0]);
    expect(finalizedPlacementDecisionInputV1({ status: 'inactive' })).toBe('inactive');
    expect(finalizedPlacementDecisionInputV1({ status: 'unavailable', error: new Error('unavailable') })).toBeUndefined();
  });
});
