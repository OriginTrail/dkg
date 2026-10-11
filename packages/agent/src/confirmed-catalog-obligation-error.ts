// SPDX-License-Identifier: Apache-2.0

import {
  assertAssertionCoordinateV1, assertContextGraphIdV1, assertCanonicalGraphScopedAuthorSealV1, snapshotExactDataRecord,
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

/** JSON-safe caller-retained evidence; recovery validates receipt and local seal before observation. */
export interface ConfirmedCatalogObligationRecoveryV1 {
  readonly version: 1;
  readonly contextGraphId: string;
  readonly assertionCoordinate: string;
  readonly subGraphName: string | null;
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
  readonly transactionHash: string;
  readonly blockNumber: number;
}

/** Snapshot untrusted evidence once; chain/local-seal authentication is a separate step. */
export function parseConfirmedCatalogObligationRecoveryV1(input: unknown): Readonly<ConfirmedCatalogObligationRecoveryV1> {
  try {
    const value = snapshotExactDataRecord(input, ['version', 'contextGraphId', 'assertionCoordinate',
      'subGraphName', 'seal', 'transactionHash', 'blockNumber'], 'confirmed catalog recovery');
    if (typeof value.seal !== 'object' || value.seal === null
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value.seal))) throw new Error('Expected seal object');
    const fields = Object.getOwnPropertyDescriptors(value.seal);
    const seal: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(fields)) {
      if (typeof key !== 'string') throw new Error('Expected string seal field');
      const field = fields[key];
      if (!field || !('value' in field) || !field.enumerable) throw new Error('Expected seal data field');
      seal[key] = field.value;
    }
    assertContextGraphIdV1(value.contextGraphId, 'confirmed recovery contextGraphId');
    assertAssertionCoordinateV1(value.assertionCoordinate, 'confirmed recovery assertionCoordinate');
    assertCanonicalGraphScopedAuthorSealV1(seal);
    if (value.version !== 1 || value.subGraphName !== null || typeof value.transactionHash !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash)
      || typeof value.blockNumber !== 'number' || !Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0) {
      throw new Error('Invalid recovery scalars');
    }
    return Object.freeze({ version: 1, contextGraphId: value.contextGraphId,
      assertionCoordinate: value.assertionCoordinate, subGraphName: null,
      seal: Object.freeze(seal), transactionHash: value.transactionHash, blockNumber: value.blockNumber });
  } catch (cause) {
    throw Object.assign(new Error('Invalid confirmed catalog recovery evidence', { cause }),
      { code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
  }
}

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

  get recoveryEvidence(): Readonly<ConfirmedCatalogObligationRecoveryV1> | undefined {
    if (this.transaction === undefined) return undefined;
    return Object.freeze({ version: 1, contextGraphId: this.retry.contextGraphId,
      assertionCoordinate: this.retry.assertionCoordinate, subGraphName: this.retry.subGraphName ?? null,
      seal: this.seal, transactionHash: this.transaction.txHash, blockNumber: this.transaction.blockNumber });
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
