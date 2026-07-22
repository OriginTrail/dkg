// Package-internal transport core shared by one-shot and scoped finalized reads.
import {
  assertCanonicalChainId,
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';

import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import {
  snapshotCurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmChainAdapterV1,
} from './current-finalized-evm-call.js';
import {
  type StrictCurrentFinalizedEvmReadCallV1,
  type StrictCurrentFinalizedEvmReadRequestV1,
  type StrictCurrentFinalizedEvmReadResultV1,
  type StrictCurrentFinalizedEvmReadV1,
} from './current-finalized-evm-read-model.js';
import {
  snapshotDenseDataArray,
} from './strict-local-data.js';
import { snapshotCurrentFinalizedEvmReadRequestV1 } from './current-finalized-evm-read-validation.js';
import { createNonqueueingAdmissionGateV1 } from './nonqueueing-admission.js';
import { executeStrictFinalizedEvmBatchV1 } from './strict-current-finalized-evm-batch-executor.js';

export const CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1 = Object.freeze([
  'eip1898',
  'trusted-block-number-hash-sandwich',
] as const);

export type CurrentFinalizedEvmBlockReferenceProfileV1 =
  (typeof CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1)[number];

export type {
  StrictCurrentFinalizedEvmReadCallV1,
  StrictCurrentFinalizedEvmReadRequestV1,
  StrictCurrentFinalizedEvmReadResultV1,
  StrictCurrentFinalizedEvmReadV1,
} from './current-finalized-evm-read-model.js';

export interface StrictCurrentFinalizedEvmRpcConfigV1 {
  /** Canonical decimal chain ID permanently bound to this adapter. */
  readonly chainId: ChainIdV1;
  /** Trusted local configuration, in canonical failover order. */
  readonly endpoints: readonly string[];
  /**
   * EIP-1898 is the default. The number/hash sandwich is an explicit trusted
   * chain profile for deployments whose RPC endpoints cannot execute EIP-1898.
   */
  readonly blockReferenceProfile?: CurrentFinalizedEvmBlockReferenceProfileV1;
}

export interface StrictRpcConfigSnapshotV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
}

export interface FinalizedAnchorV1 {
  readonly blockNumber: BlockNumberV1;
  readonly blockNumberQuantity: string;
  readonly blockHash: Digest32V1;
}

export interface DeadlineScope {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly close: () => void;
}

export interface StrictFinalizedEndpointRunnerProfileV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly maxConcurrentPerChain: number;
  readonly totalDeadlineMs: number;
  readonly attemptTimeoutMs: number;
  readonly chainMismatchMessage: (requestedChainId: ChainIdV1) => string;
  readonly cancelledBeforeAdmissionMessage: string;
  readonly cancelledMessage: string;
  readonly totalDeadlineLabel: string;
  readonly totalDeadlineMessage: (timeoutMs: number) => string;
  readonly attemptDeadlineLabel: (attempt: number) => string;
  readonly attemptDeadlineMessage: (timeoutMs: number) => string;
  readonly attemptFailureMessage: string;
  readonly noEndpointMessage: string;
  readonly saturatedMessage: (active: number) => string;
}

export interface StrictFinalizedEndpointRunInputV1<AttemptResult, Result> {
  readonly chainId: ChainIdV1;
  readonly signal: AbortSignal;
  readonly attempt: (
    endpoint: string,
    attempt: number,
    deadline: DeadlineScope,
  ) => Promise<AttemptResult>;
  /** Runs once, outside the retry catch. Snapshot consumers are never replayed. */
  readonly accept: (
    endpoint: string,
    attemptResult: AttemptResult,
    totalDeadline: DeadlineScope,
  ) => Promise<Result>;
}

export interface StrictFinalizedEndpointRunnerV1 {
  <AttemptResult, Result>(
    input: StrictFinalizedEndpointRunInputV1<AttemptResult, Result>,
  ): Promise<Result>;
}

interface RpcErrorEnvelopeV1 {
  readonly code: number;
  readonly message: string;
  readonly data?: string;
}

