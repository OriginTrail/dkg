// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';

/** Transport carries this observer alongside each queued issuer payload. */
export type RpcUsageObserver = (owner: object, method: string) => void;
export const rpcUsageObserverContext = new AsyncLocalStorage<RpcUsageObserver>();

/** Observe physical requests without draining or changing daemon-wide telemetry. */
export class RpcUsageScope {
  private readonly counts = new WeakMap<object, Record<string, number>>();
  run<T>(operation: () => T): T {
    return rpcUsageObserverContext.run((owner, method) => {
      let methods = this.counts.get(owner);
      if (!methods) { methods = {}; this.counts.set(owner, methods); }
      methods[method] = (methods[method] ?? 0) + 1;
    }, operation);
  }
  usage(owner: object): Readonly<Record<string, number>> {
    return Object.freeze({ ...this.counts.get(owner) });
  }
}

export function recordScopedRpcUsage(owner: object, method: string): void {
  rpcUsageObserverContext.getStore()?.(owner, method);
}
