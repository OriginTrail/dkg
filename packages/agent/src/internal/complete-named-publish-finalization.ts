// SPDX-License-Identifier: Apache-2.0
import { observeConfirmedPublicationWithRecoveryV1 } from '../confirmed-catalog-obligation-error.js';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../dkg-agent.js';
import { finishNamedPublishFinalization, type NamedPublishFinalizationInput } from '../named-publish-finalization.js';

/** Complete only after the catalog obligation has a durable owner. */
export function completeNamedPublishFinalization(host: {
  readonly store: TripleStore;
  readonly observeRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['observeRfc64ConfirmedVmV1']>;
  readonly transferRfc64ConfirmedVmV1: OmitThisParameter<DKGAgent['transferRfc64ConfirmedVmV1']>;
}, input: NamedPublishFinalizationInput): Promise<'complete' | 'pending'> {
  return finishNamedPublishFinalization(host.store, input, {
    transfer: async (shareOperationId, catalogRequired) => {
      const obligation = { ...input, shareOperationId, catalogObligationRequired: catalogRequired && input.subGraphName == null,
        ctx: createOperationContext('publishFromSWM'), publicationLabel: 'publish' as const };
      // Keep the admitted root obligation durable even when its execution policy changes.
      await observeConfirmedPublicationWithRecoveryV1({ ...obligation, status: 'confirmed' }, host.observeRfc64ConfirmedVmV1);
      if (obligation.catalogObligationRequired) return 'owned';
      return host.transferRfc64ConfirmedVmV1(obligation);
    },
  });
}
