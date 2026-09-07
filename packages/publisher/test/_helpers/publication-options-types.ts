// SPDX-License-Identifier: Apache-2.0

import type {
  BasePublicationOptions,
  InitialPublishOptions,
  Publisher,
  PublishOptions,
  UpdateOptions,
} from '../../src/publisher.js';

const base: BasePublicationOptions = {
  contextGraphId: '1',
  quads: [],
};

const initial: InitialPublishOptions = {
  ...base,
  pricingPolicy: 'full-content',
};

const establishedName: PublishOptions = initial;
void establishedName;

const update: UpdateOptions = base;
void update;

// @ts-expect-error pricingPolicy is initial-publication-only.
const invalidUpdate: UpdateOptions = { ...base, pricingPolicy: 'full-content' };
void invalidUpdate;

declare const publisher: Publisher;
publisher.publish(initial);

// @ts-expect-error Publisher.update does not accept initial-publication pricing.
publisher.update(1n, { ...base, pricingPolicy: 'full-content' });
