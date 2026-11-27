// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { rpcUsageObserverContext, type RpcUsageObserver } from './rpc-usage-scope.js';
export const rpcUsageConsumerContext = new AsyncLocalStorage<string>();
export const rpcUsageSiteContext = new AsyncLocalStorage<string>();

/**
 * Consumer attribution owned by the caller that issued one provider payload.
 *
 * Ethers queues `send()` calls and dispatches them later from a shared drain
 * timer. The timer's async context belongs to whichever caller created it, so
 * the transport must carry this context beside each queued payload instead of
 * sampling whatever consumer happens to own the drain.
 *
 * Adapter role is intentionally absent: it is fixed on `RpcUsageTracker` when
 * an adapter is constructed, so a request cannot borrow another adapter's
 * role through async context.
 */
export interface RpcUsageIssuerContext {
  readonly consumer?: string;
  readonly site?: string;
  readonly observer?: RpcUsageObserver;
}

/** Capture the bounded attribution context at the provider `send()` boundary. */
export function captureRpcUsageIssuerContext(): RpcUsageIssuerContext {
  const consumer = rpcUsageConsumerContext.getStore();
  const site = rpcUsageSiteContext.getStore();
  const observer = rpcUsageObserverContext.getStore();
  return Object.freeze({
    ...(consumer === undefined ? {} : { consumer }),
    ...(site === undefined ? {} : { site }),
    ...(observer === undefined ? {} : { observer }),
  });
}

/** Restore one issuer's attribution, explicitly clearing any foreign context. */
export function withRpcUsageIssuerContext<T>(
  context: RpcUsageIssuerContext,
  fn: () => T,
): T {
  const runObserver = () => context.observer === undefined
    ? rpcUsageObserverContext.exit(fn)
    : rpcUsageObserverContext.run(context.observer, fn);
  const runSite = () => context.site === undefined
    ? rpcUsageSiteContext.exit(runObserver)
    : rpcUsageSiteContext.run(context.site, runObserver);
  return context.consumer === undefined
    ? rpcUsageConsumerContext.exit(runSite)
    : rpcUsageConsumerContext.run(context.consumer, runSite);
}