const CONFIG_REQUIRED_KEYS = Object.freeze(['chainId', 'endpoints'] as const);
const CONFIG_OPTIONAL_KEYS = Object.freeze(['blockReferenceProfile'] as const);
const CANONICAL_LOWER_HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;
const CANONICAL_LOWER_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const CANONICAL_DIGEST_32 = /^0x[0-9a-f]{64}$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U256 =
  115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n;
const ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1 = new WeakSet<object>();
const AUTHENTICATED_REVERT_DATA_V1 = new WeakMap<CurrentFinalizedEvmCallErrorV1, string>();
const PRE_DEADLINE_TERMINAL_FAILURES_V1 = new WeakSet<CurrentFinalizedEvmCallErrorV1>();

/** Package-internal evidence available only for errors minted by this transport. */
export function readStrictCurrentFinalizedEvmRevertDataV1(error: unknown): string | undefined {
  return error instanceof CurrentFinalizedEvmCallErrorV1
    ? AUTHENTICATED_REVERT_DATA_V1.get(error)
    : undefined;
}

/**
 * Build one strict raw-JSON-RPC adapter from trusted local chain configuration.
 *
 * This transport intentionally bypasses JsonRpcProvider, RpcFailoverClient,
 * and generic timeout wrappers: native fetch gives this lane a streamed
 * pre-parse body cap and an AbortSignal that cancels the actual HTTP I/O. POST
 * requests are never retried, redirected, reordered, or made sticky.
 */
export function createStrictCurrentFinalizedEvmChainAdapterV1(
  input: StrictCurrentFinalizedEvmRpcConfigV1,
): CurrentFinalizedEvmChainAdapterV1 {
  const read = createStrictCurrentFinalizedEvmReadV1(input);

  const adapter: CurrentFinalizedEvmChainAdapterV1 = async (inputRequest) => {
    const request = snapshotCurrentFinalizedEvmCallRequestV1(inputRequest);
    const result = await read({
      chainId: request.chainId,
      calls: Object.freeze([Object.freeze({
        to: request.to,
        data: request.data,
        maxReturnBytes: request.maxReturnBytes,
      })]),
      signal: request.signal,
    });
    const returnData = result.returnData[0];
    if (returnData === undefined) {
      throw unavailable('Single-call finalized read produced no contract result');
    }
    return Object.freeze({
      chainId: result.chainId,
      blockNumber: result.blockNumber,
      blockHash: result.blockHash,
      returnData,
    });
  };

  return Object.freeze(adapter);
}

/**
 * Build a bounded, non-queueing same-finalized-anchor read primitive.
 *
 * Calls, destinations, and configured endpoints are trusted local runtime
 * inputs. The primitive still snapshots them strictly, fixes gas/deadline/body
 * caps, and never accepts a block selector from its caller.
 */
export function createStrictCurrentFinalizedEvmReadV1(
  input: StrictCurrentFinalizedEvmRpcConfigV1,
): StrictCurrentFinalizedEvmReadV1 {
  const config = snapshotConfig(input);
  const runEndpoint = createStrictFinalizedEndpointRunnerV1({
    chainId: config.chainId,
    endpoints: config.endpoints,
    maxConcurrentPerChain: CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
    totalDeadlineMs: CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
    attemptTimeoutMs: CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
    chainMismatchMessage: (requested) =>
      `Adapter is configured for chain ${config.chainId}, not ${requested}`,
    cancelledBeforeAdmissionMessage:
      'Current-finalized EVM call was cancelled before transport admission',
    cancelledMessage: 'Current-finalized EVM call was cancelled',
    totalDeadlineLabel: 'current-finalized total deadline',
    totalDeadlineMessage: (timeoutMs) =>
      `Current-finalized total deadline exceeded ${timeoutMs}ms`,
    attemptDeadlineLabel: (attempt) => `current-finalized endpoint attempt ${attempt}`,
    attemptDeadlineMessage: (timeoutMs) =>
      `Current-finalized endpoint attempt exceeded ${timeoutMs}ms`,
    attemptFailureMessage: 'Current-finalized endpoint attempt failed closed',
    noEndpointMessage: 'No configured current-finalized endpoint succeeded',
    saturatedMessage: (active) =>
      `Chain ${config.chainId} already has ${active} finalized reads in flight`,
  });

  const read: StrictCurrentFinalizedEvmReadV1 = async (inputRequest) => {
    const request = snapshotCurrentFinalizedEvmReadRequestV1(inputRequest);
    return runEndpoint({
      chainId: request.chainId,
      signal: request.signal,
      attempt: (endpoint, _attempt, deadline) =>
        executeEndpointAttempt(config, endpoint, request, deadline),
      accept: async (_endpoint, result) => result,
    });
  };

  return Object.freeze(read);
}

