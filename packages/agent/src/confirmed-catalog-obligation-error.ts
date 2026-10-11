// SPDX-License-Identifier: Apache-2.0

import {
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { PublishResult } from '@origintrail-official/dkg-publisher';
import type { ObserveRfc64ConfirmedVmParamsV1 } from './dkg-agent-rfc64-catalog-auto-publish.js';

export type ConfirmedCatalogTransactionEvidenceV1 = Readonly<Pick<OnChainPublishResult,
  'txHash' | 'blockNumber' | 'txIndex' | 'kaId' | 'batchId' | 'startKAId' | 'endKAId'>>;

/** The publication tail and its recovery error carry the same immutable obligation. */
export type ConfirmedCatalogObligationInputV1 = Readonly<ObserveRfc64ConfirmedVmParamsV1 & {
  readonly status: PublishResult['status'];
  readonly confirmedTransaction?: ConfirmedCatalogTransactionEvidenceV1;
}>;

/** Chain confirmation succeeded, but local catalog completion is still owed. */
export class ConfirmedCatalogObligationErrorV1 extends Error {
  readonly code = 'CONFIRMED_CATALOG_OBLIGATION_PENDING';
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
  readonly transaction: ConfirmedCatalogTransactionEvidenceV1 | undefined;
  private readonly retry: Readonly<ObserveRfc64ConfirmedVmParamsV1>;

  constructor(
    input: Readonly<ObserveRfc64ConfirmedVmParamsV1>,
    transaction: ConfirmedCatalogTransactionEvidenceV1 | undefined,
    cause: unknown,
  ) {
    super('Confirmed publication catalog obligation was not durably recorded; recovery is required', { cause });
    this.name = 'ConfirmedCatalogObligationErrorV1';
    this.seal = Object.freeze(canonicalGraphScopedAuthorSealFromAssertionSealV1(input.seal));
    this.transaction = transaction === undefined ? undefined : Object.freeze({
      txHash: transaction.txHash, blockNumber: transaction.blockNumber,
      txIndex: transaction.txIndex, kaId: transaction.kaId, batchId: transaction.batchId,
      startKAId: transaction.startKAId, endKAId: transaction.endKAId,
    });
    this.retry = structuredClone(input);
  }

  /**
   * Retry only the post-confirmation observer, never transaction submission.
   * Each read owns its mutable byte arrays. A standalone caller must retain
   * this evidence itself; the durable async queue already owns its request.
   */
  get retryInput(): Readonly<ObserveRfc64ConfirmedVmParamsV1> {
    return structuredClone(this.retry);
  }
}
