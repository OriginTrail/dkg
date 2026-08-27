// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { Rfc64CatalogSynchronizationErrorV1 } from '../src/dkg-agent-rfc64-catalog-sync.js';
import { Rfc64CatalogReconciliationTerminalErrorV1 } from
  '../src/rfc64/public-catalog-reconciliation-failure-v1.js';
import {
  RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1,
  RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1,
  RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1,
  createRfc64PublicCatalogReceiverCompletionV1,
  isRfc64CatalogReconciliationFailureOutcomeV1,
  isRfc64CatalogReconciliationSuccessOutcomeV1,
  isRfc64PublicCatalogReceiverFailureCompletionV1,
  isRfc64PublicCatalogReceiverSuccessCompletionV1,
  type Rfc64PublicCatalogReceiverCompletionV1,
} from '../src/rfc64/public-catalog-reconciliation-outcome-v1.js';

describe('RFC-64 canonical reconciliation outcome v1', () => {
  it('owns the complete closed receiver outcome set and derives failures from it', () => {
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1).toEqual([
      'already-applied',
      'applied',
      'staged-only',
      'not-found',
      'failed',
      'dropped',
      'closed',
    ]);
    expect(Object.isFrozen(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1)).toBe(true);
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1).toEqual([
      'already-applied',
      'applied',
    ]);
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1).toEqual([
      'staged-only',
      'not-found',
      'failed',
      'dropped',
      'closed',
    ]);
    expect(Object.isFrozen(RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1)).toBe(true);
    expect(Object.isFrozen(RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1)).toBe(true);
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1.map(
      isRfc64CatalogReconciliationSuccessOutcomeV1,
    )).toEqual([true, true, false, false, false, false, false]);
    expect(RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1.map(
      isRfc64CatalogReconciliationFailureOutcomeV1,
    )).toEqual([false, false, true, true, true, true, true]);
    expect(isRfc64CatalogReconciliationSuccessOutcomeV1('unknown')).toBe(false);
    expect(isRfc64CatalogReconciliationFailureOutcomeV1('unknown')).toBe(false);
  });

  it('narrows complete success and failure payloads through the discriminant', () => {
    const success: Rfc64PublicCatalogReceiverCompletionV1 = {
      outcome: 'applied',
      appliedProviderPeerId: 'provider-peer',
      providerAttempts: 1,
      error: null,
    };
    const failure: Rfc64PublicCatalogReceiverCompletionV1 = {
      outcome: 'failed',
      appliedProviderPeerId: null,
      providerAttempts: 2,
      error: new Error('receiver failed'),
    };

    expect(isRfc64PublicCatalogReceiverSuccessCompletionV1(success)).toBe(true);
    expect(isRfc64PublicCatalogReceiverFailureCompletionV1(success)).toBe(false);
    expect(isRfc64PublicCatalogReceiverSuccessCompletionV1(failure)).toBe(false);
    expect(isRfc64PublicCatalogReceiverFailureCompletionV1(failure)).toBe(true);
  });

  it('materializes every frozen terminal payload from outcome-specific inputs', () => {
    const failure = new Error('receiver failed');
    const completions = [
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'already-applied',
        providerAttempts: 0,
      }),
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'applied',
        appliedProviderPeerId: 'provider-peer',
        providerAttempts: 1,
      }),
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'staged-only',
        providerAttempts: 2,
      }),
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'not-found',
        providerAttempts: 3,
      }),
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'failed',
        providerAttempts: 4,
        error: failure,
      }),
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'dropped',
        providerAttempts: 0,
      }),
      createRfc64PublicCatalogReceiverCompletionV1({
        outcome: 'closed',
        providerAttempts: 5,
      }),
    ];

    expect(completions).toEqual([
      { outcome: 'already-applied', providerAttempts: 0, appliedProviderPeerId: null, error: null },
      { outcome: 'applied', appliedProviderPeerId: 'provider-peer', providerAttempts: 1, error: null },
      { outcome: 'staged-only', providerAttempts: 2, appliedProviderPeerId: null, error: null },
      { outcome: 'not-found', providerAttempts: 3, appliedProviderPeerId: null, error: null },
      { outcome: 'failed', providerAttempts: 4, error: failure, appliedProviderPeerId: null },
      { outcome: 'dropped', providerAttempts: 0, appliedProviderPeerId: null, error: null },
      { outcome: 'closed', providerAttempts: 5, appliedProviderPeerId: null, error: null },
    ]);
    expect(completions.every(Object.isFrozen)).toBe(true);
  });

  it('keeps modern terminal errors compatible with the historical class and fields', () => {
    const terminal = new Rfc64CatalogReconciliationTerminalErrorV1({
      outcome: 'failed',
      error: Object.assign(new Error('receiver failed'), { code: 'receiver-code' }),
    });

    expect(terminal).toBeInstanceOf(Rfc64CatalogSynchronizationErrorV1);
    expect(terminal).toMatchObject({
      code: 'receiver-code',
      outcome: 'failed',
      terminalReason: null,
    });
    expect(new Rfc64CatalogSynchronizationErrorV1(
      'no-authorized-provider',
      'legacy-code',
    )).toMatchObject({
      code: 'legacy-code',
      terminalReason: 'no-authorized-provider',
    });
  });
});
