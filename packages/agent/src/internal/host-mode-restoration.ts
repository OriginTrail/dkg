// SPDX-License-Identifier: Apache-2.0
import type { SwmHostModeSubscriptionBinding } from '../swm/host-mode-store.js';

/**
 * One gossip lifetime's bounded startup prefix and physically owned tail.
 * Startup restores at most reconcileBatchSize markers inline (each costs a
 * store probe and, on a public host, a chain RPC pair). The remainder runs off
 * the boot path, and shutdown joins it before dependency teardown.
 * Closing fences the walk between markers and its awaited admission callbacks;
 * the same physical drain remains observable to repeated callers.
 */
export class HostModeRestoration {
  readonly startupReady: Promise<void>;
  readonly drained: Promise<void>;
  #closed = false;

  constructor(ports?: {
    list(): Promise<SwmHostModeSubscriptionBinding[]>;
    restore(entry: SwmHostModeSubscriptionBinding, current: () => boolean): Promise<void>;
    current(): boolean;
    batchSize: number;
    failed(error: unknown): void;
  }) {
    if (ports === undefined) {
      this.#closed = true;
      this.startupReady = this.drained = Promise.resolve();
      return;
    }
    let ready!: () => void;
    this.startupReady = new Promise<void>(resolve => { ready = resolve; });
    const current = (): boolean => !this.#closed && ports.current();
    this.drained = (async () => {
      await Promise.resolve();
      try {
        const entries = await ports.list();
        for (let index = 0; index < entries.length; index++) {
          if (index === ports.batchSize) {
            ready();
            await new Promise<void>(resolve => { setTimeout(resolve, 0); });
          }
          if (!current()) return;
          await ports.restore(entries[index], current);
        }
      } catch (error) { ports.failed(error); }
      finally { ready(); }
    })();
  }

  get closed(): boolean { return this.#closed; }

  /** Synchronous admission fence; repeat calls join the same physical work. */
  close(): Promise<void> {
    this.#closed = true;
    return this.drained;
  }
}
