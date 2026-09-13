// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  FetchRequest,
  JsonRpcProvider,
} from 'ethers';
import type {
  FetchCancelSignal,
  FetchGetUrlFunc,
  JsonRpcApiProviderOptions,
  Networkish,
} from 'ethers';
import { errorMessage } from './evm-adapter-errors.js';
import { createRpcTimeoutError } from './chain-rpc-transport-error.js';

export type RpcRequestClass = 'foreground' | 'background';

/** One raw-RPC policy context: priority and cancellation cannot drift apart. */
export interface RpcRequestContext {
  readonly requestClass: RpcRequestClass;
  readonly signal?: AbortSignal;
}

export interface RpcRequestContextInput {
  readonly requestClass?: RpcRequestClass;
  readonly signal?: AbortSignal;
  /** Internal shared work may deliberately outlive the initiating caller. */
  readonly inheritSignal?: boolean;
}

const rpcRequestContext = new AsyncLocalStorage<RpcRequestContext>();

export function activeRpcRequestContext(): RpcRequestContext {
  return rpcRequestContext.getStore() ?? { requestClass: 'foreground' };
}

/**
 * Establish one request policy boundary. Nested scopes inherit priority and
 * compose cancellation exactly once. `inheritSignal:false` is reserved for
 * shared physical work whose lifetime must not be owned by its first waiter.
 */
export function withRpcRequestContext<T>(input: RpcRequestContextInput, fn: () => T): T {
  const parent = activeRpcRequestContext();
  const inheritedSignal = input.inheritSignal === false ? undefined : parent.signal;
  const signal = inheritedSignal === undefined
    ? input.signal
    : input.signal === undefined || input.signal === inheritedSignal
      ? inheritedSignal
      : AbortSignal.any([inheritedSignal, input.signal]);
  return rpcRequestContext.run({
    requestClass: input.requestClass ?? parent.requestClass,
    ...(signal === undefined ? {} : { signal }),
  }, fn);
}

export function activeRpcRequestAbortSignal(): AbortSignal | undefined {
  return activeRpcRequestContext().signal;
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
  options: { inheritSignal?: boolean } = {},
): Promise<T> {
  const timeoutController = new AbortController();
  const parentSignal = options.inheritSignal === false
    ? undefined
    : activeRpcRequestAbortSignal();
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
    const attempt = Promise.resolve(withRpcRequestContext({
      signal,
      inheritSignal: false,
    }, fn));
    return await Promise.race([attempt, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Wait for shared physical work without allowing this waiter to cancel it. */
export async function waitForActiveRpcRequest<T>(shared: Promise<T>): Promise<T> {
  const signal = activeRpcRequestAbortSignal();
  if (signal === undefined) return shared;
  if (signal.aborted) throwRpcRequestAbortReason(signal);
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
    return await Promise.race([shared, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * FetchRequest transport that combines ethers' cancellation signal with the
 * caller-owned signal bound by {@link withRpcRequestContext}. Keeping the
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

const RPC_REQUEST_MAX_RETRIES = 5;
const RPC_REQUEST_RETRY_BACKOFF_CAP_MS = 1_500;

async function waitForRetryBackoff(delayMs: number): Promise<void> {
  const signal = activeRpcRequestAbortSignal();
  if (signal?.aborted) throwRpcRequestAbortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      try {
        throwRpcRequestAbortReason(signal!);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Bounded ethers retry transport shared by every provider construction path. */
export function boundedRetryFetchRequest(
  url: string,
  maxRetries: number = RPC_REQUEST_MAX_RETRIES,
): FetchRequest {
  const request = new FetchRequest(url);
  request.getUrlFunc = cancellableRpcGetUrl;
  request.retryFunc = async (_attemptRequest, _response, attempt) => {
    if (attempt >= maxRetries) return false;
    await waitForRetryBackoff(
      Math.min(500 * (attempt + 1), RPC_REQUEST_RETRY_BACKOFF_CAP_MS),
    );
    return true;
  };
  return request;
}

export interface RpcRequestAdmission {
  acquireActiveRequest(signal?: AbortSignal): Promise<void>;
}

export interface RpcRequestProviderConfig {
  readonly maxRetries?: number;
  readonly providerOptions?: JsonRpcApiProviderOptions;
  readonly network?: Networkish;
  readonly endpointSlot?: number;
  readonly admission?: RpcRequestAdmission;
  readonly onRequest?: (method: string, endpointSlot?: number) => void;
}

function methodsFromRequestBody(body: Uint8Array | null | undefined): string[] {
  try {
    if (!body || body.length === 0) return ['other'];
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const methods = entries.map((entry) => String(
      entry && typeof entry === 'object' && 'method' in entry
        ? (entry as { method?: unknown }).method ?? 'other'
        : 'other',
    ));
    return methods.length > 0 ? methods : ['other'];
  } catch {
    return ['other'];
  }
}

async function admitAndObserveRpcAttempt(
  methods: readonly string[],
  transport: Pick<RpcRequestProviderConfig, 'admission' | 'onRequest' | 'endpointSlot'>,
): Promise<void> {
  for (const _method of methods) await transport.admission?.acquireActiveRequest();
  try {
    for (const method of methods) {
      transport.onRequest?.(method, transport.endpointSlot);
    }
  } catch {
    /* optional instrumentation must never break transport */
  }
}

/** The canonical provider factory for tracked adapters and untracked probes. */
export function createRpcRequestProvider(
  url: string,
  config: RpcRequestProviderConfig,
): JsonRpcProvider {
  const request = boundedRetryFetchRequest(url, config.maxRetries);
  // FetchRequest invokes getUrlFunc once for every physical HTTP attempt:
  // initial dispatch, ethers retry, redirect, and process retry alike. Owning
  // admission and accounting at this boundary keeps them exact without
  // duplicating ethers' dispatch lifecycle across provider and retry hooks.
  request.getUrlFunc = async (attemptRequest, signal) => {
    const methods = methodsFromRequestBody(attemptRequest.body);
    if (config.admission !== undefined && methods.length > 1) {
      throw new TypeError(
        'Governed RPC transports require single-entry JSON-RPC dispatch',
      );
    }
    await admitAndObserveRpcAttempt(methods, config);
    return cancellableRpcGetUrl(attemptRequest, signal);
  };
  if (
    config.admission !== undefined
    && (config.providerOptions?.batchMaxCount ?? 1) > 1
  ) {
    throw new TypeError(
      'Governed RPC transports require providerOptions.batchMaxCount <= 1',
    );
  }
  // Ethers batches by default when the option is omitted. A governor accounts
  // and paces billable JSON-RPC entries, so governed providers must disable
  // coalescing at construction rather than acquiring N permits and releasing
  // one N-entry HTTP burst later.
  const normalizedProviderOptions = config.admission === undefined
    ? config.providerOptions
    : { ...config.providerOptions, batchMaxCount: 1 };
  const providerOptions = config.network == null
    ? normalizedProviderOptions
    : {
        ...normalizedProviderOptions,
        staticNetwork: config.network as JsonRpcApiProviderOptions['staticNetwork'],
      };
  return new JsonRpcProvider(request, config.network, providerOptions);
}
