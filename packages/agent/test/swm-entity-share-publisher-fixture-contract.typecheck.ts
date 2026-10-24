import type { Quad } from '@origintrail-official/dkg-storage';
import { makeEntitySharePublisherFixture } from
  './_helpers/swm-entity-share-publisher-fixture.js';

declare const payload: readonly Quad[];
const base = {
  contextGraphId: 'cg-publisher-fixture-contract',
  shareOperationId: 'op-publisher-fixture-contract',
  payload,
  publisherPeerId: 'peer-source',
};

void makeEntitySharePublisherFixture({ ...base, rootEntities: ['https://example.org/root'] });
void makeEntitySharePublisherFixture({
  ...base,
  rootEntities: ['https://example.org/root-a', 'https://example.org/root-b'],
});
void makeEntitySharePublisherFixture({
  ...base,
  rootEntities: ['https://example.org/root'],
  subGraphName: 'research',
});

// @ts-expect-error The generalized publisher fixture requires an explicit root set.
void makeEntitySharePublisherFixture(base);
