// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';

import type { Rfc64PublicCatalogServiceV1 } from './public-catalog-service-v1.js';
import type {
  Rfc64CatalogWorkloadOwnerV1,
  Rfc64PublicCatalogRuntimeOwnerV1,
} from './catalog-runtime-v1.js';

export interface Rfc64PublicCatalogWorkloadOwnerOptionsV1 {
  readonly createService: (
    ctx: OperationContext,
  ) => Rfc64PublicCatalogServiceV1 | null;
  readonly authorityRefresh: Rfc64CatalogWorkloadOwnerV1;
  readonly openMutationPersistence: () => void;
  readonly closeMutationPersistence: () => Promise<void>;
  readonly onServiceStarted: (ctx: OperationContext) => void;
}

/** Single lifecycle owner for public-catalog transport, refresh, and persistence. */
export class Rfc64PublicCatalogWorkloadOwnerV1
implements Rfc64PublicCatalogRuntimeOwnerV1 {
  readonly #options: Rfc64PublicCatalogWorkloadOwnerOptionsV1;
  #service: Rfc64PublicCatalogServiceV1 | null = null;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(options: Rfc64PublicCatalogWorkloadOwnerOptionsV1) {
    this.#options = options;
  }

  get service(): Rfc64PublicCatalogServiceV1 | undefined {
    return this.#service ?? undefined;
  }

  start(ctx: OperationContext): void {
    if (this.#close !== null) {
      throw new Error('RFC-64 public catalog owner cannot start while close is in progress');
    }
    if (this.#started) return;
    let service: Rfc64PublicCatalogServiceV1 | null = null;
    try {
      this.#options.openMutationPersistence();
      service = this.#options.createService(ctx);
      if (service === null) {
        this.#started = true;
        return;
      }
      service.start();
      this.#service = service;
      this.#options.authorityRefresh.start(ctx);
      this.#started = true;
    } catch (error) {
      this.#service = null;
      void service?.close().catch(() => undefined);
      throw error;
    }
    this.#options.onServiceStarted(ctx);
  }

  async whenIdle(): Promise<void> {
    await Promise.all([
      this.#service?.whenReceiverIdle(),
      this.#options.authorityRefresh.whenIdle(),
    ]);
  }

  async closeReceiverAdmission(): Promise<void> {
    await this.#service?.closeReceiverAdmissionAndDrain();
  }

  close(): Promise<void> {
    if (this.#close !== null) return this.#close;
    const service = this.#service;
    this.#service = null;
    const closing = this.#closeOwnedLifecycle(service);
    this.#close = closing;
    void closing.then(() => {
      if (this.#close !== closing) return;
      this.#started = false;
      this.#close = null;
    }, () => {
      // A failed owner did not prove physical retirement. Preserve the
      // rejected close as a permanent same-instance restart fence.
    });
    return closing;
  }

  async #closeOwnedLifecycle(
    service: Rfc64PublicCatalogServiceV1 | null,
  ): Promise<void> {
    const failures: unknown[] = [];
    const retirements = await Promise.allSettled([
      Promise.resolve().then(() => service?.close()),
      Promise.resolve().then(() => this.#options.authorityRefresh.close()),
    ]);
    for (const result of retirements) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    try {
      await this.#options.closeMutationPersistence();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'RFC-64 public catalog owner close failed');
    }
  }
}
