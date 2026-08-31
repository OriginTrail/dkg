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

export class Rfc64CatalogRuntimeV1 {
  readonly #options: Rfc64CatalogRuntimeOptionsV1;
  #started = false;
  #close: Promise<void> | null = null;
  #bootstrapState: unknown;
  #projectionState: unknown;
  #projectionAdmissionClosed = false;

  constructor(options: Rfc64CatalogRuntimeOptionsV1) {
    this.#options = options;
  }

  start(ctx: OperationContext): void {
    if (this.#started) return;
    if (this.#close !== null) {
      throw new Error('RFC-64 catalog runtime cannot start while close is in progress');
    }
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

  readBootstrapState<T>(): T | undefined {
    return this.#bootstrapState as T | undefined;
  }

  writeBootstrapState<T>(state: T): void {
    this.#bootstrapState = state;
  }

  clearBootstrapState(): void {
    this.#bootstrapState = undefined;
  }

  readProjectionState<T>(): T | undefined {
    return this.#projectionState as T | undefined;
  }

  writeProjectionState<T>(state: T): void {
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
    return closing.finally(() => {
      if (this.#close === closing) this.#close = null;
      this.#started = false;
    });
  }

  async #closeOwnedLifecycle(): Promise<void> {
    // Preserve the production dependency order: producer admission first,
    // receiver admission second, then fence both independent workload owners
    // concurrently before transport and mutation persistence are released.
    await this.#options.closeInventoryObservers();
    await this.#options.closeReceiverAdmission();
    await Promise.all([
      this.#options.closeBootstrap(),
      this.#options.closeProjection(),
    ]);
    await this.#options.closeServiceAndMutations();
  }
}
