// SPDX-License-Identifier: Apache-2.0

export const RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1 = Object.freeze([
  'already-applied',
  'applied',
] as const);

export const RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1 = Object.freeze([
  'staged-only',
  'not-found',
  'failed',
  'dropped',
  'closed',
] as const);

/** One canonical closed model for receiver and synchronization completion. */
export const RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1 = Object.freeze([
  ...RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1,
  ...RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1,
] as const);

export type Rfc64CatalogReconciliationSuccessOutcomeV1 =
  (typeof RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1)[number];

export type Rfc64CatalogReconciliationFailureOutcomeV1 =
  (typeof RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1)[number];

export type Rfc64PublicCatalogReceiverCompletionOutcomeV1 =
  | Rfc64CatalogReconciliationSuccessOutcomeV1
  | Rfc64CatalogReconciliationFailureOutcomeV1;

export type Rfc64CatalogReconciliationTerminalReasonV1 =
  | 'no-authorized-provider';

interface Rfc64PublicCatalogReceiverCompletionBaseV1 {
  readonly providerAttempts: number;
}

export type Rfc64PublicCatalogReceiverSuccessCompletionV1 =
  | Readonly<Rfc64PublicCatalogReceiverCompletionBaseV1 & {
      readonly outcome: 'already-applied';
      readonly appliedProviderPeerId: null;
      readonly error: null;
    }>
  | Readonly<Rfc64PublicCatalogReceiverCompletionBaseV1 & {
      readonly outcome: 'applied';
      readonly appliedProviderPeerId: string;
      readonly error: null;
    }>;

export type Rfc64PublicCatalogReceiverFailureCompletionV1 =
  | Readonly<Rfc64PublicCatalogReceiverCompletionBaseV1 & {
      readonly outcome: 'failed';
      readonly appliedProviderPeerId: null;
      readonly error: unknown;
    }>
  | Readonly<Rfc64PublicCatalogReceiverCompletionBaseV1 & {
      readonly outcome: Exclude<Rfc64CatalogReconciliationFailureOutcomeV1, 'failed'>;
      readonly appliedProviderPeerId: null;
      readonly error: null;
    }>;

/** Exact terminal result for one scheduled head, separate from global idleness. */
export type Rfc64PublicCatalogReceiverCompletionV1 =
  | Rfc64PublicCatalogReceiverSuccessCompletionV1
  | Rfc64PublicCatalogReceiverFailureCompletionV1;

type FailureErrorPayload<Completion> = Completion extends {
  readonly outcome: infer Outcome;
  readonly error: infer ErrorValue;
}
  ? Readonly<{ readonly outcome: Outcome; readonly error: ErrorValue }>
  : never;

/** Minimal failure payload accepted by the compatibility terminal error. */
export type Rfc64CatalogReconciliationFailureCompletionV1 =
  FailureErrorPayload<Rfc64PublicCatalogReceiverFailureCompletionV1>;

export function isRfc64CatalogReconciliationSuccessOutcomeV1(
  value: unknown,
): value is Rfc64CatalogReconciliationSuccessOutcomeV1 {
  return typeof value === 'string'
    && (RFC64_PUBLIC_CATALOG_RECONCILIATION_SUCCESS_OUTCOMES_V1 as readonly string[])
      .includes(value);
}

export function isRfc64CatalogReconciliationFailureOutcomeV1(
  value: unknown,
): value is Rfc64CatalogReconciliationFailureOutcomeV1 {
  return typeof value === 'string'
    && (RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_OUTCOMES_V1 as readonly string[])
      .includes(value);
}

export function isRfc64PublicCatalogReceiverSuccessCompletionV1(
  completion: Rfc64PublicCatalogReceiverCompletionV1,
): completion is Rfc64PublicCatalogReceiverSuccessCompletionV1 {
  return isRfc64CatalogReconciliationSuccessOutcomeV1(completion.outcome);
}

export function isRfc64PublicCatalogReceiverFailureCompletionV1(
  completion: Rfc64PublicCatalogReceiverCompletionV1,
): completion is Rfc64PublicCatalogReceiverFailureCompletionV1 {
  return isRfc64CatalogReconciliationFailureOutcomeV1(completion.outcome);
}
