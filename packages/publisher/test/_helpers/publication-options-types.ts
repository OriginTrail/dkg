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

// Established callers commonly annotate update inputs with PublishOptions and
// use indexed access for the update seal. Both historical patterns must remain
// source-compatible even though Publisher.update itself accepts UpdateOptions.
type LegacyUpdateAttestation = PublishOptions['precomputedUpdateAttestation'];
const legacyUpdateAttestation = null as unknown as NonNullable<LegacyUpdateAttestation>;
const legacyUpdateOptions: PublishOptions = {
  ...base,
  precomputedUpdateAttestation: legacyUpdateAttestation,
};

// @ts-expect-error pricingPolicy is initial-publication-only.
const invalidUpdate: UpdateOptions = { ...base, pricingPolicy: 'full-content' };
void invalidUpdate;

const invalidUpdateAck: UpdateOptions = {
  ...base,
  // @ts-expect-error Initial ACK providers cannot cross into an update contract.
  v10ACKProvider: null as unknown as NonNullable<InitialPublishOptions['v10ACKProvider']>,
};
void invalidUpdateAck;

const invalidInitialAck: InitialPublishOptions = {
  ...base,
  // @ts-expect-error Update ACK providers cannot cross into an initial contract.
  v10UpdateACKProvider: null as unknown as NonNullable<UpdateOptions['v10UpdateACKProvider']>,
};
void invalidInitialAck;

const invalidUpdateSeal: UpdateOptions = {
  ...base,
  // @ts-expect-error Initial author seals cannot cross into an update contract.
  precomputedAttestation: null as unknown as NonNullable<InitialPublishOptions['precomputedAttestation']>,
};
void invalidUpdateSeal;

const invalidInitialSeal: InitialPublishOptions = {
  ...base,
  // @ts-expect-error Update owner seals cannot cross into an initial contract.
  precomputedUpdateAttestation: null as unknown as NonNullable<UpdateOptions['precomputedUpdateAttestation']>,
};
void invalidInitialSeal;

declare const publisher: Publisher;
publisher.publish(initial);
publisher.update(1n, legacyUpdateOptions);

// @ts-expect-error Publisher.update does not accept initial-publication pricing.
publisher.update(1n, { ...base, pricingPolicy: 'full-content' });