/**
 * Canonical non-queueing endpoint lifecycle shared by one-shot reads and
 * snapshot preflight. Only `attempt` participates in failover; `accept` runs
 * once after the attempt deadline is closed and therefore cannot replay a
 * snapshot consumer.
 */
export function createStrictFinalizedEndpointRunnerV1(
  profile: StrictFinalizedEndpointRunnerProfileV1,
): StrictFinalizedEndpointRunnerV1 {
  const admission = createNonqueueingAdmissionGateV1<ChainIdV1>(
    profile.maxConcurrentPerChain,
  );
  const run: StrictFinalizedEndpointRunnerV1 = async <AttemptResult, Result>(
    input: StrictFinalizedEndpointRunInputV1<AttemptResult, Result>,
  ): Promise<Result> => {
    if (input.chainId !== profile.chainId) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'chain-mismatch',
        profile.chainMismatchMessage(input.chainId),
      );
    }
    if (input.signal.aborted) {
      throw cancelled(profile.cancelledBeforeAdmissionMessage);
    }
    return admission.run(input.chainId, async () => {
      const totalDeadline = createDeadlineScope(
        input.signal,
        profile.totalDeadlineMs,
        profile.totalDeadlineLabel,
      );
      let lastRetryableFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
      try {
        for (let index = 0; index < profile.endpoints.length; index += 1) {
          const attemptNumber = index + 1;
          const attemptDeadline = createDeadlineScope(
            totalDeadline.signal,
            profile.attemptTimeoutMs,
            profile.attemptDeadlineLabel(attemptNumber),
          );
          let attemptResult!: AttemptResult;
          let accepted = false;
          try {
            attemptResult = await input.attempt(
              profile.endpoints[index]!,
              attemptNumber,
              attemptDeadline,
            );
            if (
              input.signal.aborted
              || totalDeadline.timedOut()
              || attemptDeadline.timedOut()
            ) {
              throw classifyEndpointAttemptFailureV1(
                new Error('Endpoint attempt completed after its lifecycle ended'),
                input.signal,
                totalDeadline,
                attemptDeadline,
                profile,
              );
            }
            accepted = true;
          } catch (cause) {
            const failure = classifyEndpointAttemptFailureV1(
              cause,
              input.signal,
              totalDeadline,
              attemptDeadline,
              profile,
            );
            if (isTerminalAttemptFailure(failure)) throw failure;
            lastRetryableFailure = failure;
          } finally {
            attemptDeadline.close();
          }
          if (accepted) {
            return input.accept(
              profile.endpoints[index]!,
              attemptResult,
              totalDeadline,
            );
          }
        }
        throw classifyEndpointAttemptFailureV1(
          lastRetryableFailure ?? unavailable(profile.noEndpointMessage),
          input.signal,
          totalDeadline,
          null,
          profile,
        );
      } finally {
        totalDeadline.close();
      }
    }, (active) => new CurrentFinalizedEvmCallErrorV1(
      'concurrency-saturated',
      profile.saturatedMessage(active),
    ));
  };
  return Object.freeze(run);
}

