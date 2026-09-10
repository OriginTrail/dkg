// SPDX-License-Identifier: Apache-2.0

import {
  SwmMetaTransferOwner,
  type SwmMetaFetcher,
} from './swm-meta-fetcher.js';
import type { SwmMetaRetentionScope } from './checkpoint/state.js';

export type SwmMetaTransferMode = 'ordinary' | 'selected';

export interface SwmMetaTransferScope {
  readonly mode: SwmMetaTransferMode;
  readonly remotePeerId: string;
}

/** Allocated once for a retained owner; all identity fields share one mode. */
export interface SwmMetaTransferSession extends SwmMetaTransferScope {
  readonly requesterScope: SwmMetaRetentionScope;
}

let transferSequence = 0;

/** Agent-owned registry and shutdown boundary for isolated metadata transfer owners. */
export class SwmMetaTransferCoordinator {
  readonly #owners = new Map<string, SwmMetaTransferOwner>();

  readonly #now: () => number;

  #closed = false;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  run<T>(
    scope: SwmMetaTransferScope,
    createFetcher: (session: SwmMetaTransferSession) => SwmMetaFetcher,
    operation: (fetcher: SwmMetaFetcher) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    const { mode, remotePeerId } = scope;
    const transferKey = `${mode}\0${remotePeerId}`;
    let owner = this.#owners.get(transferKey);
    if (!owner) {
      let registeredOwner: SwmMetaTransferOwner;
      registeredOwner = new SwmMetaTransferOwner({
        now: this.#now,
        onIdle: () => {
          if (
            this.#owners.get(transferKey) === registeredOwner
            && registeredOwner.isIdle()
          ) {
            this.#owners.delete(transferKey);
          }
        },
      });
      owner = registeredOwner;
      this.#owners.set(transferKey, owner);
    }
    return owner.run(() => createFetcher({
      mode,
      remotePeerId,
      requesterScope: `${mode}-swm-meta:retained:${++transferSequence}`,
    }), operation);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const owners = [...this.#owners.values()];
    await Promise.all(owners.map((owner) => owner.close()));
    this.#owners.clear();
  }

  #closedError(): Error {
    const error = new Error('SWM metadata transfer coordinator is closed');
    error.name = 'AbortError';
    return error;
  }
}
