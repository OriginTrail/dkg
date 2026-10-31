import { describe, expect, it, vi } from 'vitest';
import { computeCanonicalGraphScopedAuthorSealDigestV1 } from '@origintrail-official/dkg-core';
import { finalizedPlacementAuthorityRevisionV1, resolveFinalizedPlacementDecisionV1, type PlacementLaneV1 } from '../src/internal/finalized-placement-decision.js';
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

  it('names in the lane revision everything the decision reads of the lane', async () => {
    const legacy = privateRepair();
    if (legacy.version !== 1) throw new Error('expected pinned legacy fixture');
    const seal = await authorSealV1(102n);
    const current: Rfc64FinalizedPrivatePlacementRepairV1 = {
      ...legacy, version: 2, inventoryScope: null, subGraphName: null,
      authorAddress: seal.authorAddress, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal,
    };
    const { authorAddress: _author, ...scopeBase } = legacy.inventoryScope;
    const lanes = ([['private', true], ['private', false], ['public', false]] as const)
      .map(([kind, acceptsFinalizedVmRepair]) => ({ kind, acceptsFinalizedVmRepair, scopeBase }));
    const read = new Set<string | symbol>();
    for (const lane of lanes) {
      const watched = new Proxy(lane, { get(target, field, receiver) { read.add(field); return Reflect.get(target, field, receiver); } });
      for (const repair of [legacy, current]) {
        resolveFinalizedPlacementDecisionV1(repair, () => ({ status: 'active', lane: watched as PlacementLaneV1 }));
      }
    }
    // A field added here belongs in the revision as well, or a marker keeps a stale decision.
    expect([...read].sort()).toEqual(['acceptsFinalizedVmRepair', 'kind', 'scopeBase']);

    const revision = (lane: object) => JSON.stringify(finalizedPlacementAuthorityRevisionV1({ status: 'active', lane: lane as PlacementLaneV1 }));
    const lane = lanes[0]!;
    expect(new Set(lanes.map(revision)).size).toBe(lanes.length);
    for (const field of Object.keys(scopeBase)) {
      expect(revision({ ...lane, scopeBase: { ...scopeBase, [field]: 'changed' } }), field).not.toBe(revision(lane));
    }
    // The same scope is the same revision, however it was built.
    expect(revision({ ...lane, scopeBase: Object.fromEntries(Object.entries(scopeBase).reverse()) })).toBe(revision(lane));
    expect(finalizedPlacementAuthorityRevisionV1({ status: 'inactive' })).toBeNull();
    expect(finalizedPlacementAuthorityRevisionV1({ status: 'unavailable', error: new Error('unavailable') })).toBeUndefined();
  });
});