function classifyEndpointAttemptFailureV1(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScope,
  attemptDeadline: DeadlineScope | null,
  profile: StrictFinalizedEndpointRunnerProfileV1,
): CurrentFinalizedEvmCallErrorV1 {
  if (callerSignal.aborted) return cancelled(profile.cancelledMessage);
  if (
    cause instanceof CurrentFinalizedEvmCallErrorV1
    && PRE_DEADLINE_TERMINAL_FAILURES_V1.has(cause)
  ) {
    return cause;
  }
  if (totalDeadline.timedOut()) {
    return timedOut(profile.totalDeadlineMessage(profile.totalDeadlineMs));
  }
  if (attemptDeadline?.timedOut()) {
    return timedOut(profile.attemptDeadlineMessage(profile.attemptTimeoutMs));
  }
  if (cause instanceof CurrentFinalizedEvmCallErrorV1) return cause;
  return unavailable(profile.attemptFailureMessage, cause);
}

async function executeEndpointAttempt(
  config: StrictRpcConfigSnapshotV1,
  endpoint: string,
  request: StrictCurrentFinalizedEvmReadRequestV1,
  attemptDeadline: DeadlineScope,
): Promise<StrictCurrentFinalizedEvmReadResultV1> {
  const { signal } = attemptDeadline;
  let requestId = 0;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestId += 1;
    return postJsonRpc(
      endpoint,
      requestId,
      method,
      params,
      CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
      signal,
    );
  };

  const remoteChainId = parseChainId(await rpc('eth_chainId', Object.freeze([])));
  if (remoteChainId !== config.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Configured endpoint attempt reported chain ${remoteChainId}, expected ${config.chainId}`,
    );
  }

  const anchor = parseFinalizedAnchor(
    await rpc('eth_getBlockByNumber', Object.freeze(['finalized', false])),
    'current finalized header',
  );
  const executeCallsAt = async (blockReference: unknown): Promise<readonly string[]> => {
    const batch = await executeStrictFinalizedEvmBatchV1({
      calls: request.calls,
      blockReference,
      rpc,
      settle: (operations) => settleParallelBatch(operations, attemptDeadline),
    });
    return batch.returnData;
  };

  const returnData = await executeStrictFinalizedAnchorPolicyV1({
    blockReferenceProfile: config.blockReferenceProfile,
    anchor,
    executeAtReference: executeCallsAt,
    readPostAnchor: async () => parseFinalizedAnchor(
      await rpc('eth_getBlockByNumber', Object.freeze([anchor.blockNumberQuantity, false])),
      'post-call numbered header',
    ),
    anchorMismatchMessage:
      'Block-number fallback hash sandwich did not preserve the resolved finalized anchor',
  });

  return Object.freeze({
    chainId: config.chainId,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    returnData,
  });
}

/** Inputs for the shared EIP-1898 or authenticated-numbered-anchor policy. */
export interface StrictFinalizedAnchorPolicyOptionsV1<T> {
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
  readonly anchor: FinalizedAnchorV1;
  readonly executeAtReference: (blockReference: unknown) => Promise<T>;
  readonly readPostAnchor: () => Promise<FinalizedAnchorV1>;
  readonly anchorMismatchMessage: string;
}

/** Canonical EIP-1898 / authenticated-numbered-anchor execution policy. */
export async function executeStrictFinalizedAnchorPolicyV1<T>(
  options: StrictFinalizedAnchorPolicyOptionsV1<T>,
): Promise<T> {
  if (options.blockReferenceProfile === 'eip1898') {
    return options.executeAtReference(Object.freeze({
      blockHash: options.anchor.blockHash,
      requireCanonical: true as const,
    }));
  }

  // Number-selected evidence is not deterministic until the same endpoint
  // closes the hash sandwich. Delay every anchor-dependent invalidity until
  // that proof succeeds so neither callers nor caches can observe false state.
  let provisionalExecution:
    | Readonly<{ readonly ok: true; readonly value: T }>
    | Readonly<{ readonly ok: false; readonly failure: CurrentFinalizedEvmCallErrorV1 }>;
  try {
    provisionalExecution = Object.freeze({
      ok: true,
      value: await options.executeAtReference(options.anchor.blockNumberQuantity),
    });
  } catch (cause) {
    if (
      cause instanceof CurrentFinalizedEvmCallErrorV1
      && (
        cause.code === 'no-code'
        || cause.code === 'revert'
        || cause.code === 'malformed-return'
        || isAnchorDependentResourceLimit(cause)
      )
    ) {
      provisionalExecution = Object.freeze({ ok: false, failure: cause });
    } else {
      throw cause;
    }
  }
  await assertStrictFinalizedAnchorStableV1(
    options.anchor,
    options.readPostAnchor,
    options.anchorMismatchMessage,
  );
  if (!provisionalExecution.ok) throw provisionalExecution.failure;
  return provisionalExecution.value;
}

export async function assertStrictFinalizedAnchorStableV1(
  anchor: FinalizedAnchorV1,
  readPostAnchor: () => Promise<FinalizedAnchorV1>,
  mismatchMessage: string,
): Promise<void> {
  const postAnchor = await readPostAnchor();
  if (
    postAnchor.blockNumber !== anchor.blockNumber
    || postAnchor.blockHash !== anchor.blockHash
  ) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      mismatchMessage,
    );
  }
}

/**
 * Execute one bounded phase concurrently but retain the permit until every
 * started operation settles. This prevents an early rejection from leaving a
 * sibling fetch alive after the finalized-read concurrency slot is released.
 */
export async function settleParallelBatch<T>(
  operations: readonly Promise<T>[],
  attemptDeadline: DeadlineScope,
): Promise<readonly T[]> {
  let firstFailure: unknown;
  let hasFailure = false;
  let firstPreDeadlineTerminalFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
  const tracked = operations.map(async (operation) => {
    try {
      return await operation;
    } catch (cause) {
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = cause;
      }
      if (
        firstPreDeadlineTerminalFailure === undefined
        && cause instanceof CurrentFinalizedEvmCallErrorV1
        && isTerminalAttemptFailure(cause)
        && !attemptDeadline.timedOut()
      ) {
        firstPreDeadlineTerminalFailure = cause;
        PRE_DEADLINE_TERMINAL_FAILURES_V1.add(cause);
      }
      throw cause;
    }
  });
  const settled = await Promise.allSettled(tracked);
  if (firstPreDeadlineTerminalFailure !== undefined) {
    throw firstPreDeadlineTerminalFailure;
  }
  if (hasFailure) throw firstFailure;
  const values: T[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]!;
    if (result.status === 'rejected') {
      throw unavailable('Parallel finalized-read operation failed without a recorded cause');
    }
    values.push(result.value);
  }
  return Object.freeze(values);
}

export async function postJsonRpc(
  endpoint: string,
  id: number,
  method: string,
  params: readonly unknown[],
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: Object.freeze({
        accept: 'application/json',
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw unavailable(`JSON-RPC ${method} transport failed`, cause);
  }

  const body = await readResponseBodyBounded(response, maxResponseBytes);
  if (!response.ok) {
    // An HTTP intermediary/provider failure is transport availability, even if
    // its untrusted body happens to mimic a deterministic JSON-RPC revert. Only
    // a successful JSON-RPC transport response may select an invalidity code.
    throw unavailable(`JSON-RPC ${method} returned HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (cause) {
    throw unavailable(`JSON-RPC ${method} returned malformed JSON`, cause);
  }
  if (!isPlainRecord(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== id) {
    throw unavailable(`JSON-RPC ${method} returned a mismatched response envelope`);
  }
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(parsed, 'error');
  if (hasResult === hasError) {
    throw unavailable(`JSON-RPC ${method} response must contain exactly one of result or error`);
  }
  if (hasError) {
    const error = parseRpcError(parsed.error);
    if (error === undefined) throw unavailable(`JSON-RPC ${method} returned a malformed error`);
    throw classifyJsonRpcError(method, error);
  }
  return parsed.result;
}

async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declared = BigInt(contentLength);
    if (declared > BigInt(maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw resourceLimited(
        `Raw JSON-RPC response declared ${declared.toString()} bytes, limit ${maxBytes}`,
      );
    }
  }

  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw resourceLimited(`Raw JSON-RPC response exceeded ${maxBytes} bytes before parsing`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw unavailable('JSON-RPC response body is not valid UTF-8', cause);
  }
}

