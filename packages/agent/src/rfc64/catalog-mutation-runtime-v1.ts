// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';

import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

export function rfc64CatalogMutationScopeKeyV1(
  scope: Readonly<AuthorCatalogScopeV1>,
): string {
  return `${computeAuthorCatalogScopeDigestV1(scope)}\n${scope.authorAddress}`;
}

/**
 * Explicit agent-owned coordinator shared by local authoring and remote apply.
 * Its lifecycle is drained before the catalog service and persistence close.
 */
export class Rfc64CatalogMutationCoordinatorV1 {
  readonly #runtime = new Rfc64SerializedScopeRuntimeV1(
    'RFC-64 catalog mutation aborted',
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
      const scope = orderedScopes[scopeIndex];
      if (scope === undefined) return operation();
      return this.run(scope, () => acquire(scopeIndex + 1), signal);
    };
    return acquire(0);
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
