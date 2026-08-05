// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';

/** Stable process-local evidence for one scheduler-terminal reconciliation failure. */
export interface Rfc64PublicCatalogReconciliationFailureV1 {
  readonly catalogHeadDigest: Digest32V1;
  readonly errorName: string;
  readonly errorCode: string | null;
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
  record(catalogHeadDigest: Digest32V1, error: unknown): void {
    if (this.#failures.has(catalogHeadDigest)) return;
    if (
      this.#failures.size
      >= RFC64_PUBLIC_CATALOG_RECONCILIATION_FAILURE_MAX_ENTRIES_V1
    ) {
      const oldestCatalogHeadDigest = this.#failures.keys().next().value as
        | Digest32V1
        | undefined;
      if (oldestCatalogHeadDigest !== undefined) {
        this.#failures.delete(oldestCatalogHeadDigest);
      }
    }
    this.#failures.set(catalogHeadDigest, Object.freeze({
      catalogHeadDigest,
      errorName: stableErrorNameV1(error),
      errorCode: stableErrorCodeV1(error),
    }));
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

function stableErrorTokenV1(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= STABLE_ERROR_TOKEN_MAX_LENGTH_V1
    && STABLE_ERROR_TOKEN_V1.test(value)
    ? value
    : null;
}