export function parseChainId(input: unknown): ChainIdV1 {
  let parsed: bigint;
  try {
    parsed = parseCanonicalQuantity(input, MAX_U256);
  } catch (cause) {
    throw unavailable('eth_chainId returned a malformed chain ID', cause);
  }
  return parsed.toString(10) as ChainIdV1;
}

export function parseFinalizedAnchor(input: unknown, label: string): FinalizedAnchorV1 {
  if (input === null) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} is unavailable`,
    );
  }
  if (!isPlainRecord(input)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} is malformed`,
    );
  }

  let blockNumber: bigint;
  try {
    blockNumber = parseCanonicalQuantity(input.number, MAX_U64);
  } catch (cause) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} has a malformed block number`,
      { cause },
    );
  }
  if (typeof input.hash !== 'string' || !CANONICAL_DIGEST_32.test(input.hash)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} has a malformed block hash`,
    );
  }
  return Object.freeze({
    blockNumber: blockNumber.toString(10) as BlockNumberV1,
    blockNumberQuantity: input.number as string,
    blockHash: input.hash as Digest32V1,
  });
}

function parseCanonicalQuantity(input: unknown, maximum: bigint): bigint {
  if (typeof input !== 'string' || !CANONICAL_LOWER_QUANTITY.test(input)) {
    throw new Error('not a canonical lowercase JSON-RPC quantity');
  }
  const parsed = BigInt(input);
  if (parsed > maximum) throw new Error('JSON-RPC quantity is out of range');
  return parsed;
}

