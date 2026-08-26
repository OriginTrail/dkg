// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';

import { Rfc64CatalogSynchronizationErrorV1 } from './catalog-synchronization-error-v1.js';
import { FinalizedVmCompositionErrorV1 } from './finalized-vm-composer-v1.js';
import { Rfc64PublicCatalogNativeReceiverErrorV1 } from './public-catalog-native-receiver-v1.js';
import {
  isRfc64CatalogReconciliationFailureOutcomeV1,
  type Rfc64CatalogReconciliationFailureCompletionV1,
  type Rfc64CatalogReconciliationFailureOutcomeV1,
  type Rfc64CatalogReconciliationTerminalReasonV1,
} from './public-catalog-reconciliation-outcome-v1.js';

export type {
  Rfc64CatalogReconciliationFailureCompletionV1,
  Rfc64CatalogReconciliationFailureOutcomeV1,
  Rfc64CatalogReconciliationTerminalReasonV1,
} from './public-catalog-reconciliation-outcome-v1.js';

/** Exact, public semantic failure returned by one scheduled reconciliation task. */
export class Rfc64CatalogReconciliationTerminalErrorV1
  extends Rfc64CatalogSynchronizationErrorV1 {
  readonly outcome: Rfc64CatalogReconciliationFailureOutcomeV1;

  constructor(completion: Rfc64CatalogReconciliationFailureCompletionV1) {
    if (!isRfc64CatalogReconciliationFailureOutcomeV1(completion?.outcome)) {
      throw new TypeError('RFC-64 reconciliation terminal error requires a non-success outcome');
    }
    const cause = completion.error;
    super(
      classifyRfc64CatalogReconciliationTerminalReasonV1(cause),
      readSynchronizationErrorCodeV1(cause),
      cause === null ? {} : { cause },
    );
    this.name = 'Rfc64CatalogReconciliationTerminalErrorV1';
    this.message = `RFC-64 current-head synchronization ended with ${completion.outcome}`;
    this.outcome = completion.outcome;
  }
}

function readSynchronizationErrorCodeV1(error: unknown): string | null {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return null;
  }
  try {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/** One bounded provider's terminal reconciliation result. */
export interface Rfc64CatalogProviderTerminalFailureV1 {
  readonly providerPeerId: string;
  readonly error: unknown;
}

/**
 * Bounded aggregate for one exact-head failover attempt.
 *
 * The receiver retains at most one terminal error for each of its at most eight
 * selected providers. `attemptedProviderCount` also includes providers whose
 * terminal result was `not-found`, so downstream classification can require a
 * conclusive error from the complete provider set instead of trusting the last
 * provider tried.
 */
export class Rfc64CatalogProviderFailureAggregateV1 extends AggregateError {
  readonly attemptedProviderCount: number;
  readonly providerFailures: readonly Readonly<Rfc64CatalogProviderTerminalFailureV1>[];

  constructor(
    attemptedProviderCount: number,
    providerFailures: readonly Readonly<Rfc64CatalogProviderTerminalFailureV1>[],
  ) {
    const failures = Object.freeze(providerFailures.map(({ providerPeerId, error }) => (
      Object.freeze({ providerPeerId, error })
    )));
    super(
      failures.map(({ error }) => error),
      'RFC-64 catalog reconciliation exhausted its selected providers',
    );
    this.name = 'Rfc64CatalogProviderFailureAggregateV1';
    this.attemptedProviderCount = attemptedProviderCount;
    this.providerFailures = failures;
  }
}

/** Stable process-local evidence for one scheduler-terminal reconciliation failure. */
export interface Rfc64PublicCatalogReconciliationFailureV1 {
  readonly catalogHeadDigest: Digest32V1;
  readonly errorName: string;
  readonly errorCode: string | null;
  /** Stable immediate cause code retained for diagnostics only. */
  readonly causeCode?: string;
}

/** Hard process-memory bound for distinct terminal receiver failures. */
export const RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1 = 128;

const STABLE_ERROR_TOKEN_MAX_LENGTH_V1 = 128;
const STABLE_ERROR_TOKEN_V1 = /^[A-Za-z][A-Za-z0-9._:-]*$/;

/**
 * Internal process-local registry owned by DKGAgent. It is intentionally not
 * exported from the package root; the agent exposes only its read method.
 */
export class Rfc64PublicCatalogReconciliationFailureRegistryV1 {
  readonly #failures = new Map<Digest32V1, Rfc64PublicCatalogReconciliationFailureV1>();

  /** Scheduler-terminal callback sink. The first failure for one head wins. */
  record(
    catalogHeadDigest: Digest32V1,
    error: unknown,
  ): void {
    const errorName = stableErrorNameV1(error);
    const errorCode = stableErrorCodeV1(error);
    const causeCode = stableImmediateCauseCodeV1(error);
    if (!this.#failures.has(catalogHeadDigest)) {
      evictOldestWhenFullV1(this.#failures);
      this.#failures.set(catalogHeadDigest, Object.freeze({
        catalogHeadDigest,
        errorName,
        errorCode,
        ...(causeCode === null ? {} : { causeCode }),
      }));
    }
  }

  read(catalogHeadDigest: Digest32V1): Rfc64PublicCatalogReconciliationFailureV1 | null {
    const failure = this.#failures.get(catalogHeadDigest);
    return failure === undefined ? null : failure;
  }

  clear(): void {
    this.#failures.clear();
  }

  /** Internal test/diagnostic bound assertion; never exposed on DKGAgent. */
  get size(): number {
    return this.#failures.size;
  }

}

