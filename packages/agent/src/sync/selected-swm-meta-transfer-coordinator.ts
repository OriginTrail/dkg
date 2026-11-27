// SPDX-License-Identifier: Apache-2.0

import {
  SelectedSwmMetaTransferOwner,
  type SelectedSwmMetaFetcher,
} from './selected-swm-meta-fetcher.js';

/** Agent-owned registry and shutdown boundary for per-peer metadata transfer owners. */
export class SelectedSwmMetaTransferCoordinator {
  readonly #owners = new Map<string, SelectedSwmMetaTransferOwner>();

  readonly #now: () => number;

  #closed = false;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  run<T>(
    remotePeerId: string,
    createFetcher: () => SelectedSwmMetaFetcher,
    operation: (fetcher: SelectedSwmMetaFetcher) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    let owner = this.#owners.get(remotePeerId);
    if (!owner) {
      let registeredOwner: SelectedSwmMetaTransferOwner;
      registeredOwner = new SelectedSwmMetaTransferOwner({
        now: this.#now,
        onIdle: () => {
          if (
            this.#owners.get(remotePeerId) === registeredOwner
            && registeredOwner.isIdle()
          ) {
            this.#owners.delete(remotePeerId);
          }
        },
      });
      owner = registeredOwner;
      this.#owners.set(remotePeerId, owner);
    }
    const execute = owner.run(createFetcher, operation);
    return execute;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const owners = [...this.#owners.values()];
    await Promise.all(owners.map((owner) => owner.close()));
    this.#owners.clear();
  }

  #closedError(): Error {
    const error = new Error('Selected SWM metadata transfer coordinator is closed');
    error.name = 'AbortError';
    return error;
  }
}
