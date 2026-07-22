// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import { JsonRpcProvider } from 'ethers';
import type {
  FetchRequest,
  Networkish,
  JsonRpcApiProviderOptions,
  JsonRpcPayload,
  JsonRpcResult,
} from 'ethers';

const rpcRequestAbortContext = new AsyncLocalStorage<AbortSignal>();

/** Bind one caller-owned cancellation signal to the raw ethers HTTP request. */
export function withRpcRequestAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  return rpcRequestAbortContext.run(signal, fn);
}

function activeRpcRequestAbortSignal(): AbortSignal | undefined {
  return rpcRequestAbortContext.getStore();
}

function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'RPC request aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Ethers provider transport boundary that connects a request-scoped abort
 * signal to the active FetchRequest and therefore to the underlying HTTP
 * socket. Higher layers establish the signal with
 * {@link withRpcRequestAbortSignal}; usage accounting remains a separate
 * observer in `rpc-usage.ts`.
 */
export class CancellableJsonRpcProvider extends JsonRpcProvider {
  constructor(
    url: string | FetchRequest,
    network?: Networkish,
    options?: JsonRpcApiProviderOptions,
  ) {
    super(url, network, options);
  }

  override async _send(
    payload: JsonRpcPayload | Array<JsonRpcPayload>,
  ): Promise<Array<JsonRpcResult>> {
    const signal = activeRpcRequestAbortSignal();
    if (!signal) return super._send(payload);
    if (signal.aborted) throwAbortReason(signal);

    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader('content-type', 'application/json');
    const pending = request.send();
    const onAbort = () => {
      try {
        request.cancel();
      } catch {
        // The response may settle concurrently with the abort.
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const response = await pending;
      response.assertOk();
      const body = response.bodyJson;
      return Array.isArray(body) ? body : [body];
    } catch (error) {
      if (signal.aborted) throwAbortReason(signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
