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
import { errorCode, errorMessage } from './evm-adapter-errors.js';
import {
  createRpcAdmissionTimeoutError,
  createRpcTimeoutError,
} from './chain-rpc-transport-error.js';
import {
  captureRpcUsageIssuerContext,
  withRpcUsageIssuerContext,
  type RpcUsageIssuerContext,
} from './rpc-usage.js';
import { rpcRequestAbortReason } from './rpc-request-abort.js';
import { chainRpcFetch } from './rpc-http1-dispatcher.js';
import { recordRpcAdmissionWait, recordRpcEndpointLatency } from './rpc-request-timing.js';

export type RpcRequestClass = 'foreground' | 'background';

/**
 * Internal admission priority for a read that must complete before its
 * fail-closed security deadline. It changes queue order inside the request's
 * own class, and in the background class the request is not held by the
 * start-up delay. The request still consumes that class's ordinary rate
 * budget.
 */
export type RpcRequestAdmissionPriority = 'authority';

/**
 * What one deadline-bound attempt has done at the HTTP boundary: requests still
 * waiting for local admission, and requests that left the process. A nested
 * deadline (a shared chainId validation inside an endpoint attempt) reports to
 * every enclosing attempt as well.
 */
interface RpcAttemptProgress {
  waitingForAdmission: number;
  dispatched: number;
  readonly enclosing?: RpcAttemptProgress;
}

function noteAttemptProgress(
  progress: RpcAttemptProgress | undefined,
  update: (attempt: RpcAttemptProgress) => void,
): void {
  for (let attempt = progress; attempt !== undefined; attempt = attempt.enclosing) {
    update(attempt);
  }
}

/** A response deadline starts after admission and includes the complete body. */
export interface RpcResponseStallPolicy {
  readonly timeoutMs: number;
  readonly onTimeout?: (error: Error) => void;
}

/** One raw-RPC policy context: priority and cancellation cannot drift apart. */
export interface RpcRequestContext {
  readonly requestClass: RpcRequestClass;
  readonly admissionPriority?: RpcRequestAdmissionPriority;
  readonly signal?: AbortSignal;
  /** Transient caller observer, notified only after its raw RPC succeeds. */
  readonly onProgress?: () => void;
  readonly responseStallPolicy?: RpcResponseStallPolicy;
  /** Set by {@link withRpcRequestTimeout}; nested scopes inherit it. */
  readonly attemptProgress?: RpcAttemptProgress;
}

