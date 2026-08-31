// SPDX-License-Identifier: Apache-2.0

/** One agent-owned lifecycle for every RFC-64 catalog producer and consumer. */

import type { OperationContext } from '@origintrail-official/dkg-core';

export interface Rfc64CatalogRuntimeOptionsV1 {
  readonly openInventoryObservers: () => void;
  readonly startService: (ctx: OperationContext) => void;
  readonly startBootstrap: (ctx: OperationContext) => void;
  readonly startProjection: (ctx: OperationContext) => void;
  readonly whenBootstrapIdle: () => Promise<void>;
  readonly whenProjectionIdle: () => Promise<void>;
  readonly closeInventoryObservers: () => Promise<void>;
  readonly closeReceiverAdmission: () => Promise<void>;
  readonly closeBootstrap: () => Promise<void>;
  readonly closeProjection: () => Promise<void>;
  /** Closes transport and physically drains the shared mutation coordinator. */
  readonly closeServiceAndMutations: () => Promise<void>;
}

export class Rfc64CatalogRuntimeV1<BootstrapState, ProjectionState> {
  readonly #options: Rfc64CatalogRuntimeOptionsV1;
  #started = false;
  #close: Promise<void> | null = null;
  #bootstrapState: BootstrapState | undefined;
  #projectionState: ProjectionState | undefined;
  #projectionAdmissionClosed = false;

  constructor(options: Rfc64CatalogRuntimeOptionsV1) {
    this.#options = options;
  }

  start(ctx: OperationContext): void {
    if (this.#close !== null) {
      throw new Error('RFC-64 catalog runtime cannot start while close is in progress');
    }
    if (this.#started) return;
    this.#projectionAdmissionClosed = false;
    this.#options.openInventoryObservers();
    this.#options.startService(ctx);
    this.#options.startBootstrap(ctx);
    this.#options.startProjection(ctx);
    this.#started = true;
  }

  async whenIdle(): Promise<void> {
    await Promise.all([
      this.#options.whenBootstrapIdle(),
      this.#options.whenProjectionIdle(),
    ]);
  }

  readBootstrapState(): BootstrapState | undefined {
    return this.#bootstrapState;
  }

  writeBootstrapState(state: BootstrapState): void {
    this.#bootstrapState = state;
  }

  clearBootstrapState(): void {
    this.#bootstrapState = undefined;
  }

  readProjectionState(): ProjectionState | undefined {
    return this.#projectionState;
  }

  writeProjectionState(state: ProjectionState): void {
    this.#projectionState = state;
  }

  clearProjectionState(): void {
    this.#projectionState = undefined;
  }

  get projectionAdmissionClosed(): boolean {
    return this.#projectionAdmissionClosed;
  }

  closeProjectionAdmission(): void {
    this.#projectionAdmissionClosed = true;
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
    // Preserve the production dependency order: producer admission first,
    // receiver admission second, then fence both independent workload owners
    // concurrently before transport and mutation persistence are released.
    const failures: unknown[] = [];
    const settle = async (actions: readonly (() => Promise<void>)[]): Promise<void> => {
      const results = await Promise.allSettled(actions.map((action) => action()));
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    };
    await settle([this.#options.closeInventoryObservers]);
    await settle([this.#options.closeReceiverAdmission]);
    await settle([
      this.#options.closeBootstrap,
      this.#options.closeProjection,
    ]);
    await settle([this.#options.closeServiceAndMutations]);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'RFC-64 catalog runtime close failed');
    }
  }
}
