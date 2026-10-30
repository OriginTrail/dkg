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


import type { DKGPublisher } from '../../src/dkg-publisher.js';
import type { MintRecordingOptions, SharedMemoryMintRecordingOptions } from '../../src/publisher.js';
declare const recorder: DKGPublisher;
declare const sealedRecording: MintRecordingOptions;
declare const sharedRecording: SharedMemoryMintRecordingOptions;
void recorder.recordExistingMint(sealedRecording, {});
void recorder.recordExistingMintFromSharedMemory('1', 'all', {}, sharedRecording);
// @ts-expect-error Recording requires the sealed graph identity and reservation.
void recorder.recordExistingMint({ contextGraphId: '1', quads: [] }, {});
// @ts-expect-error Recording cannot request encryption.
void recorder.recordExistingMint({ ...sealedRecording, encryptInlinePayload: bytes => bytes }, {});
// @ts-expect-error Recording cannot request ACK acquisition.
void recorder.recordExistingMint({ ...sealedRecording, v10ACKProvider: async () => [] }, {});
// @ts-expect-error Recording cannot change transaction attribution.
void recorder.recordExistingMint({ ...sealedRecording, publisherNodeIdentityIdOverride: 1n }, {});
// @ts-expect-error Shared-memory recording must carry the required sealed target.
void recorder.recordExistingMintFromSharedMemory('1', 'all', {}, {});
// @ts-expect-error Shared-memory recording cannot request live encryption.
void recorder.recordExistingMintFromSharedMemory('1', 'all', {}, { ...sharedRecording, encryptInlinePayload: bytes => bytes });

// Recording keeps the normalized sealed target and cannot carry live execution hooks.
import type { PreparedPublicationContent, PreparedSealedGraphPublicationContent } from '../../src/prepared-publication.js';
import type { ConfirmedPublicationRecording } from '../../src/prepared-publication-recording.js';
import type { PublicationAcquisition } from '../../src/prepared-publication-acquisition.js';
declare const unselectedContent: PreparedPublicationContent;
declare const sealedContent: PreparedSealedGraphPublicationContent;
declare const acquiredMint: Extract<PublicationAcquisition, { kind: 'adopted' }>;
const adoptedRecording: ConfirmedPublicationRecording = { ...acquiredMint, content: sealedContent };
void adoptedRecording;
// @ts-expect-error An adopted receipt cannot be paired with an unvalidated reservation.
const invalidAdoptedRecording: ConfirmedPublicationRecording = { ...acquiredMint, content: unselectedContent };
void invalidAdoptedRecording;
// @ts-expect-error Recording data cannot supply an encryption capability.
void sealedContent.encryptInlinePayload;
// @ts-expect-error Live execution capabilities are outside the recording payload.
void sealedContent.execution;
