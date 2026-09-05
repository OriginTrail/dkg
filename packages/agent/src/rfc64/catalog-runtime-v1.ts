// SPDX-License-Identifier: Apache-2.0

/** One agent-owned lifecycle for every RFC-64 catalog producer and consumer. */

import type { OperationContext } from '@origintrail-official/dkg-core';

export interface Rfc64CatalogRuntimeOptionsV1 {
  readonly inventoryObservers: Readonly<{
    open: () => void;
    close: () => Promise<void>;
  }>;
  readonly mutationPersistence: Readonly<{
    open: () => void;
    close: () => Promise<void>;
  }>;
  readonly publicCatalog: Rfc64PublicCatalogRuntimeOwnerV1;
  /** Ordered independent workloads started after public transport admission. */
  readonly workloads: readonly Rfc64CatalogWorkloadOwnerV1[];
}

/** Semantic lifecycle surface implemented by each feature-local workload owner. */
export interface Rfc64CatalogWorkloadOwnerV1 {
  start(ctx: OperationContext): void;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

/** Public transport adds an early receiver-admission fence to the owner contract. */
export interface Rfc64PublicCatalogRuntimeOwnerV1 extends Rfc64CatalogWorkloadOwnerV1 {
  closeReceiverAdmission(): Promise<void>;
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
    try {
      this.#options.inventoryObservers.open();
      this.#options.mutationPersistence.open();
      this.#options.publicCatalog.start(ctx);
      for (const workload of this.#options.workloads) workload.start(ctx);
      this.#started = true;
    } catch (error) {
      this.#armClose(this.#closeOwnedLifecycle());
      throw error;
    }
  }

  async whenIdle(): Promise<void> {
    await Promise.all([
      this.#options.publicCatalog.whenIdle(),
      ...this.#options.workloads.map((workload) => workload.whenIdle()),
    ]);
  }

  close(): Promise<void> {
    if (this.#close !== null) return this.#close;
    const closing = this.#closeOwnedLifecycle();
    this.#armClose(closing);
    return closing;
  }

  #armClose(closing: Promise<void>): void {
    this.#close = closing;
    void closing.then(() => {
      if (this.#close === closing) this.#close = null;
      this.#started = false;
    }, () => {
      // A failed owner did not prove that its resource closed. Keep the
      // rejected close promise as a permanent fence: callers may observe the
      // failure again, but same-instance restart cannot reopen partial state.
    });
  }

  async #closeOwnedLifecycle(): Promise<void> {
    // Preserve the production dependency order: producer admission first and
    // receiver admission second. Then retire every independent workload
    // concurrently. Shared mutation persistence remains live until every
    // producer and consumer has physically retired.
    const failures: unknown[] = [];
    const settle = async (actions: readonly (() => Promise<void>)[]): Promise<void> => {
      const results = await Promise.allSettled(actions.map((action) => action()));
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    };
    await settle([this.#options.inventoryObservers.close]);
    await settle([() => this.#options.publicCatalog.closeReceiverAdmission()]);
    await settle([
      () => this.#options.publicCatalog.close(),
      ...this.#options.workloads.map((workload) => () => workload.close()),
    ]);
    await settle([this.#options.mutationPersistence.close]);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'RFC-64 catalog runtime close failed');
    }
  }
}