function parseRpcError(input: unknown): RpcErrorEnvelopeV1 | undefined {
  if (
    !isPlainRecord(input)
    || typeof input.code !== 'number'
    || !Number.isSafeInteger(input.code)
    || typeof input.message !== 'string'
  ) {
    return undefined;
  }
  const data = typeof input.data === 'string'
    && CANONICAL_LOWER_HEX_BYTES.test(input.data)
    ? input.data
    : undefined;
  return Object.freeze({
    code: input.code,
    message: input.message,
    ...(data === undefined ? {} : { data }),
  });
}

function classifyJsonRpcError(
  method: string,
  error: RpcErrorEnvelopeV1,
): CurrentFinalizedEvmCallErrorV1 {
  const message = error.message.toLowerCase();
  // Explicit revert evidence is deterministic even when a gateway decorates
  // the message with gas-related text (for example, code 3 plus
  // "execution reverted: out of gas"). A fixed-cap exhaustion that did not
  // execute a REVERT remains a resource refusal below, but a proven REVERT
  // must win so callers cannot misclassify invalid execution evidence as merely
  // unsupported.
  if (method === 'eth_call' && (error.code === 3 || message.includes('revert'))) {
    return revertedAtFinalizedAnchor(error.data);
  }
  if (
    method === 'eth_call'
    && (
      message.includes('out of gas')
      || message.includes('gas limit')
      || message.includes('gas required')
      || message.includes('exceeds allowance')
      || message.includes('intrinsic gas')
    )
  ) {
    return anchorDependentResourceLimited(
      'Finalized contract execution could not complete within the fixed gas cap',
    );
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return timedOut(`JSON-RPC ${method} timed out`);
  }
  if (
    method === 'eth_getBlockByNumber'
    || message.includes('header not found')
    || message.includes('unknown block')
    || message.includes('block not found')
    || message.includes('canonical')
  ) {
    return new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `JSON-RPC ${method} could not prove the required finalized anchor`,
    );
  }
  return unavailable(`JSON-RPC ${method} failed with code ${error.code}`);
}

export function isTerminalAttemptFailure(error: CurrentFinalizedEvmCallErrorV1): boolean {
  return error.code === 'unsupported-chain'
    || error.code === 'resource-limit'
    || error.code === 'revert'
    || error.code === 'no-code'
    || error.code === 'malformed-return';
}

