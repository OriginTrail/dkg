// SPDX-License-Identifier: Apache-2.0

import { waitForSignal } from './wait-for-signal.js';

/** Shared ownership of scans and their independently cancellable physical work. */
export class ContextGraphAuthorityIndexActivity {
  readonly #pending = new Set<Promise<unknown>>();
  #revision = 0;

  track<T>(pending: Promise<T>): Promise<T> {
    this.#revision += 1;
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    // The waiter may time out before an uncooperative transport/store settles.
    // Keep physical ownership so close()/whenIdle() still drain that operation.
    return waitForSignal(this.track(operation()), signal);
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const revision = this.#revision;
      await Promise.allSettled(this.#pending);
      if (revision === this.#revision && this.#pending.size === 0) return;
    }
  }
}
