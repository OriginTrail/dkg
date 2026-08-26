// SPDX-License-Identifier: Apache-2.0

/** One canonical closed model for receiver and synchronization completion. */
export const RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1 = Object.freeze([
  'already-applied',
  'applied',
  'staged-only',
  'not-found',
  'failed',
  'dropped',
  'closed',
] as const);

export type Rfc64PublicCatalogReceiverCompletionOutcomeV1 =
  (typeof RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1)[number];

export type Rfc64CatalogReconciliationFailureOutcomeV1 = Exclude<
  Rfc64PublicCatalogReceiverCompletionOutcomeV1,
  'already-applied' | 'applied'
>;

export type Rfc64CatalogReconciliationTerminalReasonV1 =
  | 'no-authorized-provider';

/** Exact terminal result for one scheduled head, separate from global idleness. */
export interface Rfc64PublicCatalogReceiverCompletionV1 {
  readonly outcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1;
  readonly appliedProviderPeerId: string | null;
  readonly providerAttempts: number;
  readonly error: unknown | null;
}

export type Rfc64CatalogReconciliationFailureCompletionV1 = Readonly<
  Pick<Rfc64PublicCatalogReceiverCompletionV1, 'error'>
  & { readonly outcome: Rfc64CatalogReconciliationFailureOutcomeV1 }
>;

export function isRfc64CatalogReconciliationFailureOutcomeV1(
  value: unknown,
): value is Rfc64CatalogReconciliationFailureOutcomeV1 {
  return typeof value === 'string'
    && (RFC64_PUBLIC_CATALOG_RECONCILIATION_OUTCOMES_V1 as readonly string[])
      .includes(value)
    && value !== 'already-applied'
    && value !== 'applied';
}
