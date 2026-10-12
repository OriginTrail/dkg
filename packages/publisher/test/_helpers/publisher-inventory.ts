// SPDX-License-Identifier: Apache-2.0
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../../src/async-lift-publisher-impl.js';
import { kaVmPublishRequest } from '../../../../scripts/testing/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './legacy-raw-lift.js';

/** Actual persisted mixed inventory, including historical raw jobs and an equal-time tie. */
export async function createMixedPublisherInventory(contextGraphId: string) {
  const store = new OxigraphStore();
  let now = 10;
  let id = 'own-claimed';
  const publisher = new TripleStoreAsyncLiftPublisher(store, { now: () => now, idGenerator: () => id });
  for (const [jobId, cg, at] of [
    ['own-claimed', contextGraphId, 10], ['other', 'another-private-cg', 20],
    ['own-z', contextGraphId, 30], ['own-a', contextGraphId, 30],
  ] as const) {
    now = at;
    id = jobId;
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: cg,
      name: jobId, shareOperationId: `op-${jobId}` }));
  }
  await seedLegacyRawLiftTestJob(store, { contextGraphId, swmId: 'legacy-swm', shareOperationId: 'legacy-op',
    roots: ['urn:legacy:root'], namespace: 'legacy', scope: 'root', transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'legacy-proof' },
  }, { now: () => 15, idGenerator: () => 'legacy' });
  await publisher.claimNext('wallet');
  return { store, publisher };
}
