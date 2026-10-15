// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CountV1,
} from '@origintrail-official/dkg-core';

import {
  raceRfc64AgainstAbortV1,
  throwIfRfc64AbortedV1,
} from './abort-v1.js';
import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

const RFC64_CATALOG_MUTATION_ABORT_MESSAGE_V1 = 'RFC-64 catalog mutation aborted';

/**
 * One key per author lane. The bucket count is part of the catalog scope, and a catalog moved to
 * more buckets is a scope of its own (GH#3134): the key is the lane's one-bucket scope, so the move
 * and every mutation of either scope take the same lock. A one-bucket scope keys as it always did.
 */
export function rfc64CatalogMutationScopeKeyV1(
  scope: Readonly<AuthorCatalogScopeV1>,
): string {
  const lane = { ...scope, bucketCount: '1' as CountV1 };
  return `${computeAuthorCatalogScopeDigestV1(lane)}\n${scope.authorAddress}`;
}

/**
 * Explicit agent-owned coordinator shared by local authoring and remote apply.
 * Its lifecycle is drained before the catalog service and persistence close.
 */
export class Rfc64CatalogMutationCoordinatorV1 {
  readonly #runtime = new Rfc64SerializedScopeRuntimeV1(
    RFC64_CATALOG_MUTATION_ABORT_MESSAGE_V1,
  );

  run<T>(
    scope: Readonly<AuthorCatalogScopeV1>,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#runtime.run(rfc64CatalogMutationScopeKeyV1(scope), operation, signal);
  }

  /** Acquire a unique scope set in canonical order before starting the operation. */
  runMany<T>(
    scopes: readonly Readonly<AuthorCatalogScopeV1>[],
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const orderedScopes = [...new Map(scopes.map((scope) => [
      rfc64CatalogMutationScopeKeyV1(scope),
      scope,
    ] as const)).entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, scope]) => scope);
    const acquire = (scopeIndex: number): Promise<T> => {
      throwIfRfc64AbortedV1(signal, RFC64_CATALOG_MUTATION_ABORT_MESSAGE_V1);
      const scope = orderedScopes[scopeIndex];
      if (scope === undefined) return operation();
      // Keep each outer lock chained to the physical completion of every
      // inner lock and the operation. Only the caller-facing promise races
      // cancellation; nested lock ownership must never unwind early.
      return this.run(scope, () => acquire(scopeIndex + 1));
    };
    return raceRfc64AgainstAbortV1(
      () => acquire(0),
      signal,
      RFC64_CATALOG_MUTATION_ABORT_MESSAGE_V1,
    );
  }

  reopen(): void {
    this.#runtime.reopen();
  }

  closeAndDrain(): Promise<void> {
    return this.#runtime.closeAndDrain();
  }

  get activeScopeCount(): number {
    return this.#runtime.activeScopeCount;
  }
}
