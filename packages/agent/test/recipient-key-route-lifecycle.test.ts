// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';

const key = {
  subject: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
  predicate: DKG_ONTOLOGY.DKG_PEER_ID, object: '"peer"', graph: 'urn:profile',
};

describe('recipient fence lifecycle owner', () => {
  it('advances the fence for a revocation through the retained callback API', async () => {
    const raw = new OxigraphStore();
    try {
      const projection = new ContextGraphMetaProjection(raw);
      await projection.recipientKeyRouteFence.ensureReady();
      const before = projection.recipientKeyRouteFence.revision;
      const store = createListContextGraphsCacheInvalidatingStore(raw, () => {}, (quads) => projection.markDirtyFromQuads(quads!));
      await store.insert([{ ...key, predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF }]);
      expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
    } finally { await raw.close(); }
  });

  it('settles one observed lifecycle for a normal synced write', async () => {
    const raw = new OxigraphStore();
    try {
      const projection = new ContextGraphMetaProjection(raw);
      await projection.recipientKeyRouteFence.ensureReady();
      const begin = vi.spyOn(projection.recipientKeyRouteFence, 'begin');
      const before = projection.recipientKeyRouteFence.revision;
      const store = createListContextGraphsCacheInvalidatingStore(raw, () => {}, createProjectionMutationObserver(() => projection));
      await store.insert([key]);
      expect(begin).toHaveBeenCalledOnce();
      expect(projection.recipientKeyRouteFence.revision).toBe(before + 1);

    } finally { await raw.close(); }
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
