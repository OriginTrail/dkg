// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';

import { FinalizedVmCompositionErrorV1 } from './finalized-vm-composer-v1.js';
import { Rfc64PublicCatalogNativeReceiverErrorV1 } from './public-catalog-native-receiver-v1.js';

/** User-visible terminal meanings emitted once at the receiver boundary. */
export type Rfc64CatalogReconciliationTerminalReasonV1 =
  | 'no-authorized-provider';

/** Stable process-local evidence for one scheduler-terminal reconciliation failure. */
export interface Rfc64PublicCatalogReconciliationFailureV1 {
  readonly catalogHeadDigest: Digest32V1;
  readonly errorName: string;
  readonly errorCode: string | null;
  /** Stable immediate cause code retained for diagnostics only. */
  readonly causeCode?: string;
}

/** Result of the most recently started scheduler attempt for one exact head. */
export interface Rfc64CatalogReconciliationAttemptFailureV1 {
  readonly catalogHeadDigest: Digest32V1;
  readonly terminalReason: Rfc64CatalogReconciliationTerminalReasonV1 | null;
  readonly errorName: string;
  readonly errorCode: string | null;
}

/** Monotonic process-local identity for one execution-time reconciliation attempt. */
export type Rfc64CatalogReconciliationAttemptTokenV1 = number;

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
  readonly #currentAttemptFailures = new Map<
    Digest32V1,
    Rfc64CatalogReconciliationAttemptFailureV1
  >();
  readonly #currentAttemptTokens = new Map<
    Digest32V1,
    Rfc64CatalogReconciliationAttemptTokenV1
  >();
  #attemptSequence = 0;

  /** Start a new semantic attempt without changing immutable diagnostic history. */
  beginAttempt(catalogHeadDigest: Digest32V1): Rfc64CatalogReconciliationAttemptTokenV1 {
    const token = ++this.#attemptSequence;
    this.#currentAttemptTokens.set(catalogHeadDigest, token);
    this.#currentAttemptFailures.delete(catalogHeadDigest);
    return token;
  }

  /** Scheduler-terminal callback sink. The first failure for one head wins. */
  record(
    catalogHeadDigest: Digest32V1,
    error: unknown,
    terminalReason: Rfc64CatalogReconciliationTerminalReasonV1 | null = null,
    attemptToken?: Rfc64CatalogReconciliationAttemptTokenV1,
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
    const currentAttemptToken = this.#currentAttemptTokens.get(catalogHeadDigest);
    if (
      (currentAttemptToken !== undefined && currentAttemptToken !== attemptToken)
      || (currentAttemptToken === undefined && attemptToken !== undefined)
    ) {
      return;
    }
    evictOldestWhenFullV1(this.#currentAttemptFailures);
    this.#currentAttemptFailures.set(catalogHeadDigest, Object.freeze({
      catalogHeadDigest,
      terminalReason,
      errorName,
      errorCode,
    }));
  }

  /** Clear only the exact current attempt; stale successes cannot erase a newer failure. */
  completeAttempt(
    catalogHeadDigest: Digest32V1,
    attemptToken: Rfc64CatalogReconciliationAttemptTokenV1,
  ): void {
    if (this.#currentAttemptTokens.get(catalogHeadDigest) !== attemptToken) return;
    this.#currentAttemptFailures.delete(catalogHeadDigest);
    this.#currentAttemptTokens.delete(catalogHeadDigest);
  }

  read(catalogHeadDigest: Digest32V1): Rfc64PublicCatalogReconciliationFailureV1 | null {
    const failure = this.#failures.get(catalogHeadDigest);
    return failure === undefined ? null : failure;
  }

  readCurrentAttempt(
    catalogHeadDigest: Digest32V1,
  ): Rfc64CatalogReconciliationAttemptFailureV1 | null {
    return this.#currentAttemptFailures.get(catalogHeadDigest) ?? null;
  }

  clear(): void {
    this.#failures.clear();
    this.#currentAttemptFailures.clear();
    this.#currentAttemptTokens.clear();
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
