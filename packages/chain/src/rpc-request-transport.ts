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
  JsonRpcPayload,
  JsonRpcResult,
  Network,
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
}

const rpcRequestContext = new AsyncLocalStorage<RpcRequestContext>();

export function activeRpcRequestContext(): RpcRequestContext {
  return rpcRequestContext.getStore() ?? { requestClass: 'foreground' };
}

/**
 * Establish one compositional request policy boundary. Nested scopes inherit
 * priority and cancellation, composing an explicit child signal when present.
 */
export function withRpcRequestContext<T>(input: RpcRequestContextInput, fn: () => T): T {
  const parent = activeRpcRequestContext();
  const inheritedSignal = parent.signal;
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

/**
 * Establish a lifecycle-owned request boundary. Priority still inherits when
 * omitted, while cancellation belongs exclusively to the explicit owner.
 * Shared physical work uses this boundary so its first waiter cannot cancel it.
 */
export function withOwnedRpcRequestContext<T>(
  input: RpcRequestContextInput,
  fn: () => T,
): T {
  const parent = activeRpcRequestContext();
  return rpcRequestContext.run({
    requestClass: input.requestClass ?? parent.requestClass,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
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
    const attempt = Promise.resolve(withOwnedRpcRequestContext({ signal }, fn));
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

function createRpcProviderRequest(
  url: string,
  config: RpcRequestProviderConfig,
): FetchRequest {
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
  return request;
}

function configuredProviderOptions(
  config: RpcRequestProviderConfig,
  providerOptions: JsonRpcApiProviderOptions | undefined,
): JsonRpcApiProviderOptions | undefined {
  if (config.network == null) return providerOptions;
  return {
    ...providerOptions,
    staticNetwork: config.network as JsonRpcApiProviderOptions['staticNetwork'],
  };
}

/**
 * JSON-RPC provider that dispatches each payload in its ISSUER's request
 * context.
 *
 * `JsonRpcApiProvider.send` only enqueues; the physical `_send` runs from one
 * shared drain timer created by whichever caller enqueued first. Every payload
 * that lands in that window therefore reaches `getUrlFunc` — where admission
 * priority and cancellation are resolved from {@link rpcRequestContext} — under
 * a FOREIGN caller's context. Cancelling that caller (a read deadline, or
 * shared physical work abandoned by its last waiter) then aborts an unrelated
 * caller's live HTTP attempt; the failover classifier reads the resulting
 * `AbortError` as a transport fault and reports `RPC_ENDPOINTS_EXHAUSTED`
 * carrying the foreign cancellation's message.
 *
 * These transports already disable coalescing (`batchMaxCount: 1`). Record one
 * issuer context for each canonical `send` call and restore it only at the
 * `_send` boundary. Ethers continues to own request IDs, startup, queuing,
 * debug/error events, destruction checks, response matching, and RPC errors.
 */
class RequestContextJsonRpcProvider extends JsonRpcProvider {
  readonly #pendingRequestContexts: Array<{ readonly context: RpcRequestContext }> = [];

  override _detectNetwork(): Promise<Network> {
    // Network discovery belongs to the provider lifecycle. It can be triggered
    // synchronously by the first caller's `_start()`, but must not inherit that
    // caller's deadline and leave the shared provider retrying forever inside
    // an already-aborted context.
    return rpcRequestContext.run(
      { requestClass: 'foreground' },
      () => super._detectNetwork(),
    );
  }

  override async send(
    method: string,
    params: Array<unknown> | Record<string, unknown>,
  ): Promise<unknown> {
    const pending = { context: activeRpcRequestContext() };
    // JsonRpcProvider.send performs this same lazy start before delegating. Do
    // it first so bootstrap network detection cannot consume a user payload's
    // queued context, then delegate the complete request lifecycle unchanged.
    await this._start();
    this.#pendingRequestContexts.push(pending);
    try {
      return await super.send(method, params);
    } finally {
      // Destruction can reject a queued request before `_send` consumes it.
      const index = this.#pendingRequestContexts.indexOf(pending);
      if (index >= 0) this.#pendingRequestContexts.splice(index, 1);
    }
  }

  override _send(
    payload: JsonRpcPayload | Array<JsonRpcPayload>,
  ): Promise<Array<JsonRpcResult>> {
    const pending = this.#pendingRequestContexts.shift();
    if (!pending) return super._send(payload);
    return rpcRequestContext.run(pending.context, () => super._send(payload));
  }
}

/** The canonical provider factory for tracked adapters and untracked probes. */
export function createRpcRequestProvider(
  url: string,
  config: RpcRequestProviderConfig,
): JsonRpcProvider {
  // Context ownership is defined for one caller per physical request. Do not
  // silently switch to a plain batching provider when a caller changes a
  // throughput option: use createBatchedRpcRequestProvider explicitly when
  // shared batch ownership is intentional.
  if ((config.providerOptions?.batchMaxCount ?? 1) > 1) {
    throw new TypeError(
      'Context-aware RPC transports require providerOptions.batchMaxCount <= 1; '
      + 'use createBatchedRpcRequestProvider for explicit batching',
    );
  }
  // Ethers batches by default when the option is omitted. A governor accounts
  // and paces billable JSON-RPC entries, so governed providers must disable
  // coalescing at construction rather than acquiring N permits and releasing
  // one N-entry HTTP burst later.
  const normalizedProviderOptions = { ...config.providerOptions, batchMaxCount: 1 };
  return new RequestContextJsonRpcProvider(
    createRpcProviderRequest(url, config),
    config.network,
    configuredProviderOptions(config, normalizedProviderOptions),
  );
}

/**
 * Build an explicitly shared-batch provider for callers that do not need
 * per-caller cancellation or admission ownership.
 *
 * The context-aware factory above deliberately rejects batching so changing a
 * performance option cannot silently change request ownership semantics.
 */
export function createBatchedRpcRequestProvider(
  url: string,
  config: RpcRequestProviderConfig,
): JsonRpcProvider {
  if (config.admission !== undefined) {
    throw new TypeError(
      'Batched RPC transports cannot use request admission; use createRpcRequestProvider',
    );
  }
  return new JsonRpcProvider(
    createRpcProviderRequest(url, config),
    config.network,
    configuredProviderOptions(config, config.providerOptions),
  );
}
