// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createMixedPublisherInventory } from './_helpers/publisher-inventory.js';

describe('canonical publisher graph inventory', () => {
  it('composes graph and status filters while retaining ordering and unscoped raw jobs', async () => {
    const { store, publisher } = await createMixedPublisherInventory('target');
    const ids = (jobs: Awaited<ReturnType<typeof publisher.list>>) => jobs.map(job => job.jobId);
    try {
      expect(ids(await publisher.list())).toEqual(['own-claimed', 'legacy', 'other', 'own-a', 'own-z']);
      expect(ids(await publisher.list({ contextGraphId: 'target' }))).toEqual(['own-claimed', 'own-a', 'own-z']);
      expect(ids(await publisher.list({ contextGraphId: 'target', status: 'accepted' }))).toEqual(['own-a', 'own-z']);
      expect(ids(await publisher.list({ contextGraphId: 'target', status: 'claimed' }))).toEqual(['own-claimed']);
      expect(ids(await publisher.list({ status: 'accepted' }))).toEqual(['legacy', 'other', 'own-a', 'own-z']);
      expect(ids(await publisher.list({ contextGraphId: 'missing' }))).toEqual([]);
    } finally { await store.close(); }
  });
});
