// SPDX-License-Identifier: Apache-2.0

/** One agent-owned lifecycle for every RFC-64 catalog producer and consumer. */

import type { OperationContext } from '@origintrail-official/dkg-core';

export interface Rfc64CatalogRuntimeOptionsV1 {
  readonly inventoryObservers: Readonly<{
    open: () => void;
    close: () => Promise<void>;
  }>;
  readonly service: Readonly<{
    /** Returns whether the transport became active for this runtime cycle. */
    start: (ctx: OperationContext) => boolean;
    /** Observes in-flight transport work. */
    whenIdle: () => Promise<void>;
    /** Fences transport admission and drains its in-flight work. */
    close: () => Promise<void>;
  }>;
  readonly receiverAdmission: Readonly<{
    close: () => Promise<void>;
  }>;
  readonly authorityRefresh: Rfc64CatalogWorkloadOwnerV1;
  readonly bootstrap: Rfc64CatalogWorkloadOwnerV1;
  readonly projection: Rfc64CatalogWorkloadOwnerV1;
  readonly mutationPersistence: Readonly<{
    /** Physically drains shared mutations, then releases catalog state. */
    close: () => Promise<void>;
  }>;
}

/** Semantic lifecycle surface implemented by each feature-local workload owner. */
export interface Rfc64CatalogWorkloadOwnerV1 {
  start(ctx: OperationContext): void;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export class Rfc64CatalogRuntimeV1 {
  readonly #options: Rfc64CatalogRuntimeOptionsV1;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(options: Rfc64CatalogRuntimeOptionsV1) {
    this.#options = options;
  }

  start(ctx: OperationContext): void {
    if (this.#close !== null) {
      throw new Error('RFC-64 catalog runtime cannot start while close is in progress');
    }
    if (this.#started) return;
    this.#options.inventoryObservers.open();
    const serviceActive = this.#options.service.start(ctx);
    if (serviceActive) this.#options.authorityRefresh.start(ctx);
    this.#options.bootstrap.start(ctx);
    this.#options.projection.start(ctx);
    this.#started = true;
  }

  async whenIdle(): Promise<void> {
    await Promise.all([
      this.#options.service.whenIdle(),
      this.#options.authorityRefresh.whenIdle(),
      this.#options.bootstrap.whenIdle(),
      this.#options.projection.whenIdle(),
    ]);
  }

  close(): Promise<void> {
    if (this.#close !== null) return this.#close;
    const closing = this.#closeOwnedLifecycle();
    this.#close = closing;
    void closing.then(() => {
      if (this.#close === closing) this.#close = null;
      this.#started = false;
    }, () => {
      // A failed owner did not prove that its resource closed. Keep the
      // rejected close promise as a permanent fence: callers may observe the
      // failure again, but same-instance restart cannot reopen partial state.
    });
    return closing;
  }

  async #closeOwnedLifecycle(): Promise<void> {
    // Preserve the production dependency order: producer admission first and
    // receiver admission second. Then fence transport and every independent
    // workload concurrently, so a non-cooperative authority read cannot delay
    // transport retirement. Mutation persistence is released only after all
    // physical workload drains have settled, including failed owners.
    const failures: unknown[] = [];
    const settle = async (actions: readonly (() => Promise<void>)[]): Promise<void> => {
      const results = await Promise.allSettled(actions.map((action) => action()));
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    };
    await settle([this.#options.inventoryObservers.close]);
    await settle([this.#options.receiverAdmission.close]);
    await settle([
      () => this.#options.authorityRefresh.close(),
      () => this.#options.bootstrap.close(),
      () => this.#options.projection.close(),
      this.#options.service.close,
    ]);
    await settle([this.#options.mutationPersistence.close]);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'RFC-64 catalog runtime close failed');
    }
  }
}