export function createDeadlineScope(
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
): DeadlineScope {
  const controller = new AbortController();
  let didTimeOut = false;
  const expiresAt = performance.now() + timeoutMs;
  const parentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) parentAbort();
  else parent.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(`${label} exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => didTimeOut || performance.now() >= expiresAt,
    close: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', parentAbort);
    },
  });
}

export function snapshotConfig(input: StrictCurrentFinalizedEvmRpcConfigV1): StrictRpcConfigSnapshotV1 {
  if (!isPlainRecord(input)) {
    throw new TypeError('Strict current-finalized RPC config must be a plain data record');
  }
  assertConfigDataProperties(input);
  try {
    assertCanonicalChainId(input.chainId, 'strict current-finalized chainId');
  } catch {
    throw new TypeError('Strict current-finalized chainId must be canonical decimal u256');
  }

  const endpoints = snapshotNormalizedEndpoints(input.endpoints);
  const blockReferenceProfile = input.blockReferenceProfile ?? 'eip1898';
  if (!CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1.includes(blockReferenceProfile)) {
    throw new TypeError('Unsupported strict current-finalized block reference profile');
  }
  return Object.freeze({
    chainId: input.chainId,
    endpoints,
    blockReferenceProfile,
  });
}

function assertConfigDataProperties(input: Record<string, unknown>): void {
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Strict current-finalized RPC config cannot contain symbol keys');
  }
  const allowed = new Set<string>([...CONFIG_REQUIRED_KEYS, ...CONFIG_OPTIONAL_KEYS]);
  if (
    !CONFIG_REQUIRED_KEYS.every((key) => keys.includes(key))
    || (keys as string[]).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('Strict current-finalized RPC config has unknown or missing fields');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('Strict current-finalized RPC config fields must be enumerable data properties');
    }
  }
}

function snapshotNormalizedEndpoints(input: unknown): readonly string[] {
  const normalized: string[] = [];
  try {
    const endpoints = snapshotDenseDataArray(input, {
      label: 'Strict current-finalized RPC endpoints',
      minLength: 1,
    });
    for (const entry of endpoints) {
      const endpoint = normalizeEndpoint(entry);
      if (!normalized.includes(endpoint)) normalized.push(endpoint);
    }
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new TypeError('Strict current-finalized endpoints must be a dense data-only array');
  }
  if (normalized.length === 0 || normalized.length > CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1) {
    throw new TypeError(
      `Strict current-finalized RPC requires 1..${CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1} distinct endpoints`,
    );
  }
  return Object.freeze(normalized);
}

function normalizeEndpoint(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('Strict current-finalized RPC endpoint must be a nonempty URL string');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError('Strict current-finalized RPC endpoint must be an absolute URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash !== '') {
    throw new TypeError('Strict current-finalized RPC endpoint must use HTTP(S) without a fragment');
  }
  return url.href;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function unavailable(message: string, cause?: unknown): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1(
    'rpc-unavailable',
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function timedOut(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('rpc-timeout', message);
}

export function resourceLimited(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('resource-limit', message);
}

function anchorDependentResourceLimited(message: string): CurrentFinalizedEvmCallErrorV1 {
  const error = resourceLimited(message);
  ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1.add(error);
  return error;
}

function revertedAtFinalizedAnchor(data?: string): CurrentFinalizedEvmCallErrorV1 {
  const error = new CurrentFinalizedEvmCallErrorV1(
    'revert',
    'Contract call reverted at the resolved finalized anchor',
  );
  if (data !== undefined) AUTHENTICATED_REVERT_DATA_V1.set(error, data);
  return error;
}

export function isAnchorDependentResourceLimit(
  error: CurrentFinalizedEvmCallErrorV1,
): boolean {
  return error.code === 'resource-limit'
    && ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1.has(error);
}

export function cancelled(message: string): CurrentFinalizedEvmCallErrorV1 {
  // Caller intent is authenticated by the verifier-owned AbortSignal. Keep
  // the adapter error retryable so a foreign gateway cannot forge a cancelled
  // disposition merely by throwing a public error code; the verifier observes
  // its caller signal first and maps this exact path to `cancelled`.
  return new CurrentFinalizedEvmCallErrorV1('rpc-unavailable', message);
}
