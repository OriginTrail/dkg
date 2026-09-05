// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';

import type { Rfc64PublicCatalogServiceV1 } from './public-catalog-service-v1.js';
import type {
  Rfc64CatalogWorkloadOwnerV1,
  Rfc64PublicCatalogRuntimeOwnerV1,
} from './catalog-runtime-v1.js';

/** Narrow transport lifecycle required by the workload owner. */
export interface Rfc64PublicCatalogLifecyclePortV1 {
  start(): void;
  whenReceiverIdle(): Promise<void>;
  closeReceiverAdmissionAndDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface Rfc64PublicCatalogWorkloadOwnerOptionsV1<
  Service extends Rfc64PublicCatalogLifecyclePortV1 = Rfc64PublicCatalogServiceV1,
> {
  readonly createService: (
    ctx: OperationContext,
  ) => Service | null;
  readonly authorityRefresh: Rfc64CatalogWorkloadOwnerV1;
  readonly onServiceStarted: (ctx: OperationContext) => void;
}

/** Single lifecycle owner for public-catalog transport and authority refresh. */
export class Rfc64PublicCatalogWorkloadOwnerV1<
  Service extends Rfc64PublicCatalogLifecyclePortV1 = Rfc64PublicCatalogServiceV1,
>
implements Rfc64PublicCatalogRuntimeOwnerV1 {
  readonly #options: Rfc64PublicCatalogWorkloadOwnerOptionsV1<Service>;
  #service: Service | null = null;
  #authorityStartAttempted = false;
  #started = false;
  #close: Promise<void> | null = null;

  constructor(options: Rfc64PublicCatalogWorkloadOwnerOptionsV1<Service>) {
    this.#options = options;
  }

  get service(): Service | undefined {
    return this.#service ?? undefined;
  }

  start(ctx: OperationContext): void {
    if (this.#close !== null) {
      throw new Error('RFC-64 public catalog owner cannot start while close is in progress');
    }
    if (this.#started) return;
    let service: Service | null = null;
    let serviceStartAttempted = false;
    let authorityStartAttempted = false;
    try {
      service = this.#options.createService(ctx);
      if (service === null) {
        this.#started = true;
        return;
      }
      serviceStartAttempted = true;
      service.start();
      this.#service = service;
      authorityStartAttempted = true;
      this.#authorityStartAttempted = true;
      this.#options.authorityRefresh.start(ctx);
      this.#options.onServiceStarted(ctx);
      this.#started = true;
    } catch (error) {
      this.#service = null;
      if (serviceStartAttempted || authorityStartAttempted) {
        this.#armClose(this.#retireAcquiredLifecycle(
          serviceStartAttempted ? service : null,
          authorityStartAttempted,
        ));
      }
      throw error;
    }
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
    const closing = this.#retireAcquiredLifecycle(service, this.#authorityStartAttempted);
    this.#armClose(closing);
    return closing;
  }

  #armClose(closing: Promise<void>): void {
    this.#close = closing;
    void closing.then(() => {
      if (this.#close !== closing) return;
      this.#started = false;
      this.#authorityStartAttempted = false;
      this.#close = null;
    }, () => {
      // A failed owner did not prove physical retirement. Preserve the
      // rejected close as a permanent same-instance restart fence.
    });
  }

  async #retireAcquiredLifecycle(
    service: Service | null,
    authorityStartAttempted: boolean,
  ): Promise<void> {
    const failures: unknown[] = [];
    const retirements = await Promise.allSettled([
      Promise.resolve().then(() => service?.close()),
      Promise.resolve().then(() => (
        authorityStartAttempted
          ? this.#options.authorityRefresh.close()
          : undefined
      )),
    ]);
    for (const result of retirements) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'RFC-64 public catalog owner close failed');
    }
  }
}
