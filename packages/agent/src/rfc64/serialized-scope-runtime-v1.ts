// SPDX-License-Identifier: Apache-2.0

import {
  raceRfc64AgainstAbortV1,
  throwIfRfc64AbortedV1,
} from './abort-v1.js';

/**
 * FIFO serialization whose queue lifetime is independent of caller cancellation.
 * A canceled waiter keeps its place until its predecessor settles, so a later
 * caller can never overlap the still-active predecessor.
 */
export class Rfc64SerializedScopeRuntimeV1 {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #abortMessage: string;

  constructor(abortMessage: string) {
    this.#abortMessage = abortMessage;
  }

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const predecessor = this.#tails.get(key)?.catch(() => undefined) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => slot);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    try {
      await raceRfc64AgainstAbortV1(predecessor, signal, this.#abortMessage);
      throwIfRfc64AbortedV1(signal, this.#abortMessage);
      return await operation();
    } finally {
      release();
    }
  }

  get activeScopeCount(): number {
    return this.#tails.size;
  }
}
