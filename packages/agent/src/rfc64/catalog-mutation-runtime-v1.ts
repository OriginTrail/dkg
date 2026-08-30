// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';

import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

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
    const key = `${computeAuthorCatalogScopeDigestV1(scope)}\n${scope.authorAddress}`;
    return this.#runtime.run(key, operation, signal);
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