function stableErrorNameV1(error: unknown): string {
  let candidate: unknown;
  try {
    candidate = error instanceof Error ? error.name : undefined;
  } catch {
    return 'UnknownError';
  }
  return stableErrorTokenV1(candidate) ?? 'UnknownError';
}

function stableErrorCodeV1(error: unknown): string | null {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return null;
  }
  let candidate: unknown;
  try {
    candidate = (error as { readonly code?: unknown }).code;
  } catch {
    return null;
  }
  return stableErrorTokenV1(candidate);
}

function stableImmediateCauseCodeV1(error: unknown): string | null {
  return stableErrorCodeV1(readCauseV1(error));
}

function readCauseV1(error: unknown): unknown | null {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return null;
  }
  try {
    return (error as { readonly cause?: unknown }).cause ?? null;
  } catch {
    return null;
  }
}

function stableErrorTokenV1(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= STABLE_ERROR_TOKEN_MAX_LENGTH_V1
    && STABLE_ERROR_TOKEN_V1.test(value)
    ? value
    : null;
}

function evictOldestWhenFullV1<T>(map: Map<Digest32V1, T>): void {
  if (map.size < RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1) return;
  const oldestCatalogHeadDigest = map.keys().next().value as Digest32V1 | undefined;
  if (oldestCatalogHeadDigest !== undefined) map.delete(oldestCatalogHeadDigest);
}

/**
 * Translate the one supported low-level private-VM terminal condition at the
 * receiver boundary. No message parsing or recursive cause traversal is used.
 */
export function classifyRfc64CatalogReconciliationTerminalReasonV1(
  error: unknown,
): Rfc64CatalogReconciliationTerminalReasonV1 | null {
  if (error instanceof Rfc64CatalogProviderFailureAggregateV1) {
    if (
      error.attemptedProviderCount < 1
      || error.providerFailures.length !== error.attemptedProviderCount
    ) {
      return null;
    }
    return error.providerFailures.every(({ error: providerError }) => (
      classifySingleProviderTerminalReasonV1(providerError) === 'no-authorized-provider'
    ))
      ? 'no-authorized-provider'
      : null;
  }
  return classifySingleProviderTerminalReasonV1(error);
}

function classifySingleProviderTerminalReasonV1(
  error: unknown,
): Rfc64CatalogReconciliationTerminalReasonV1 | null {
  if (
    error instanceof Rfc64PublicCatalogNativeReceiverErrorV1
    && error.code === 'catalog-native-receiver-incomplete'
  ) {
    return 'no-authorized-provider';
  }
  if (
    error instanceof Rfc64PublicCatalogNativeReceiverErrorV1
    && error.code === 'catalog-native-receiver-activation'
    && error.cause instanceof FinalizedVmCompositionErrorV1
    && error.cause.code === 'finalized-vm-composition-incomplete'
  ) {
    return 'no-authorized-provider';
  }
  return null;
}
