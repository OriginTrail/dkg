// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReconciliationFailureOutcomeV1,
  Rfc64CatalogReconciliationSuccessOutcomeV1,
  Rfc64PublicCatalogReceiverCompletionOutcomeV1,
  Rfc64PublicCatalogReceiverCompletionV1,
  Rfc64PublicCatalogReceiverFailureCompletionV1,
  Rfc64PublicCatalogReceiverSuccessCompletionV1,
} from '@origintrail-official/dkg-agent';

const successOutcome: Rfc64CatalogReconciliationSuccessOutcomeV1 = 'applied';
const failureOutcome: Rfc64CatalogReconciliationFailureOutcomeV1 = 'failed';
const outcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1 = failureOutcome;

const applied: Rfc64PublicCatalogReceiverSuccessCompletionV1 = {
  outcome: successOutcome,
  appliedProviderPeerId: 'provider-peer',
  providerAttempts: 1,
  error: null,
};
const failed: Rfc64PublicCatalogReceiverFailureCompletionV1 = {
  outcome,
  appliedProviderPeerId: null,
  providerAttempts: 2,
  error: new Error('receiver failed'),
};
const completions: readonly Rfc64PublicCatalogReceiverCompletionV1[] = [applied, failed];
void completions;

// @ts-expect-error An applied completion must identify the provider that applied it.
const invalidApplied: Rfc64PublicCatalogReceiverCompletionV1 = {
  outcome: 'applied',
  appliedProviderPeerId: null,
  providerAttempts: 1,
  error: null,
};
void invalidApplied;

// @ts-expect-error A closed completion cannot carry a provider or error payload.
const invalidClosed: Rfc64PublicCatalogReceiverCompletionV1 = {
  outcome: 'closed',
  appliedProviderPeerId: 'provider-peer',
  providerAttempts: 1,
  error: new Error('closed'),
};
void invalidClosed;
