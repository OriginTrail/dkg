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
  readonly #contextGraphRuntime = new Rfc64SerializedScopeRuntimeV1(
    'RFC-64 context-graph mutation aborted',
  );

  readonly #authorScopeRuntime = new Rfc64SerializedScopeRuntimeV1(
    'RFC-64 catalog mutation aborted',
  );

  run<T>(
    scope: Readonly<AuthorCatalogScopeV1>,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const authorScopeKey = `${computeAuthorCatalogScopeDigestV1(scope)}\n${scope.authorAddress}`;
    return this.runContextGraph(
      scope.networkId,
      scope.contextGraphId,
      () => this.#authorScopeRuntime.run(authorScopeKey, operation, signal),
      signal,
    );
  }

  /**
   * Serialize every writer that can touch SWM materialization for one Context
   * Graph. VM recovery stages through the same exact SWM graphs that RFC-64
   * atomically replaces, so author-scope serialization alone is insufficient.
   */
  runContextGraph<T>(
    networkId: string,
    contextGraphId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#contextGraphRuntime.run(
      `${networkId}\n${contextGraphId}`,
      operation,
      signal,
    );
  }

  reopen(): void {
    this.#contextGraphRuntime.reopen();
    this.#authorScopeRuntime.reopen();
  }

  async closeAndDrain(): Promise<void> {
    // Fence the outer admission boundary first. Existing operations retain
    // their inner author scope until they settle, then both runtimes drain.
    await this.#contextGraphRuntime.closeAndDrain();
    await this.#authorScopeRuntime.closeAndDrain();
  }

  get activeScopeCount(): number {
    return this.#contextGraphRuntime.activeScopeCount;
  }
}