export interface RpcRequestContextInput {
  readonly requestClass?: RpcRequestClass;
  readonly admissionPriority?: RpcRequestAdmissionPriority;
  readonly signal?: AbortSignal;
  readonly onProgress?: () => void;
  readonly responseStallPolicy?: RpcResponseStallPolicy;
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
  const admissionPriority = input.admissionPriority ?? parent.admissionPriority;
  const inheritedSignal = parent.signal;
  const signal = inheritedSignal === undefined
    ? input.signal
    : input.signal === undefined || input.signal === inheritedSignal
      ? inheritedSignal
      : AbortSignal.any([inheritedSignal, input.signal]);
  const onProgress = input.onProgress ?? parent.onProgress;
  const responseStallPolicy = input.responseStallPolicy ?? parent.responseStallPolicy;
  return rpcRequestContext.run({
    requestClass: input.requestClass ?? parent.requestClass,
    ...(admissionPriority === undefined ? {} : { admissionPriority }),
    ...(signal === undefined ? {} : { signal }),
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(responseStallPolicy === undefined ? {} : { responseStallPolicy }),
    ...(parent.attemptProgress === undefined ? {} : { attemptProgress: parent.attemptProgress }),
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
  return runOwnedRpcRequestContext(input, activeRpcRequestContext().attemptProgress, fn);
}

function runOwnedRpcRequestContext<T>(
  input: RpcRequestContextInput,
  attemptProgress: RpcAttemptProgress | undefined,
  fn: () => T,
): T {
  const parent = activeRpcRequestContext();
  const admissionPriority = input.admissionPriority ?? parent.admissionPriority;
  return rpcRequestContext.run({
    requestClass: input.requestClass ?? parent.requestClass,
    ...(admissionPriority === undefined ? {} : { admissionPriority }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    // Owned physical/background work cannot keep a first waiter's observer.
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    // Shared owners must explicitly choose their own response policy; never
    // inherit a first waiter's endpoint controller or physical deadline.
    ...(input.responseStallPolicy === undefined ? {} : { responseStallPolicy: input.responseStallPolicy }),
    ...(attemptProgress === undefined ? {} : { attemptProgress }),
  }, fn);
}

/**
 * Run adapter-owned shared work outside every caller's request policy: no
 * inherited priority, cancellation, observer, attempt accounting or usage
 * attribution. A request that serves several callers at once has none of
 * theirs; each of them waits for it under its own.
 */
export function withDetachedRpcRequestContext<T>(requestClass: RpcRequestClass, fn: () => T): T {
  return rpcRequestContext.run({ requestClass }, () => withRpcUsageIssuerContext({}, fn));
}

/**
 * Bind `fn` to the request policy and usage attribution active right now, for
 * work its caller issues but another async context runs later on its behalf.
 */
export function bindActiveRpcRequestScope<T>(fn: () => T): () => T {
  const request = activeRpcRequestContext();
  const usage = captureRpcUsageIssuerContext();
  return () => rpcRequestContext.run(request, () => withRpcUsageIssuerContext(usage, fn));
}

export function activeRpcRequestAbortSignal(): AbortSignal | undefined {
  return activeRpcRequestContext().signal;
}

/** Normalize caller/deadline cancellation consistently at every transport gate. */
export function throwRpcRequestAbortReason(signal: AbortSignal): never {
  throw rpcRequestAbortReason(signal);
}

/** Native deadline errors and ethers response timeouts end a stalled endpoint. */
export function isRpcRequestTimeout(error: unknown): boolean {
  return ['RPC_TIMEOUT', 'TIMEOUT', 'TIMEOUT_ERROR'].includes(errorCode(error));
}

/**
 * Run an entire provider attempt inside a cancellable deadline. The signal is
 * visible both to governor admission and to the concrete HTTP transport, while
 * the explicit race keeps the caller's timeout prompt even if third-party code
 * is temporarily between cancellable stages (for example in retry backoff).
 *
 * A deadline that expires while the attempt's request still waits for local
 * governor admission, with nothing sent yet, says nothing about the endpoint:
 * it rejects with the local-capacity code instead of a timeout, so failover
 * neither blames this endpoint nor queues again behind the same governor.
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
  const enclosing = activeRpcRequestContext().attemptProgress;
  const progress: RpcAttemptProgress = {
    waitingForAdmission: 0,
    dispatched: 0,
    ...(enclosing === undefined ? {} : { enclosing }),
  };
  const timer = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  timer.unref?.();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (
        timeoutController.signal.aborted
        && progress.dispatched === 0
        && progress.waitingForAdmission > 0
      ) {
        reject(createRpcAdmissionTimeoutError(
          `${label} waited ${timeoutMs}ms for local RPC admission and was not sent`,
          { cause: timeoutError },
        ));
        return;
      }
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
    const attempt = Promise.resolve(runOwnedRpcRequestContext({
      signal,
      onProgress: activeRpcRequestContext().onProgress,
    }, progress, fn));
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
    const response = await chainRpcFetch(request.url, {
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
  /** Provider-owned chain-ID response cap; discovery/validation share no caller owner. */
  readonly discoveryStallTimeoutMs?: number;
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
  const progress = activeRpcRequestContext().attemptProgress;
  if (transport.admission !== undefined) {
    noteAttemptProgress(progress, (attempt) => { attempt.waitingForAdmission += 1; });
    const waitStartedAt = performance.now();
    try {
      for (const _method of methods) await transport.admission.acquireActiveRequest();
      // Observation only: a refused or cancelled wait is not an admitted attempt.
      recordRpcAdmissionWait(activeRpcRequestContext().requestClass, performance.now() - waitStartedAt);
    } finally {
      noteAttemptProgress(progress, (attempt) => { attempt.waitingForAdmission -= 1; });
    }
  }
  noteAttemptProgress(progress, (attempt) => { attempt.dispatched += 1; });
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
    // Observation only: time the endpoint round trip separately from the local
    // admission wait above so a slow answer is never mistaken for a throttled one.
    const requestClass = activeRpcRequestContext().requestClass;
    const responsePolicy = activeRpcRequestContext().responseStallPolicy
      ?? (methods.length === 1 && methods[0] === 'eth_chainId'
        && config.discoveryStallTimeoutMs !== undefined
        ? { timeoutMs: config.discoveryStallTimeoutMs } : undefined);
    const callerSignal = activeRpcRequestAbortSignal();
    const sentAt = performance.now();
    let answered = false;
    try {
      const fetchResponse = () => cancellableRpcGetUrl(attemptRequest, signal);
      const response = responsePolicy === undefined
        ? await fetchResponse()
        : await withRpcRequestTimeout(responsePolicy.timeoutMs, 'RPC response', fetchResponse);
      answered = response.statusCode >= 200 && response.statusCode < 300;
      return response;
    } catch (error) {
      if (!callerSignal?.aborted && isRpcRequestTimeout(error) && error instanceof Error) {
        responsePolicy?.onTimeout?.(error);
      }
      throw error;
    } finally {
      recordRpcEndpointLatency(requestClass, performance.now() - sentAt, answered);
    }
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
  readonly #discoveryAbortController = new AbortController();
  readonly #pendingRequestContexts: Array<{
    readonly request: RpcRequestContext;
    readonly usage: RpcUsageIssuerContext;
  }> = [];

  constructor(
    request: FetchRequest,
    network: Networkish | undefined,
    options: JsonRpcApiProviderOptions | undefined,
    private readonly discoveryStallTimeoutMs?: number,
  ) {
    super(request, network, options);
  }

  override destroy(): void {
    try {
      // Mark ethers destroyed before cancellation resumes its discovery loop.
      super.destroy();
    } finally {
      this.#discoveryAbortController.abort();
    }
  }

  override _detectNetwork(): Promise<Network> {
    // Network discovery belongs to the provider lifecycle. It can be triggered
    // synchronously by the first caller's `_start()`, but must not inherit that
    // caller's deadline or consumer label and leave the shared provider
    // retrying forever inside an already-aborted context (or billing a shared
    // `eth_chainId` probe to that caller). Its own signal retires admission,
    // HTTP, and retry backoff when the provider is destroyed.
    return rpcRequestContext.run(
      {
        requestClass: 'foreground', signal: this.#discoveryAbortController.signal,
        ...(this.discoveryStallTimeoutMs === undefined ? {} : {
          responseStallPolicy: { timeoutMs: this.discoveryStallTimeoutMs },
        }),
      },
      () => withRpcUsageIssuerContext({}, () => super._detectNetwork()),
    );
  }

  override async getNetwork(): Promise<Network> {
    // Check before starting shared discovery; cancellation belongs to this
    // waiter while the provider continues to own the shared physical request.
    const signal = activeRpcRequestAbortSignal();
    if (signal?.aborted) throwRpcRequestAbortReason(signal);
    return waitForActiveRpcRequest(super.getNetwork());
  }

  override async send(
    method: string,
    params: Array<unknown> | Record<string, unknown>,
  ): Promise<unknown> {
    const pending = {
      request: activeRpcRequestContext(),
      usage: captureRpcUsageIssuerContext(),
    };
    // JsonRpcProvider.send performs this same lazy start before delegating. Do
    // it first so bootstrap network detection cannot consume a user payload's
    // queued context, then delegate the complete request lifecycle unchanged.
    await this._start();
    this.#pendingRequestContexts.push(pending);
    try {
      const result = await super.send(method, params);
      if (!pending.request.signal?.aborted) {
        try { pending.request.onProgress?.(); } catch { /* observer cannot change RPC outcome */ }
      }
      return result;
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
    return rpcRequestContext.run(
      pending.request,
      () => withRpcUsageIssuerContext(pending.usage, () => super._send(payload)),
    );
  }
}

/** The canonical provider factory for tracked adapters and untracked probes. */
export function createRpcRequestProvider(
  url: string,
  config: RpcRequestProviderConfig,
): JsonRpcProvider {
  if (config.discoveryStallTimeoutMs !== undefined
    && (!Number.isFinite(config.discoveryStallTimeoutMs) || config.discoveryStallTimeoutMs <= 0)) {
    throw new RangeError('Discovery response deadline must be positive and finite');
  }
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
    config.discoveryStallTimeoutMs,
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
