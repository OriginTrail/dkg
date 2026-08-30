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
    const work = predecessor.then(async () => {
      throwIfRfc64AbortedV1(signal, this.#abortMessage);
      return operation();
    });
    // The queue tail follows the real operation lifetime, not the caller's
    // abort race. A canceled caller returns promptly, while a non-cooperative
    // operation still owns the scope until it actually settles.
    const tail = work.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return raceRfc64AgainstAbortV1(work, signal, this.#abortMessage);
  }

  get activeScopeCount(): number {
    return this.#tails.size;
  }
}
