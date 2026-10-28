// SPDX-License-Identifier: Apache-2.0
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../dkg-agent.js';
import { finishNamedPublishFinalization, type NamedPublishFinalizationInput } from '../named-publish-finalization.js';

/** Durable completion requires only checkpoint storage and the catalog transfer capability. */
export function completeNamedPublishFinalization(host: {
  readonly store: TripleStore;
  readonly transferRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['transferRfc64ConfirmedVmV1']>;
}, input: NamedPublishFinalizationInput): Promise<'complete' | 'pending'> {
  return finishNamedPublishFinalization(host.store, input, {
    transfer: shareOperationId => host.transferRfc64ConfirmedVmV1({
      ...input, shareOperationId, ctx: createOperationContext('publishFromSWM'), publicationLabel: 'publish',
    }),
  });
}
