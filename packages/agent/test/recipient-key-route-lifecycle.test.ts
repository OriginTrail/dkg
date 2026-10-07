// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver, reportCommittedProjectionQuads } from '../src/internal/projection-mutation-observer.js';

const key = {
  subject: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
  predicate: DKG_ONTOLOGY.DKG_PEER_ID, object: '"peer"', graph: 'urn:profile',
};

describe('recipient fence lifecycle owner', () => {
  it('reports a committed write through an undecorated store, separately from cache invalidation', async () => {
    const store = new OxigraphStore();
    try {
      const projection = new ContextGraphMetaProjection(store);
      await projection.recipientKeyRouteFence.ensureReady();
      const before = projection.recipientKeyRouteFence.revision;
      projection.markDirtyFromQuads([key]);
      expect(projection.recipientKeyRouteFence.revision).toBe(before);
      await store.insert([key]);
      reportCommittedProjectionQuads(projection, [key]);
      expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
    } finally { await store.close(); }
  });

  it('settles both observers once, and advances the fence even if projection invalidation fails', async () => {
    const store = new OxigraphStore();
    try {
      const projection = new ContextGraphMetaProjection(store);
      const invalidate = vi.spyOn(projection, 'markDirtyFromQuads').mockImplementation(() => { throw new Error('projection failed'); });
      const before = projection.recipientKeyRouteFence.revision;
      const settle = createProjectionMutationObserver(() => projection).begin({ quads: [key] });
      expect(() => settle('changed')).toThrow('projection failed');
      expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
      settle('changed');
      expect(invalidate).toHaveBeenCalledOnce();
    } finally { await store.close(); }
  });
});
