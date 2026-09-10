// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  FetchCancelSignal,
  FetchGetUrlFunc,
  FetchRequest,
} from 'ethers';
import { errorMessage } from './evm-adapter-errors.js';
import { createRpcTimeoutError } from './chain-rpc-transport-error.js';

const rpcRequestAbortContext = new AsyncLocalStorage<AbortSignal>();

/** Bind one caller-owned cancellation signal to the raw ethers HTTP request. */
export function withRpcRequestAbortSignal<T>(signal: AbortSignal, fn: () => T): T {
  const parentSignal = rpcRequestAbortContext.getStore();
  return rpcRequestAbortContext.run(
    parentSignal === undefined ? signal : AbortSignal.any([parentSignal, signal]),
    fn,
  );
}

export function activeRpcRequestAbortSignal(): AbortSignal | undefined {
  return rpcRequestAbortContext.getStore();
}

/** Normalize caller/deadline cancellation consistently at every transport gate. */
export function throwRpcRequestAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'RPC request aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Run an entire provider attempt inside a cancellable deadline. The signal is
 * visible both to governor admission and to the concrete HTTP transport, while
 * the explicit race keeps the caller's timeout prompt even if third-party code
 * is temporarily between cancellable stages (for example in retry backoff).
 */
export async function withRpcRequestTimeout<T>(
  timeoutMs: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const timeoutController = new AbortController();
  const parentSignal = activeRpcRequestAbortSignal();
  const signal = parentSignal === undefined
    ? timeoutController.signal
    : AbortSignal.any([parentSignal, timeoutController.signal]);
  const timeoutError = createRpcTimeoutError(`${label} timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  timer.unref?.();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        throwRpcRequestAbortReason(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const attempt = Promise.resolve(withRpcRequestAbortSignal(signal, fn));
    return await Promise.race([attempt, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * FetchRequest transport that combines ethers' cancellation signal with the
 * caller-owned signal bound by {@link withRpcRequestAbortSignal}. Keeping the
 * bridge here lets JsonRpcProvider retain its native `_send` implementation;
 * this function owns only the HTTP request that can actually close the socket.
 */
export const cancellableRpcGetUrl: FetchGetUrlFunc = async (
  request: FetchRequest,
  signal?: FetchCancelSignal,
) => {
  signal?.checkSignal();
  const callerSignal = activeRpcRequestAbortSignal();
  if (callerSignal?.aborted) throwRpcRequestAbortReason(callerSignal);

  const controller = new AbortController();
  let cancelled = false;
  let callerCancelled = false;
  let timedOut = false;
  signal?.addListener(() => {
    cancelled = true;
    controller.abort();
  });
  const onCallerAbort = () => {
    callerCancelled = true;
    controller.abort();
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeout);
  try {
    let requestBody: ArrayBuffer | undefined;
    if (request.body) {
      requestBody = new ArrayBuffer(request.body.length);
      new Uint8Array(requestBody).set(request.body);
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: requestBody,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers,
      body: body.length > 0 ? body : null,
    };
  } catch (error) {
    if (callerCancelled && callerSignal) throwRpcRequestAbortReason(callerSignal);
    if (cancelled) {
      throw Object.assign(new Error('RPC request cancelled', { cause: error }), {
        code: 'CANCELLED',
      });
    }
    if (timedOut) {
      throw Object.assign(new Error(`RPC request timed out after ${request.timeout}ms`, {
        cause: error,
      }), { code: 'TIMEOUT' });
    }
    const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    throw Object.assign(
      new Error(`RPC fetch failed: ${errorMessage(error)}`, { cause: error }),
      {
        code: typeof causeCode === 'string' && causeCode.length > 0
          ? causeCode.toUpperCase()
          : 'NETWORK_ERROR',
      },
    );
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
};
