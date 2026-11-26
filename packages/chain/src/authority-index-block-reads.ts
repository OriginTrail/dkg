// SPDX-License-Identifier: Apache-2.0
import type { Block, JsonRpcProvider } from 'ethers';
import { ContextGraphLiveAuthorityCoalescer } from './context-graph-live-authority-coalescer.js';
import { readEvmContextGraphAuthorityIndexRpcV1 } from './evm-context-graph-authority-index-rpc.js';
import { activeRpcRequestContext } from './rpc-request-transport.js';

/**
 * Share a physical block read only among callers enrolled BEFORE dispatch.
 * No block/hash result is retained. In particular a post-scan stabilization
 * read cannot reuse the read that supplied its pre-scan anchor. Later callers
 * join a successor cohort under their own original cancellation/deadline.
 */
export function createAuthorityIndexBlockReadV1(owner: {
  lifecycleSignal(): AbortSignal;
  track<T>(read: () => Promise<T>): Promise<T>;
}) {
  const generations = new WeakMap<AbortSignal, WeakMap<JsonRpcProvider, ContextGraphLiveAuthorityCoalescer<Block | null>>>();
  return (provider: JsonRpcProvider, block: number | 'latest', operation: string, signal?: AbortSignal): Promise<Block | null> => {
    const lifecycle = owner.lifecycleSignal();
    const context = activeRpcRequestContext();
    const signals = [lifecycle, signal, context.signal].filter((value): value is AbortSignal => value !== undefined);
    const waiter = AbortSignal.any(signals);
    waiter.throwIfAborted();
    let providers = generations.get(lifecycle);
    if (!providers) { providers = new WeakMap(); generations.set(lifecycle, providers); }
    let flights = providers.get(provider);
    if (!flights) {
      // The enclosing provider loop owns failure classification and failover.
      // Share only physical work here, without a second joiner retry policy.
      flights = new ContextGraphLiveAuthorityCoalescer({ errorDelivery: 'share-physical' });
      providers.set(provider, flights);
    }
    // Foreground/background partitioning belongs to the coalescer; authority
    // priority is also part of the key so an ordinary caller cannot own it.
    const key = JSON.stringify([block, context.admissionPriority ?? null]);
    return flights.run(key, physicalSignal => readEvmContextGraphAuthorityIndexRpcV1(
      // Drain the actual provider promise on close, even if its timeout/abort
      // wrapper has already rejected and the provider ignores cancellation.
      operation, () => owner.track(() => provider.getBlock(block)), physicalSignal,
    ), { signal: waiter, requestClass: context.requestClass });
  };
}
